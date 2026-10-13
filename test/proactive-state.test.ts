import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BotRuntime } from '../src/daemon/runtime.ts';
import type { Envelope, Outbound, Job } from '../src/daemon/store.ts';
async function fixture(factory: ConstructorParameters<typeof BotRuntime>[1]) {
    const base = resolve('work/proactive-tests');
    await mkdir(base, {
        recursive: true
    });
    const dir = await mkdtemp(join(base, 'state-'));
    const runtime = new BotRuntime(join(dir, 'runtime.db'), factory);
    return {
        runtime, dir, async close() {
            await runtime.close();
            await rm(dir, {
                recursive: true, force: true
            });
        }
    };
}
test('successful checkpoint survives a later refused request; unhandled input stays uncertain', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    const completed = new Set<string>();
    const h = await fixture(async () => ({
        async run(e) {
            completed.add(e.id);
            await gate;
            throw Error('budget refused');
        },
        async enqueue() {
        }, consumed: () => true, resolved: e => completed.has(e.id), async close() {
        }
    }));
    try {
        const bot = h.runtime.createBot('main');
        const first = h.runtime.accept({
            to: bot.id, text: 'done', key: 'first'
        });
        await new Promise(r => setImmediate(r));
        const late = h.runtime.accept({
            to: bot.id, text: 'still owed', key: 'late'
        });
        release();
        await h.runtime.idle();
        assert.equal(h.runtime.store.get<Envelope>('inbox', first.id)?.state, 'processed');
        assert.equal(h.runtime.store.get<Envelope>('inbox', late.id)?.state, 'uncertain');
        assert.equal(h.runtime.store.get<Envelope>('inbox', first.id)?.resolvedAt !== undefined, true);
    }
    finally {
        release();
        await h.close();
    }
});
test('late execution cannot overwrite a quarantined job generation', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    const h = await fixture(async () => ({
        async run() {
        }, async close() {
        }
    }));
    try {
        const bot = h.runtime.createBot('main');
        const e = h.runtime.accept({
            to: bot.id, text: 'work', key: 'work'
        });
        await h.runtime.idle();
        const job = h.runtime.startJob(e, 'held', {}, 'execution', async () => {
            await gate;
            return 'old-result';
        });
        h.runtime.store.put('jobs', {
            ...job, state: 'uncertain', generation: 'quarantined-generation'
        });
        release();
        await h.runtime.idle();
        assert.equal(h.runtime.store.get<Job>('jobs', job.id)?.state, 'uncertain');
        assert.equal(h.runtime.store.get<Job>('jobs', job.id)?.result, undefined);
        assert.equal(h.runtime.store.list<Envelope>('inbox').filter(e => e.kind === 'job').length, 0);
    }
    finally {
        release();
        await h.close();
    }
});
test('finite foreground burst admits waiting background at a safe boundary', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    const seen: string[] = [];
    const h = await fixture(async () => ({
        async run(e) {
            seen.push(e.text);
            if (e.text === 'hold')
                await gate;
        }, async close() {
        }
    }));
    try {
        const bot = h.runtime.createBot('main');
        h.runtime.accept({
            to: bot.id, text: 'hold', key: 'hold'
        });
        await new Promise(r => setImmediate(r));
        h.runtime.accept({
            to: bot.id, text: 'background', kind: 'schedule', key: 'bg'
        });
        for (let i = 0; i < 20; i++)
            h.runtime.accept({
                to: bot.id, text: `user-${i}`, key: `u-${i}`
            });
        release();
        await h.runtime.idle();
        assert.ok(seen.indexOf('background') <= 9, 'background must not wait behind every user');
    }
    finally {
        release();
        await h.close();
    }
});
test('uncertain inbox requires explicit evidence; verified delivery resolves without replay', async () => {
    let runs = 0;
    const h = await fixture(async () => ({
        async run() {
            runs++;
            throw Error('refused');
        }, async close() {
        }
    }));
    try {
        const bot = h.runtime.createBot('main');
        const e = h.runtime.accept({
            to: bot.id, text: 'task', key: 'request'
        });
        await h.runtime.idle();
        assert.throws(() => h.runtime.reconcileInbox(e.id, {
            outcome: 'processed', evidence: []
        }), /evidence/i);
        const o = h.runtime.sendMessage(e, 'actual result', 'final');
        assert.throws(() => h.runtime.reconcileInbox(e.id, {
            outcome: 'processed', evidence: [o.id]
        }), /delivered/i);
        await h.runtime.deliver(async () => {
        });
        h.runtime.reconcileInbox(e.id, {
            outcome: 'processed', evidence: [o.id]
        });
        assert.equal(h.runtime.store.get<Envelope>('inbox', e.id)?.state, 'processed');
        assert.equal(runs, 1);
        assert.equal(h.runtime.store.get<Outbound>('outbox', o.id)?.deliveredAt !== undefined, true);
    }
    finally {
        await h.close();
    }
});
test('background waits for safe admission; peer urgency stays below user', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    const seen: string[] = [];
    const h = await fixture(async () => ({
        async run(e) {
            seen.push(e.text);
            if (e.text === 'hold')
                await gate;
        }, async close() {
        }
    }));
    try {
        const bot = h.runtime.createBot('main');
        h.runtime.accept({
            to: bot.id, text: 'hold', key: 'hold'
        });
        await new Promise(r => setImmediate(r));
        h.runtime.accept({
            to: bot.id, text: 'background', kind: 'schedule', from: 'schedule:trusted', key: 'bg'
        });
        h.runtime.accept({
            to: bot.id, text: 'peer', kind: 'bot', peerPriority: 'urgent', key: 'peer'
        });
        h.runtime.accept({
            to: bot.id, text: 'user', key: 'user'
        });
        release();
        await h.runtime.idle();
        assert.deepEqual(seen, ['hold', 'user', 'peer', 'background']);
    }
    finally {
        release();
        await h.close();
    }
});
test('conversation-scoped cancellation cannot invalidate a sibling conversation task', async () => {
    const h = await fixture(async () => ({
        async run() {
        }, async close() {
        }
    }));
    try {
        const bot = h.runtime.createBot('group', '', 'alpha');
        const route = {
            channelId: 'alpha', conversationId: 'one', threadId: 'thread', senderId: 'alice'
        };
        const a = h.runtime.accept({
            to: bot.id, taskId: 'same-id', text: 'first conversation task', key: 'one', route
        });
        const b = h.runtime.accept({
            to: bot.id, taskId: 'same-id', text: 'second conversation task', key: 'two', route: {
                ...route, conversationId: 'two'
            }
        });
        h.runtime.accept({
            to: bot.id, taskId: b.taskId, text: 'cancel second', key: 'cancel-two', route: b.route, taskControl: 'cancel'
        });
        await h.runtime.idle();
        assert.doesNotThrow(() => h.runtime.sendMessage(a, 'first result remains valid', 'result-one'));
        assert.throws(() => h.runtime.sendMessage(b, 'second stale result', 'result-two'), /cancelled/i);
        const legacy = h.runtime.accept({
            to: bot.id, taskId: 'legacy', text: 'implicit conversation', key: 'legacy', route: {
                channelId: 'alpha', threadId: 'legacy', senderId: 'alice'
            }
        });
        h.runtime.accept({
            to: bot.id, taskId: 'legacy', text: 'cancel implicit conversation', key: 'cancel-legacy', route: {
                ...legacy.route!, conversationId: 'alpha'
            }, taskControl: 'cancel'
        });
        await h.runtime.idle();
        assert.throws(() => h.runtime.sendMessage(legacy, 'legacy stale result', 'legacy-result'), /cancelled/i);
    }
    finally {
        await h.close();
    }
});
