import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { NotificationService } from '../src/daemon/runtime/notifications.ts';
import { ProactiveService } from '../src/daemon/runtime/proactive.ts';
import { RequestBroker } from '../src/daemon/requests/request-broker.ts';
import type { Envelope } from '../src/daemon/runtime/store.ts';
import type { NotificationAdapter, NotificationDelivery, NotificationEntry } from '../src/sdk/notification-types.ts';
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { resolve, promise }; };
async function fixture(adapter?: NotificationAdapter, options: Record<string, number> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'notification-service-'));
    const path = join(dir, 'runtime.db');
    const factory = async () => ({ async run() {}, async close() {} });
    let runtime = new BotRuntime(path, factory);
    const bot = runtime.createBot('fixture');
    let now = Date.now();
    const nowFn = () => now;
    let service = new NotificationService(runtime, { adapter, now: nowFn, ...options });
    return {
        get runtime() { return runtime; }, get service() { return service; }, bot,
        now: nowFn, time: (n: number) => { now = n; },
        async source(key = 'origin') {
            const e = runtime.accept({ to: bot.id, from: 'alice', fileOwner: 'alice', text: key, key, taskId: key });
            await runtime.idle(); return e;
        },
        enable(quiet?: { startMinute: number; endMinute: number }, timezone = 'UTC') { service.setPreferences('alice', { enabled: true, timezone, quiet }); },
        async restart() { await runtime.close(); runtime = new BotRuntime(path, factory); service = new NotificationService(runtime, { adapter, now: nowFn, ...options }); },
        async close() { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
    };
}
test('host verified result selection deduplicates, is disabled by default and retains original source owner', async () => {
    const sent: NotificationDelivery[] = [];
    const h = await fixture({ id: 'fake', async deliver(n) { sent.push(n); return { status: 'accepted' }; } });
    try {
        const e = await h.source();
        h.runtime.startJob(e, 'fixture', {}, 'job', async () => 'done'); await h.runtime.idle();
        assert.deepEqual(h.service.list('alice'), [], 'a job receipt alone is not a final user result');
        const out = h.runtime.sendMessage(e, 'VERIFIED FINAL', 'final');
        const n = h.service.publishResult(out.id);
        assert.equal(h.service.publishResult(out.id).id, n.id);
        assert.equal(n.status, 'active');
        await h.service.flush(); assert.equal(sent.length, 0);
        h.enable();
        await Promise.all([h.service.flush(), h.service.flush()]);
        assert.equal(sent.length, 1); assert.equal(sent[0].ownerId, 'alice');
        assert.equal(sent[0].sourceMessageId, e.id);
        assert.ok(!JSON.stringify(sent).includes('VERIFIED FINAL'), 'no raw result goes to a lock screen adapter');
        const saved = h.service.list('alice')[0];
        assert.equal(saved.delivery.state, 'accepted'); assert.equal(saved.status, 'active'); assert.equal(saved.readAt, undefined);
        await h.restart(); await h.service.flush(); assert.equal(sent.length, 1);
        assert.equal(h.service.list('alice')[0].delivery.state, 'accepted');
    } finally { await h.close(); }
});
test('read suppresses delivery, does not approve a request, and survives replay/restart', async () => {
    let calls = 0;
    const h = await fixture({ id: 'fake', async deliver() { calls++; return { status: 'accepted' }; } });
    let broker: RequestBroker | undefined;
    try {
        const e = await h.source(); broker = new RequestBroker(h.runtime, new Map());
        const r = broker.create('approval', e, { taskId: e.taskId, tool: 'fixture' }, h.now() + 60000);
        const n = h.service.list('alice')[0];
        h.service.reconcile(); assert.equal(h.service.list('alice').length, 1);
        assert.throws(() => h.service.read('bob', n.id), /Unknown notification/);
        h.service.read('alice', n.id); h.enable(); await h.service.flush();
        assert.equal(calls, 0); assert.equal(broker.list()[0].status, 'pending');
        broker.finish(r, 'resolved', { decision: 'deny' }, 'fixture');
        assert.equal(h.service.read('alice', n.id).status, 'resolved');
        broker.close(); broker = undefined; await h.restart();
        assert.equal(h.service.list('alice')[0].readAt, n.createdAt);
        await h.service.flush(); assert.equal(calls, 0);
    } finally { broker?.close(); await h.close(); }
});
for (const control of ['cancel', 'replace'] as const)
    test(`${control} before retry suppresses old source; replacement creates an independent incarnation`, async () => {
        const ids: string[] = [];
        const h = await fixture({ id: 'fake', async deliver(n) { ids.push(n.id); return { status: 'retry' }; } });
        try {
            const e = await h.source(); const out = h.runtime.sendMessage(e, 'old', 'old'); const n = h.service.publishResult(out.id);
            h.enable(); await h.service.flush();
            const replacement = h.runtime.accept({ to: h.bot.id, from: e.from, fileOwner: 'alice', taskId: e.taskId, key: control, text: control, taskControl: control });
            await h.runtime.idle(); h.time(h.now() + 10000); await h.service.flush();
            assert.equal(ids.length, 1); assert.equal(h.service.list('alice')[0].status, 'superseded');
            assert.throws(() => h.service.publishResult(out.id), /cancelled|superseded/);
            if (control === 'replace') {
                const fresh = h.runtime.sendMessage(replacement, 'new', 'new'); const next = h.service.publishResult(fresh.id);
                assert.notEqual(next.id, n.id); await h.service.flush(); assert.equal(ids[1], next.id);
            }
        } finally { await h.close(); }
    });
