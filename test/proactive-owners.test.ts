import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotRuntime, type SessionFactory } from '../src/daemon/runtime/runtime.ts';
import { ProactiveService, type BackgroundWorker, type Detector } from '../src/daemon/runtime/proactive.ts';
import type { Bot, Envelope, Monitor, Schedule } from '../src/pi/types.ts';
import type { Thread } from '../src/sdk/protocol/models.ts';

function gate() { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; }
const worker: BackgroundWorker = {
    async generate(evidence) { return { text: 'Fixture owner finding', evidenceRefs: evidence.map(e => e.id) }; },
    async review() { return { approved: true, reason: 'Fixture review' }; }
};
async function fixture(options: { worker?: BackgroundWorker; detector?: Detector } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'proactive-owners-'));
    const path = join(dir, 'runtime.db');
    const seen: Envelope[] = [];
    const factory: SessionFactory = async () => ({ async run(e) { seen.push(e); }, async close() {} });
    let runtime = new BotRuntime(path, factory), now = 1000;
    const primary = runtime.createBot('first bot', '', 'primary-channel');
    const owner = runtime.createBot('actual owner', '', 'owner-channel');
    const source = runtime.accept({ to: owner.id, text: 'Owned fixture evidence', key: 'source', fileOwner: 'alice', route: {
        channelId: 'owner-channel', conversationId: 'owner-conversation', threadId: 'owner-thread', senderId: 'alice'
    } });
    await runtime.idle();
    const serviceOptions = { now: () => now, workers: { research: options.worker ?? worker }, detectors: {
        fixture: options.detector ?? (async ({ dryRun }) => dryRun ? { decision: 'silent' as const } : { decision: 'wake' as const, dedupKey: 'changed', payload: 'Owned condition changed' })
    } };
    let service = new ProactiveService(runtime, serviceOptions);
    return {
        primary, owner, source, seen, get runtime() { return runtime; }, get service() { return service; },
        time(value: number) { now = value; },
        async monitor() { const m = service.createMonitor(source, { key: 'monitor', detector: 'fixture', prompt: 'Watch owned condition', intervalMs: 1000, deadline: 10000 }); await service.dryRunMonitor(owner.id, m.id); service.enableMonitor(owner.id, m.id); return m; },
        dream() { return service.createDream(source, { key: 'dream', at: 2000, intervalMs: 1000, deadline: 10000, maxRuns: 2, evidenceRefs: [source.id] }); },
        archive(status: Thread['status']) { const t = runtime.store.ensureThread(source); runtime.store.put('threads', { ...t, status }); return t; },
        async restart() { await service.close(); await runtime.close(); runtime = new BotRuntime(path, factory); service = new ProactiveService(runtime, serviceOptions); },
        async close() { await service.close(); await runtime.close(); await rm(dir, { recursive: true, force: true }); }
    };
}

test('monitor and dream stay with their originating bot rather than the first bot', async () => {
    const h = await fixture();
    try {
        const m = await h.monitor(), d = h.dream();
        assert.throws(() => h.service.cancelMonitor(h.primary.id, m.id), /owner/i);
        assert.throws(() => h.service.cancelSchedule(h.primary.id, d.id), /owner/i);
        h.time(2000); await h.service.tick(); await h.runtime.idle();
        const findings = h.seen.filter(e => ['monitor', 'research'].includes(e.kind));
        assert.equal(findings.length, 2);
        for (const e of findings) { assert.equal(e.to, h.owner.id); assert.deepEqual(e.route, h.source.route); }
        assert.equal(h.seen.filter(e => e.to === h.primary.id).length, 0);
        assert.equal(h.service.listSchedules(h.owner.id)[0].botId, h.owner.id);
        assert.equal(h.service.listMonitors(h.owner.id)[0].botId, h.owner.id);
        h.service.cancelMonitor(h.owner.id, m.id); h.service.cancelSchedule(h.owner.id, d.id);
        assert.equal(h.runtime.store.get<Monitor>('monitors', m.id)!.state, 'cancelled');
        assert.equal(h.runtime.store.get<Schedule>('schedules', d.id)!.state, 'cancelled');
    }
    finally { await h.close(); }
});

