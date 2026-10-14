import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotRuntime, type SessionFactory } from '../src/daemon/runtime/runtime.ts';
import { RequestBroker } from '../src/daemon/requests/request-broker.ts';
import { CredentialBroker } from '../src/daemon/runtime/credentials.ts';
import type { Envelope, Question } from '../src/daemon/runtime/store.ts';
import type { PendingRequest } from '../src/sdk/protocol/models.ts';
async function until(check: () => boolean) {
    const end = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > end) throw Error('timed out');
        await new Promise(r => setTimeout(r, 5));
    }
}
async function fixture(factory: SessionFactory) {
    const dir = await mkdtemp(join(tmpdir(), 'pi-nonblocking-'));
    const path = join(dir, 'runtime.db');
    const runtime = new BotRuntime(path, factory);
    const broker = new RequestBroker(runtime, new Map());
    (runtime as any).requestBroker = broker;
    runtime.approvals = { request: input => broker.approval(input) };
    return { dir, path, runtime, broker, async close() {
        broker.close(); await runtime.close(); await rm(dir, { recursive: true, force: true });
    } };
}
test('pending question releases same bot lane; restart and duplicate reply resume only scoped A once', async () => {
    const seen: Envelope[] = [];
    const factory: SessionFactory = async (_bot, host) => ({ async run(e) {
        seen.push(e);
        if (e.text === 'A') host.askUser(e, 'Fixture choice?', 'question:' + e.id);
    }, async close() {} });
    const h = await fixture(factory);
    let resumed: BotRuntime | undefined, resumedBroker: RequestBroker | undefined;
    try {
        const bot = h.runtime.createBot('fixture');
        const a = h.runtime.accept({ to: bot.id, text: 'A', key: 'A' });
        await h.runtime.idle();
        const q = h.runtime.store.list<Question>('questions')[0]!;
        h.runtime.accept({ to: bot.id, text: 'B', key: 'B' });
        await h.runtime.idle();
        assert.deepEqual(seen.map(e => e.text), ['A', 'B']);
        assert.equal(q.state, 'pending');
        h.broker.close(); await h.runtime.close();
        resumed = new BotRuntime(h.path, factory);
        resumedBroker = new RequestBroker(resumed, new Map());
        const id = 'req_question:' + q.id;
        resumedBroker.resolve(id, { text: 'fixture answer' }, 'fixture');
        resumedBroker.resolve(id, { text: 'fixture answer' }, 'fixture');
        assert.throws(() => resumedBroker!.resolve(id, { text: 'different' }, 'fixture'), /differently/);
        await resumed.idle();
        const answers = seen.filter(e => e.kind === 'answer');
        assert.equal(answers.length, 1);
        assert.equal(answers[0]!.taskId, a.taskId);
        assert.equal(answers[0]!.replyTo, a.id);
        const cancelled = resumed.accept({ to: bot.id, text: 'A', key: 'cancel-A' });
        await resumed.idle();
        const pending = resumed.store.list<Question>('questions').find(q => q.messageId === cancelled.id)!;
        resumed.store.put('inbox', { ...resumed.store.get<Envelope>('inbox', cancelled.id)!, triggerCancelled: true });
        assert.throws(() => resumed!.answer(pending.id, 'late', 'late'), /cancelled/);
    } finally {
        resumedBroker?.close();
        if (resumed) { await resumed.close(); await rm(h.dir, { recursive: true, force: true }); }
        else await h.close();
    }
});
test('approval pauses only background A; B progresses; late approval works after A source processed; denial/cancel/restart never execute', async () => {
    let broker: RequestBroker;
    let effects = 0;
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    const h = await fixture(async (_bot, host) => ({ async run(e) {
        seen.push(e.text);
        if (e.text === 'B') return;
        host.startJob(e, 'fixture-effect', {}, e.id, async () => {
            await gate;
            if (!await broker.approval({ botId: e.to, taskId: e.taskId, tool: 'nested-fixture', args: {} })) return 'denied';
            host.assertTaskCurrent(e);
            effects++; return 'completed';
        }, { quiet: true });
    }, async close() {} }));
    broker = h.broker;
    try {
        const bot = h.runtime.createBot('fixture');
        const start = async (key: string) => {
            const e = h.runtime.accept({ to: bot.id, text: key, key });
            await until(() => broker.list().some(r => r.params.taskId === e.taskId && r.status === 'pending'));
            return { e, request: broker.list().find(r => r.params.taskId === e.taskId && r.status === 'pending')! };
        };
        const a = await start('A');
        h.runtime.accept({ to: bot.id, text: 'B', key: 'B' });
        await until(() => seen.includes('B'));
        assert.equal(effects, 0);
        broker.resolve(a.request.id, { decision: 'approve' }, 'fixture');
        release();
        await until(() => broker.list().filter(r => r.params.taskId === a.e.taskId).length === 2);
        assert.equal(h.runtime.store.get<Envelope>('inbox', a.e.id)!.state, 'processed');
        const nested = broker.list().find(r => r.params.tool === 'nested-fixture')!;
        broker.resolve(nested.id, { decision: 'approve' }, 'fixture');
        broker.resolve(nested.id, { decision: 'approve' }, 'fixture');
        await h.runtime.idle(); assert.equal(effects, 1);
        const denied = await start('deny');
        broker.resolve(denied.request.id, { decision: 'deny' }, 'fixture');
        await h.runtime.idle(); assert.equal(effects, 1);
        const cancelled = await start('cancel');
        h.runtime.store.put('inbox', { ...h.runtime.store.get<Envelope>('inbox', cancelled.e.id)!, triggerCancelled: true });
        assert.throws(() => broker.resolve(cancelled.request.id, { decision: 'approve' }, 'fixture'), /cancelled/);
        broker.sweep(); await h.runtime.idle();
        assert.throws(() => broker.resolve(cancelled.request.id, { decision: 'approve' }, 'fixture'), /no longer pending/);
        const shutdown = await start('restart');
        broker.close(); await h.runtime.idle();
        assert.equal(effects, 1);
        assert.equal(broker.list().find(r => r.id === shutdown.request.id)!.status, 'cancelled');
        const orphan: PendingRequest = { ...shutdown.request, id: 'orphan-fixture', status: 'pending' };
        h.runtime.store.put('requests', orphan);
        const recovered = new RequestBroker(h.runtime, new Map());
        assert.equal(recovered.list().find(r => r.id === orphan.id)!.status, 'cancelled');
        assert.throws(() => recovered.resolve(orphan.id, { decision: 'approve' }, 'fixture'), /no longer pending/);
        recovered.close();
    } finally { release(); await h.close(); }
});
test('pending secure form releases lane; validation/retry/cancel and failed use never serialize dummy input', async () => {
    const dummy = 'DUMMY-NONBLOCKING-NOT-A-CREDENTIAL';
    const captures: unknown[] = [];
    let form: ReturnType<CredentialBroker['request']>;
    let credentials: CredentialBroker;
    const seen: string[] = [];
    const h = await fixture(async (_bot, _host) => ({ async run(e) {
        seen.push(e.text);
        if (e.text === 'A') form = credentials.request({ botId: e.to, taskId: e.taskId, tool: 'fixture' }, 'Dummy input');
    }, async close() {} }));
    credentials = new CredentialBroker(Date.now, { created: value => captures.push(value), submitted: (id, scope) => captures.push({ id, scope, submitted: true }) });
    try {
        const bot = h.runtime.createBot('fixture');
        h.runtime.accept({ to: bot.id, text: 'A', key: 'A' }); await h.runtime.idle();
        h.runtime.accept({ to: bot.id, text: 'B', key: 'B' }); await h.runtime.idle();
        assert.deepEqual(seen, ['A', 'B']);
        assert.throws(() => credentials.submit(form!.requestId, form!.scope, ''), /Invalid credential/);
        assert.throws(() => credentials.submit(form!.requestId, { ...form!.scope, taskId: 'wrong' }, dummy), /unavailable/);
        const receipt = credentials.submit(form!.requestId, form!.scope, dummy);
        assert.throws(() => credentials.submit(form!.requestId, form!.scope, dummy), /unavailable/);
        captures.push(await credentials.use(receipt.reference, form!.scope, async value => { throw Error(value); }));
        const cancelled = credentials.request(form!.scope, 'Cancelled fixture'); credentials.revoke(cancelled.requestId);
        assert.throws(() => credentials.submit(cancelled.requestId, cancelled.scope, dummy), /unavailable/);
        for (const table of ['inbox', 'outbox', 'requests', 'jobs', 'questions']) captures.push(h.runtime.store.list(table));
        assert.ok(!JSON.stringify([captures, credentials]).includes(dummy));
    } finally { credentials.close(); await h.close(); }
});