test('concurrent drains claim once; cancellation and read during sending preserve late acceptance as a separate fact', async () => {
    const started = deferred<void>(), done = deferred<{ status: 'accepted' }>();
    let calls = 0;
    const adapter: NotificationAdapter = { id: 'held', async deliver() { calls++; started.resolve(); return done.promise; } };
    const h = await fixture(adapter);
    try {
        const e = await h.source(); const out = h.runtime.sendMessage(e, 'final', 'final'); const n = h.service.publishResult(out.id); h.enable();
        const flush = h.service.flush(); await started.promise;
        const other = new NotificationService(h.runtime, { adapter, now: h.now });
        await other.flush(); assert.equal(calls, 1);
        h.service.read('alice', n.id);
        h.runtime.accept({ to: h.bot.id, from: e.from, fileOwner: 'alice', taskId: e.taskId, key: 'cancel', text: 'cancel', taskControl: 'cancel' });
        done.resolve({ status: 'accepted' }); await flush; await h.runtime.idle();
        const saved = h.service.list('alice')[0];
        assert.equal(saved.status, 'superseded'); assert.equal(saved.delivery.state, 'accepted'); assert.equal(saved.readAt, h.now());
        await other.flush(); assert.equal(calls, 1);
    } finally { done.resolve({ status: 'accepted' }); await h.close(); }
});
test('definitive non-acceptance retries finitely using the same idempotency key and persisted delay', async () => {
    const keys: string[] = [];
    const h = await fixture({ id: 'retry-fixture', async deliver(n) { keys.push(n.idempotencyKey); return { status: 'retry', retryAfterMs: 5000 }; } }, { maxAttempts: 2 });
    try {
        const e = await h.source(); const out = h.runtime.sendMessage(e, 'final', 'final'); h.service.publishResult(out.id); h.enable();
        await h.service.flush(); assert.equal(keys.length, 1);
        await h.restart(); await h.service.flush(); assert.equal(keys.length, 1);
        h.time(h.now() + 5000); await h.service.flush(); assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
        h.time(h.now() + 99999); await h.service.flush(); assert.equal(keys.length, 2);
        const n = h.service.list('alice')[0]; assert.equal(n.delivery.state, 'failed'); assert.equal(n.delivery.reason, 'attempt_limit');
    } finally { await h.close(); }
});
for (const mode of ['throw', 'timeout', 'crash'] as const)
    test(`uncertain ${mode} never blindly resends, including after restart and a late adapter result`, async () => {
        let calls = 0; const late = deferred<{ status: 'accepted' }>();
        const h = await fixture({ id: 'uncertain-fixture', async deliver() { calls++; if (mode === 'throw') throw Error('unknown'); return late.promise; } }, { attemptTimeoutMs: 10 });
        try {
            const e = await h.source(); const out = h.runtime.sendMessage(e, 'final', 'final'); const n = h.service.publishResult(out.id); h.enable();
            if (mode === 'crash') h.runtime.store.put('notification_entries', { ...n, delivery: { ...n.delivery, state: 'sending', attemptId: 'orphan', attempts: 1 } });
            else await h.service.flush();
            await h.restart(); assert.equal(h.service.list('alice')[0].delivery.state, 'uncertain');
            late.resolve({ status: 'accepted' }); await new Promise(r => setImmediate(r));
            h.time(h.now() + 9999); await h.service.flush(); assert.equal(calls, mode === 'crash' ? 0 : 1);
            assert.equal(h.service.list('alice')[0].delivery.state, 'uncertain');
        } finally { late.resolve({ status: 'accepted' }); await h.close(); }
    });
