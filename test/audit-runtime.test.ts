import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotRuntime, type SessionFactory } from '../src/runtime.ts';
import { Store, type Envelope, type Job, type Outbound } from '../src/store.ts';
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => resolve = r);
    return {
        promise, resolve
    };
};
const until = async (f: () => boolean) => {
    const end = Date.now() + 3000;
    while (!f()) {
        if (Date.now() > end)
            throw Error('timed out');
        await new Promise(r => setTimeout(r, 5));
    }
};
async function fixture(factory: SessionFactory = async () => ({
    async run() {
    }, async close() {
    }
})) {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bot-audit-'));
    const path = join(dir, 'bot.db');
    const runtime = new BotRuntime(path, factory);
    return {
        dir, path, runtime, async close() {
            await runtime.close();
            await rm(dir, {
                recursive: true, force: true
            });
        }
    };
}
test('audit: bot lanes serialize, user arrival never aborts, other bots progress independently', async () => {
    const gate = deferred();
    const seen: string[] = [];
    let active = 0, max = 0;
    const h = await fixture(async (bot) => ({
        async run(e) {
            seen.push(`${bot.name}:${e.text}`);
            active++;
            max = Math.max(max, active);
            if (e.text === 'first')
                await gate.promise;
            active--;
        }, async close() {
        }
    }));
    try {
        const a = h.runtime.createBot('a'), b = h.runtime.createBot('b');
        h.runtime.accept({
            to: a.id, key: '1', text: 'first'
        });
        await until(() => seen.length === 1);
        h.runtime.accept({
            to: a.id, key: '2', text: 'second'
        });
        h.runtime.accept({
            to: b.id, key: '3', text: 'independent'
        });
        await until(() => seen.includes('b:independent'));
        assert.deepEqual(seen, ['a:first', 'b:independent']);
        assert.equal(max, 2);
        gate.resolve();
        await h.runtime.idle();
        assert.deepEqual(seen, ['a:first', 'b:independent', 'a:second']);
    }
    finally {
        gate.resolve();
        await h.close();
    }
});
test('audit: inbox dedupe is durable and identity/session pointer persists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bot-restart-'));
    const path = join(dir, 'bot.db');
    let calls = 0;
    const factory: SessionFactory = async () => ({
        async run() {
            calls++;
        }, async close() {
        }
    });
    let r = new BotRuntime(path, factory);
    try {
        const bot = r.createBot('same name');
        const e = r.accept({
            to: bot.id, key: 'request', text: 'once'
        });
        assert.equal(r.accept({
            to: bot.id, key: 'request', text: 'once'
        }).id, e.id);
        await r.idle();
        r.store.put('bots', {
            ...bot, sessionFile: '/stable/session.jsonl'
        });
        await r.close();
        r = new BotRuntime(path, factory);
        const restored = r.listBots()[0];
        assert.equal(restored.id, bot.id);
        assert.equal(restored.sessionFile, '/stable/session.jsonl');
        assert.equal(r.accept({
            to: bot.id, key: 'request', text: 'once'
        }).state, 'processed');
        await r.idle();
        assert.equal(calls, 1);
        assert.throws(() => r.accept({
            to: bot.id, key: 'request', text: 'changed'
        }), /conflict/);
    }
    finally {
        await r.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('audit: crash recovery quarantines uncertain execution and delivery while queued survives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bot-crash-'));
    const path = join(dir, 'bot.db');
    const store = new Store(path);
    const bot = store.createBot('bot');
    const base: Envelope = {
        id: 'processing', from: 'user', to: bot.id, kind: 'user', text: 'unsafe', taskId: 'task', replyTo: null, hop: 0, key: '1', state: 'processing', createdAt: 1
    };
    store.put('inbox', base);
    store.put('inbox', {
        ...base, id: 'queued', key: '2', text: 'safe queued', state: 'queued'
    });
    store.put('jobs', {
        id: 'job', botId: bot.id, taskId: 'task', messageId: base.id, key: 'job', tool: 'side_effect', args: {}, state: 'running', createdAt: 1
    } satisfies Job);
    store.put('outbox', {
        id: 'out', botId: bot.id, taskId: 'task', replyTo: null, key: 'out', text: 'maybe sent', state: 'sending', createdAt: 1
    } satisfies Outbound);
    store.close();
    const seen: string[] = [];
    const r = new BotRuntime(path, async () => ({
        async run(e) {
            seen.push(e.id);
        }, async close() {
        }
    }));
    try {
        r.start();
        await r.idle();
        assert.deepEqual(seen, ['queued']);
        assert.equal(r.store.get<Envelope>('inbox', 'processing')?.state, 'uncertain');
        assert.equal(r.store.get<Job>('jobs', 'job')?.state, 'uncertain');
        assert.equal(r.store.get<Outbound>('outbox', 'out')?.state, 'uncertain');
        let sends = 0;
        await r.deliver(async () => {
            sends++;
        });
        assert.equal(sends, 0);
    }
    finally {
        await r.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('audit: concurrent outbox drains do not repeat external delivery', async () => {
    const h = await fixture();
    const gate = deferred();
    try {
        const b = h.runtime.createBot('bot');
        const e = h.runtime.accept({
            to: b.id, key: 'input', text: 'go'
        });
        await h.runtime.idle();
        const one = h.runtime.sendMessage(e, 'one', 'one'), two = h.runtime.sendMessage(e, 'two', 'two');
        assert.equal(one.state, 'pending');
        const sent: string[] = [];
        const sink = async (o: Outbound) => {
            sent.push(o.id);
            if (o.id === one.id)
                await gate.promise;
        };
        const first = h.runtime.deliver(sink);
        await until(() => sent.includes(one.id));
        const second = h.runtime.deliver(sink);
        await new Promise(r => setTimeout(r, 10));
        gate.resolve();
        await Promise.all([first, second]);
        assert.equal(sent.filter(id => id === two.id).length, 1);
        assert.equal(sent.filter(id => id === one.id).length, 1);
        assert.equal(h.runtime.store.get<Outbound>('outbox', one.id)?.state, 'delivered');
    }
    finally {
        gate.resolve();
        await h.close();
    }
});
test('audit: questions enforce idempotency and owner answer is consumed once', async () => {
    const h = await fixture();
    try {
        const b = h.runtime.createBot('bot');
        const e = h.runtime.accept({
            to: b.id, key: 'input', text: 'go'
        });
        await h.runtime.idle();
        const q = h.runtime.askUser(e, 'Choose A or B?', 'question');
        assert.equal(h.runtime.askUser(e, 'Choose A or B?', 'question').id, q.id);
        assert.throws(() => h.runtime.askUser(e, 'Different question', 'question'), /conflict/);
        h.runtime.answer(q.id, 'A', 'answer');
        h.runtime.answer(q.id, 'A', 'answer');
        await h.runtime.idle();
        assert.equal(h.runtime.store.list<Envelope>('inbox').filter(x => x.kind === 'answer').length, 1);
        assert.throws(() => h.runtime.answer(q.id, 'B', 'different'), /answered/);
    }
    finally {
        await h.close();
    }
});
test('audit: jobs retain large outcomes outside bounded per-owner retrieval', async () => {
    const h = await fixture();
    try {
        const b = h.runtime.createBot('bot'), other = h.runtime.createBot('other');
        const e = h.runtime.accept({
            to: b.id, key: 'input', text: 'go'
        });
        await h.runtime.idle();
        let executed = 0;
        const execute = async () => {
            executed++;
            return {
                text: 'X'.repeat(120000)
            };
        };
        const j = h.runtime.startJob(e, 'large', {}, 'job', execute);
        assert.equal(h.runtime.startJob(e, 'large', {}, 'job', execute).id, j.id);
        await h.runtime.idle();
        assert.equal(executed, 1);
        assert.ok(h.runtime.store.get<Job>('jobs', j.id)!.result!.length > 120000);
        assert.ok(h.runtime.jobResult(b.id, j.id, 0, 100000).text!.length <= 8000);
        assert.throws(() => h.runtime.jobResult(other.id, j.id), /Unknown/);
        const notice = h.runtime.store.list<Envelope>('inbox').find(x => x.kind === 'job');
        assert.ok(notice && notice.text.length < 3000);
        assert.equal(h.runtime.store.get<Job>('jobs', j.id)?.state, 'completed');
    }
    finally {
        await h.close();
    }
});
test('audit: second runtime cannot recover or consume a database owned by live host', async () => {
    const h = await fixture();
    try {
        assert.throws(() => new BotRuntime(h.path, async () => ({
            async run() {
            }, async close() {
            }
        })), /owned|lock|active/i);
    }
    finally {
        await h.close();
    }
});
test('audit: failed external delivery remains uncertain and is never replayed automatically', async () => {
    const h = await fixture();
    try {
        const b = h.runtime.createBot('bot');
        const e = h.runtime.accept({
            to: b.id, key: 'input', text: 'go'
        });
        await h.runtime.idle();
        const o = h.runtime.sendMessage(e, 'might be delivered', 'out');
        let sends = 0;
        await assert.rejects(h.runtime.deliver(async () => {
            sends++;
            throw Error('connection lost after remote acceptance');
        }));
        assert.equal(h.runtime.store.get<Outbound>('outbox', o.id)?.state, 'uncertain');
        await h.runtime.deliver(async () => {
            sends++;
        });
        assert.equal(sends, 1);
    }
    finally {
        await h.close();
    }
});
test('audit: default bot, queued inbox, hop and task-message caps reject overflow', async () => {
    const h = await fixture();
    try {
        const bots = Array.from({
            length: 16
        }, (_, i) => h.runtime.createBot(`bot-${i}`));
        assert.throws(() => h.runtime.createBot('overflow'), /Bot capacity/);
        for (let i = 0; i < 100; i++)
            h.runtime.accept({
                to: bots[0]!.id, text: 'queued', key: `queued-${i}`
            });
        assert.throws(() => h.runtime.accept({
            to: bots[0]!.id, text: 'overflow', key: 'queue-overflow'
        }), /Inbox capacity/);
        const e = h.runtime.accept({
            to: bots[1]!.id, text: 'hop limit', key: 'hop-8', hop: 8
        });
        assert.throws(() => h.runtime.sendToBot(e, bots[2]!.id, 'hop 9', 'hop-9'), /hop budget/);
        for (let i = 0; i < 32; i++)
            h.runtime.accept({
                from: bots[1]!.id, to: bots[2]!.id, kind: 'bot', text: 'bounded', taskId: 'bounded-task', key: `task-${i}`
            });
        assert.throws(() => h.runtime.accept({
            from: bots[1]!.id, to: bots[2]!.id, kind: 'bot', text: 'overflow', taskId: 'bounded-task', key: 'task-overflow'
        }), /Task message budget/);
    }
    finally {
        await h.close();
    }
});
test('audit: default job caps bound concurrent execution and total jobs per task', async () => {
    const h = await fixture();
    const gate = deferred();
    try {
        const bot = h.runtime.createBot('bot');
        const e = h.runtime.accept({
            to: bot.id, key: 'input', text: 'run'
        });
        await h.runtime.idle();
        for (let i = 0; i < 8; i++)
            h.runtime.startJob(e, 'safe', {}, `active-${i}`, async () => {
                await gate.promise;
                return 'done';
            });
        assert.throws(() => h.runtime.startJob(e, 'safe', {}, 'active-overflow', async () => 'bad'), /Concurrent job budget/);
        gate.resolve();
        await h.runtime.idle();
        for (let i = 8; i < 32; i++) {
            h.runtime.startJob(e, 'safe', {}, `total-${i}`, async () => 'done');
            await h.runtime.idle();
        }
        assert.throws(() => h.runtime.startJob(e, 'safe', {}, 'task-overflow', async () => 'bad'), /Task job budget/);
        assert.equal(h.runtime.store.list<Job>('jobs').length, 32);
    }
    finally {
        gate.resolve();
        await h.close();
    }
});
test('audit: outbox cap is per task and pending question cap is per bot', async () => {
    const h = await fixture();
    try {
        const bot = h.runtime.createBot('bot');
        const e = h.runtime.accept({
            to: bot.id, key: 'input', text: 'send'
        });
        await h.runtime.idle();
        for (let i = 0; i < 64; i++)
            h.runtime.sendMessage(e, 'bounded', `out-${i}`);
        assert.throws(() => h.runtime.sendMessage(e, 'overflow', 'out-overflow'), /Task outbox budget/);
        assert.equal(h.runtime.sendMessage(e, 'bounded', 'out-0').state, 'pending');
        const qEvent = h.runtime.accept({
            to: bot.id, key: 'question-input', text: 'ask'
        });
        await h.runtime.idle();
        const questions = Array.from({
            length: 16
        }, (_, i) => h.runtime.askUser(qEvent, `Question ${i}?`, `q-${i}`));
        assert.throws(() => h.runtime.askUser(qEvent, 'overflow?', 'q-overflow'), /Pending question capacity/);
        assert.equal(h.runtime.askUser(qEvent, 'Question 0?', 'q-0').id, questions[0]!.id);
        h.runtime.answer(questions[0]!.id, 'answered', 'answer');
        h.runtime.askUser(qEvent, 'replacement?', 'q-replacement');
        assert.throws(() => h.runtime.askUser(qEvent, 'overflow again?', 'q-overflow-again'), /Pending question capacity/);
    }
    finally {
        await h.close();
    }
});