test('forged or unregistered temporary sources cannot acquire durable trigger ownership', async () => {
    const h = await fixture();
    try {
        const monitor = (source: Envelope) => h.service.createMonitor(source, { key: 'forged-monitor', detector: 'fixture', prompt: 'watch', intervalMs: 1000, deadline: 10000 });
        const dream = (source: Envelope) => h.service.createDream(source, { key: 'forged-dream', at: 2000, deadline: 10000, maxRuns: 1, evidenceRefs: [h.source.id] });
        for (const fake of [{ ...h.source, to: h.primary.id }, { ...h.source, id: 'unregistered-temporary-input' }]) {
            assert.throws(() => monitor(fake)); assert.throws(() => dream(fake));
        }
        const temporary = { ...h.source, id: 'temporary-source', key: 'temporary-source', to: 'unregistered-temporary-bot' };
        h.runtime.store.put('inbox', temporary);
        assert.throws(() => monitor(temporary)); assert.throws(() => dream(temporary));
        assert.equal(h.runtime.store.list('monitors').length, 0);
        assert.equal(h.runtime.store.list('schedules').length, 0);
    }
    finally { await h.close(); }
});

test('archiving owner during monitor observation suspends persistently and requires explicit resume', async () => {
    const held = gate(), entered = gate();
    const h = await fixture({ detector: async ({ dryRun }) => {
        if (dryRun) return { decision: 'silent' };
        entered.release(); await held.promise;
        return { decision: 'wake', dedupKey: 'owned', payload: 'Late owner observation' };
    } });
    try {
        const m = await h.monitor();
        const ticking = h.service.tick(); await entered.promise;
        h.archive('archived'); held.release(); await ticking;
        const suspended = h.runtime.store.get<Monitor>('monitors', m.id)!;
        assert.equal(suspended.suspension?.reason, 'owner_archived'); assert.equal(suspended.enabled, false);
        assert.ok(suspended.revision > m.revision);
        assert.equal(h.service.listFires(h.owner.id).length, 0);
        await assert.rejects(async () => h.service.resumeMonitor(h.owner.id, m.id));
        await h.restart(); h.archive('stored');
        await h.service.tick(); await h.runtime.idle();
        assert.equal(h.runtime.store.get<Monitor>('monitors', m.id)!.enabled, false);
        assert.equal(h.service.listFires(h.owner.id).length, 0);
        h.service.resumeMonitor(h.owner.id, m.id);
        assert.equal(h.runtime.store.get<Monitor>('monitors', m.id)!.suspension, undefined);
        await h.service.tick(); await h.runtime.idle();
        assert.equal(h.seen.filter(e => e.kind === 'monitor').length, 1);
        assert.equal(h.seen.find(e => e.kind === 'monitor')!.to, h.owner.id);
    }
    finally { held.release(); await h.close(); }
});

test('archiving owner during dream generation blocks review; persistent suspension resumes only on original bot', async () => {
    const held = gate(), entered = gate(); let reviews = 0;
    const h = await fixture({ worker: {
        async generate(evidence, signal) { entered.release(); await held.promise; return worker.generate(evidence, signal); },
        async review(candidate, evidence, signal) { reviews++; return worker.review(candidate, evidence, signal); }
    } });
    try {
        const d = h.dream(); h.time(2000); await h.service.tick(); await entered.promise;
        h.archive('archived'); await h.service.tick();
        held.release(); await h.runtime.idle();
        const paused = h.runtime.store.get<Schedule>('schedules', d.id)!;
        assert.equal(paused.state, 'paused'); assert.equal(paused.suspension?.reason, 'owner_archived');
        assert.equal(reviews, 0); assert.equal(h.seen.filter(e => e.kind === 'research').length, 0);
        assert.throws(() => h.service.resumeSchedule(h.owner.id, d.id));
        await h.restart(); h.archive('stored'); h.time(3000);
        await h.service.tick(); assert.equal(h.runtime.store.list('jobs').length, 1);
        assert.throws(() => h.service.resumeSchedule(h.primary.id, d.id), /owner/i);
        h.service.resumeSchedule(h.owner.id, d.id);
        await h.service.tick(); await h.runtime.idle();
        assert.equal(reviews, 1); assert.equal(h.seen.filter(e => e.kind === 'research').length, 1);
        assert.equal(h.seen.find(e => e.kind === 'research')!.to, h.owner.id);
        assert.equal(h.runtime.store.get<Schedule>('schedules', d.id)!.suspension, undefined);
    }
    finally { held.release(); await h.close(); }
});