test('quiet hours respect timezone/DST, read/expiry suppress deferred entries, preference change rechecks immediately', async () => {
    let calls = 0;
    const h = await fixture({ id: 'fake', async deliver() { calls++; return { status: 'accepted' }; } });
    try {
        h.time(Date.parse('2026-11-01T05:30:00Z')); // First 01:30 during New York fall-back.
        const e = await h.source(); const out = h.runtime.sendMessage(e, 'final', 'final');
        // Model the host result clock at the virtual instant.
        h.runtime.store.put('outbox', { ...out, createdAt: h.now() }); const n = h.service.publishResult(out.id);
        h.enable({ startMinute: 22 * 60, endMinute: 7 * 60 }, 'America/New_York');
        await h.service.flush(); const pending = h.service.list('alice')[0]; assert.equal(pending.delivery.state, 'deferred');
        assert.equal(pending.delivery.nextAttemptAt, Date.parse('2026-11-01T12:00:00Z'));
        h.time(Date.parse('2026-11-01T11:59:00Z')); await h.service.flush(); assert.equal(calls, 0);
        h.enable(); await h.service.flush(); assert.equal(calls, 1);
        const out2 = h.runtime.sendMessage(e, 'second', 'second'); h.runtime.store.put('outbox', { ...out2, createdAt: h.now() }); const n2 = h.service.publishResult(out2.id);
        const out3 = h.runtime.sendMessage(e, 'third', 'third'); h.runtime.store.put('outbox', { ...out3, createdAt: h.now() }); const n3 = h.service.publishResult(out3.id);
        h.enable({ startMinute: 0, endMinute: 23 * 60 }); await h.service.flush(); h.service.read('alice', n2.id);
        h.time(h.now() + 86400000); await h.service.flush(); assert.equal(calls, 1);
        assert.equal(h.service.list('alice').find(v => v.id === n.id)!.delivery.state, 'accepted');
        assert.equal(h.service.list('alice').find(v => v.id === n3.id)!.status, 'expired');
        assert.throws(() => h.service.setPreferences('alice', { enabled: true, timezone: 'Bad/Zone' }), /timezone/);
    } finally { await h.close(); }
});
test('monitor and local research share original inbox/result lifecycle and the same notification exit', async () => {
    const sent: NotificationDelivery[] = [];
    const h = await fixture({ id: 'fake', async deliver(n) { sent.push(n); return { status: 'accepted' }; } });
    let proactive: ProactiveService | undefined;
    try {
        const e = await h.source();
        proactive = new ProactiveService(h.runtime, { now: h.now, detectors: { fixture: async ({ dryRun }) => dryRun ? { decision: 'silent' } : { decision: 'wake', dedupKey: 'change', payload: 'fixture change' } }, workers: { research: { async generate() { return { text: 'fixture finding', evidenceRefs: [e.id] }; }, async review() { return { approved: true, reason: 'fixture evidence' }; } } } });
        const m = proactive.createMonitor(e, { key: 'watch', detector: 'fixture', prompt: 'watch', intervalMs: 1000, deadline: h.now() + 60000 });
        await proactive.dryRunMonitor(e.to, m.id); proactive.enableMonitor(e.to, m.id); await proactive.tick();
        proactive.startBackgroundWork(e, { kind: 'research', key: 'research', evidenceRefs: [e.id] }); await h.runtime.idle();
        assert.deepEqual(h.service.list('alice'), [], 'discovery itself cannot directly notify');
        const discoveries = h.runtime.store.list<Envelope>('inbox').filter(v => ['monitor', 'research'].includes(v.kind));
        assert.equal(discoveries.length, 2);
        for (const discovery of discoveries) {
            const out = h.runtime.sendMessage(discovery, 'host verified finding', discovery.id);
            h.service.publishResult(out.id, 'important_change');
        }
        h.enable(); await h.service.flush(); assert.equal(sent.length, 2);
        assert.deepEqual(new Set(sent.map(v => v.ownerId)), new Set(['alice']));
        assert.equal(h.runtime.store.list('jobs').length, 1, 'notification drain creates no research jobs');
    } finally { await proactive?.close(); await h.close(); }
});

test('host result and notification selection share a rollback boundary without replaying business work', async () => {
    const h = await fixture();
    try {
        const e = await h.source();
        assert.throws(() => h.runtime.store.transaction(() => {
            const out = h.runtime.sendMessage(e, 'verified', 'atomic');
            h.service.publishResult(out.id);
            throw Error('fixture rollback');
        }), /fixture rollback/);
        assert.equal(h.runtime.store.list('outbox').length, 0);
        assert.deepEqual(h.service.list('alice'), []);
        h.runtime.store.transaction(() => {
            const out = h.runtime.sendMessage(e, 'verified', 'atomic');
            h.service.publishResult(out.id);
        });
        await h.restart();
        assert.equal(h.runtime.store.list('outbox').length, 1);
        assert.equal(h.service.list('alice').length, 1);
    } finally { await h.close(); }
});