for (const missing of ['owner_missing', 'source_missing', 'owner_route_changed'] as const) {
    test(`${missing} suspends both producers without migration, and original bot may still cancel`, async () => {
        const h = await fixture();
        try {
            const m = await h.monitor(), d = h.dream();
            if (missing === 'owner_missing') h.runtime.store.db.prepare('DELETE FROM bots WHERE id=?').run(h.owner.id);
            else if (missing === 'source_missing') h.runtime.store.db.prepare('DELETE FROM inbox WHERE id=?').run(h.source.id);
            else h.runtime.store.put('bots', { ...h.owner, channelId: 'changed-owner-channel' } satisfies Bot);
            h.time(2000); await h.service.tick();
            const monitor = h.runtime.store.get<Monitor>('monitors', m.id)!, dream = h.runtime.store.get<Schedule>('schedules', d.id)!;
            assert.equal(monitor.enabled, false); assert.equal(monitor.suspension?.reason, missing);
            assert.equal(dream.state, 'paused'); assert.equal(dream.suspension?.reason, missing);
            assert.equal(h.service.listFires(h.owner.id).length, 0);
            await h.restart();
            assert.equal(h.runtime.store.get<Monitor>('monitors', m.id)!.suspension?.reason, missing);
            assert.equal(h.runtime.store.get<Schedule>('schedules', d.id)!.suspension?.reason, missing);
            assert.throws(() => h.service.resumeMonitor(h.owner.id, m.id));
            assert.throws(() => h.service.resumeSchedule(h.owner.id, d.id));
            assert.throws(() => h.service.cancelMonitor(h.primary.id, m.id), /owner/i);
            assert.throws(() => h.service.cancelSchedule(h.primary.id, d.id), /owner/i);
            h.service.cancelMonitor(h.owner.id, m.id); h.service.cancelSchedule(h.owner.id, d.id);
            assert.equal(h.runtime.store.get<Monitor>('monitors', m.id)!.state, 'cancelled');
            assert.equal(h.runtime.store.get<Schedule>('schedules', d.id)!.state, 'cancelled');
            assert.equal(h.seen.filter(e => e.to === h.primary.id).length, 0);
        }
        finally { await h.close(); }
    });
}

test('owner suspension never reopens an already completed ordinary one-shot schedule', async () => {
    const h = await fixture();
    try {
        const schedule = h.service.createSchedule(h.source, { key: 'one-shot', prompt: 'once', at: 1000, timezone: 'UTC' });
        await h.service.tick(); await h.runtime.idle();
        assert.equal(h.runtime.store.get<Schedule>('schedules', schedule.id)!.state, 'completed');
        await h.monitor(); h.archive('archived'); await h.service.tick();
        assert.equal(h.runtime.store.get<Schedule>('schedules', schedule.id)!.state, 'completed');
        h.archive('stored');
        assert.throws(() => h.service.resumeSchedule(h.owner.id, schedule.id), /completed/);
        await h.service.tick(); await h.runtime.idle();
        assert.equal(h.service.listFires(h.owner.id).filter(f => f.triggerId === schedule.id).length, 1);
    } finally { await h.close(); }
});

test('a suspended last in-flight dream retains its spent budget instead of gaining a replacement run', async () => {
    const held = gate(), entered = gate(); let generations = 0;
    const h = await fixture({ worker: {
        async generate(evidence, signal) { generations++; entered.release(); await held.promise; return worker.generate(evidence, signal); },
        review: worker.review
    } });
    try {
        const d = h.service.createDream(h.source, { key: 'last-slot', at: 2000, deadline: 10000, maxRuns: 1, evidenceRefs: [h.source.id] });
        h.time(2000); await h.service.tick(); await entered.promise;
        h.archive('archived'); held.release(); await h.runtime.idle();
        const paused = h.runtime.store.get<Schedule>('schedules', d.id)!;
        assert.equal(paused.state, 'paused'); assert.equal(paused.suspension?.reason, 'owner_archived');
        assert.equal(paused.dream!.runs, 1);
        h.archive('stored');
        assert.throws(() => h.service.resumeSchedule(h.owner.id, d.id), /budget exhausted/);
        h.time(3000); await h.service.tick(); await h.runtime.idle();
        assert.equal(generations, 1); assert.equal(h.runtime.store.list('jobs').length, 1);
        assert.equal(h.seen.filter(e => e.kind === 'research').length, 0);
        h.service.cancelSchedule(h.owner.id, d.id);
    } finally { held.release(); await h.close(); }
});
