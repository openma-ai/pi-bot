import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { ProactiveService, type BackgroundWorker } from '../src/daemon/runtime/proactive.ts';
import type { Envelope, Proposal, Schedule } from '../src/pi/types.ts';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>(r => release = r);
    return { promise, release };
}
const approved: BackgroundWorker = {
    async generate(evidence) { return { text: 'Fixture evidence synthesis', evidenceRefs: evidence.map(e => e.id) }; },
    async review() { return { approved: true, reason: 'Fixture independently checked' }; }
};
async function fixture(worker: BackgroundWorker = approved) {
    const dir = await mkdtemp(join(tmpdir(), 'dream-fixture-'));
    const path = join(dir, 'runtime.db');
    const seen: Envelope[] = [];
    const factory = async () => ({ async run(e: Envelope) { seen.push(e); }, async close() {} });
    let runtime = new BotRuntime(path, factory);
    let now = 1000;
    const bot = runtime.createBot('dream fixture');
    const source = runtime.accept({ to: bot.id, text: 'Known local evidence', key: 'source', fileOwner: 'fixture-owner' });
    await runtime.idle();
    let service = new ProactiveService(runtime, { now: () => now, workers: { research: worker } });
    return {
        seen, source, time(value: number) { now = value; },
        get runtime() { return runtime; }, get service() { return service; },
        create(overrides: Partial<Parameters<ProactiveService['createDream']>[1]> = {}) {
            return service.createDream(source, { key: 'dream', at: 2000, intervalMs: 1000, deadline: 10000, maxRuns: 2, evidenceRefs: [source.id], ...overrides });
        },
        async restart(nextWorker?: BackgroundWorker) {
            await service.close();
            await runtime.close();
            runtime = new BotRuntime(path, factory);
            service = new ProactiveService(runtime, { now: () => now, ...(nextWorker ? { workers: { research: nextWorker } } : {}) });
        },
        async close() { await service.close(); await runtime.close(); await rm(dir, { recursive: true, force: true }); }
    };
}

test('dream requires explicit worker and bounded admitted evidence; creation keys cannot alias ordinary schedules', async () => {
    const h = await fixture();
    try {
        const disabled = new ProactiveService(h.runtime);
        assert.throws(() => disabled.createDream(h.source, { key: 'disabled', at: 2000, deadline: Date.now() + 10000, maxRuns: 1, evidenceRefs: [h.source.id] }), /allowlisted/);
        for (const overrides of [{ maxRuns: 0 }, { maxRuns: 9 }, { deadline: 2000 }, { evidenceRefs: ['missing'] }])
            assert.throws(() => h.create(overrides));
        const s = h.create();
        assert.equal(h.create().id, s.id);
        assert.throws(() => h.create({ maxRuns: 3 }), /conflict/);
        assert.throws(() => h.service.createSchedule(h.source, { key: 'dream', prompt: s.prompt, at: 2000, intervalMs: 1000, timezone: 'UTC' }), /conflict/);
        await disabled.close();
    }
    finally { await h.close(); }
});

test('durable dream fires once per slot without waking main Pi for the trigger, and respects maxRuns', async () => {
    const h = await fixture();
    try {
        const s = h.create();
        await h.restart(approved);
        await h.service.tick();
        assert.equal(h.service.listFires(h.source.to).length, 0);
        h.time(2000);
        await Promise.all([h.service.tick(), h.service.tick()]);
        await h.runtime.idle();
        const [fire] = h.service.listFires(h.source.to);
        assert.equal(fire.triggerId, s.id);
        assert.equal(h.runtime.store.get<Envelope>('inbox', fire.inboxId)!.state, 'processed');
        assert.equal(h.seen.filter(e => e.kind === 'schedule').length, 0);
        assert.equal(h.seen.filter(e => e.kind === 'research').length, 1);
        const result = h.seen.find(e => e.kind === 'research')!;
        assert.equal(result.replyTo, fire.inboxId);
        assert.equal(result.taskId, h.source.taskId);
        assert.equal(h.runtime.store.list('outbox').length, 0);
        await h.service.tick();
        assert.equal(h.service.listFires(h.source.to).length, 1);
        await h.restart(approved);
        await h.service.tick();
        assert.equal(h.service.listFires(h.source.to).length, 1);
        h.time(8000); // coalesce missed periods, never burst historical model calls
        await h.service.tick();
        await h.runtime.idle();
        assert.equal(h.service.listFires(h.source.to).length, 2);
        assert.equal(h.service.listSchedules(h.source.to)[0].dream!.runs, 2);
        assert.equal(h.service.listSchedules(h.source.to)[0].state, 'completed');
        h.time(9000);
        await h.service.tick();
        assert.equal(h.runtime.store.list('proposals').length, 2);
    }
    finally { await h.close(); }
});

test('one in-flight dream does not block foreground input or launch overlapping research', async () => {
    const held = gate(), entered = gate();
    let calls = 0;
    const h = await fixture({ ...approved, async generate(evidence) { calls++; entered.release(); await held.promise; return approved.generate(evidence, new AbortController().signal); } });
    try {
        h.create(); h.time(2000);
        await h.service.tick();
        await entered.promise;
        h.time(3000);
        await h.service.tick();
        h.runtime.accept({ to: h.source.to, text: 'foreground still responds', key: 'foreground' });
        for (let n = 0; n < 100 && !h.seen.some(e => e.key === 'foreground'); n++)
            await new Promise(r => setImmediate(r));
        assert.ok(h.seen.some(e => e.key === 'foreground'));
        assert.equal(calls, 1);
        assert.equal(h.service.listFires(h.source.to).length, 1);
        held.release();
        await h.runtime.idle();
        await h.service.tick();
        await h.runtime.idle();
        assert.equal(calls, 2);
    }
    finally { held.release(); await h.close(); }
});

for (const change of ['trigger_cancel', 'cancel', 'replace', 'deadline', 'close'] as const) {
    test(`dream ${change} during generation blocks review and late publication`, async () => {
        const held = gate(), entered = gate();
        let reviews = 0;
        const h = await fixture({
            async generate(evidence) { entered.release(); await held.promise; return approved.generate(evidence, new AbortController().signal); },
            async review() { reviews++; return { approved: true, reason: 'must not be called' }; }
        });
        try {
            const s = h.create(); h.time(2000);
            await h.service.tick(); await entered.promise;
            if (change === 'trigger_cancel') h.service.cancelSchedule(h.source.to, s.id);
            else if (change === 'deadline') h.time(10000);
            else if (change === 'close') await h.service.close();
            else h.runtime.accept({ to: h.source.to, taskId: h.source.taskId, text: change, key: change, taskControl: change });
            held.release(); await h.runtime.idle();
            assert.equal(reviews, 0);
            assert.equal(h.seen.filter(e => e.kind === 'research').length, 0);
            assert.equal(h.runtime.store.list('outbox').length, 0);
            assert.ok(h.runtime.store.list<Proposal>('proposals').every(p => ['uncertain', 'cancelled'].includes(p.state)));
            if (change === 'close') assert.throws(() => h.create({ key: 'after-close' }), /closed/);
        }
        finally { held.release(); await h.close(); }
    });
}

test('dream deadline during independent review discards late approval and closes before a later nextFire', async () => {
    const held = gate(), entered = gate();
    const h = await fixture({ ...approved, async review() { entered.release(); await held.promise; return { approved: true, reason: 'late approval' }; } });
    try {
        h.create({ intervalMs: 20000, deadline: 3000 }); h.time(2000);
        await h.service.tick(); await entered.promise;
        h.time(3000);
        await h.service.tick();
        assert.equal(h.service.listSchedules(h.source.to)[0].state, 'completed');
        held.release(); await h.runtime.idle();
        assert.equal(h.seen.filter(e => e.kind === 'research').length, 0);
        assert.equal(h.runtime.store.list<Proposal>('proposals')[0].state, 'cancelled');
    }
    finally { held.release(); await h.close(); }
});

test('expired unstarted dream does not run a model, and missing worker after restart pauses it', async () => {
    const h = await fixture();
    try {
        h.create({ deadline: 3000 }); h.time(3000);
        await h.service.tick();
        assert.equal(h.service.listSchedules(h.source.to)[0].state, 'completed');
        assert.equal(h.runtime.store.list('proposals').length, 0);
        h.time(1000); h.create({ key: 'missing-worker' });
        await h.restart(); h.time(2000);
        await h.service.tick();
        const paused = h.service.listSchedules(h.source.to).find(s => s.key === 'missing-worker')!;
        assert.equal(paused.state, 'paused');
        assert.equal(paused.dream!.halted, 'worker_unavailable');
        assert.equal(h.runtime.store.list('jobs').length, 0);
    }
    finally { await h.close(); }
});

test('interrupted durable dream is quarantined after restart rather than replayed', async () => {
    const h = await fixture();
    try {
        const s = h.create(); h.time(2000);
        await h.service.tick(); await h.runtime.idle();
        // Persist the exact crash residue without leaving an old process using the database.
        const p = h.runtime.store.list<Proposal>('proposals')[0];
        h.runtime.store.put('proposals', { ...p, state: 'running' });
        const job = h.runtime.store.get<any>('jobs', p.jobId!)!;
        h.runtime.store.put('jobs', { ...job, state: 'running' });
        await h.restart(approved); h.time(3000);
        await h.service.tick(); await h.runtime.idle();
        const restored = h.runtime.store.get<Schedule>('schedules', s.id)!;
        assert.equal(restored.state, 'paused');
        assert.equal(restored.dream!.halted, 'uncertain');
        assert.equal(h.runtime.store.list('jobs').length, 1);
        assert.equal(h.runtime.store.list<Proposal>('proposals')[0].state, 'uncertain');
        await h.service.tick();
        assert.equal(h.runtime.store.list('jobs').length, 1);
    }
    finally { await h.close(); }
});

for (const failure of ['invalid_evidence', 'budget'] as const) {
    test(`dream ${failure} rolls back dispatch and pauses without starving an independent monitor`, async () => {
        const h = await fixture();
        try {
            const evidence = h.runtime.accept({ to: h.source.to, text: 'separate evidence', key: 'separate-evidence' });
            await h.runtime.idle();
            const s = h.create({ evidenceRefs: [evidence.id] });
            if (failure === 'budget') h.runtime.options.maxJobs = 0;
            else h.runtime.accept({ to: h.source.to, taskId: evidence.taskId, key: 'withdraw-evidence', text: 'withdraw', taskControl: 'cancel' });
            const detectorService = h.service as ProactiveService;
            // A registered host detector uses the same tick and existing monitor path.
            detectorService.options.detectors = { fixture: async ({ dryRun }) => dryRun ? { decision: 'silent' } : { decision: 'wake', dedupKey: 'change', payload: 'current independent finding' } };
            const monitor = h.service.createMonitor(h.source, { key: 'independent-monitor', detector: 'fixture', prompt: 'watch', intervalMs: 1000, deadline: 9000 });
            await h.service.dryRunMonitor(h.source.to, monitor.id);
            h.service.enableMonitor(h.source.to, monitor.id);
            h.time(2000);
            await h.service.tick();
            await h.runtime.idle();
            const paused = h.runtime.store.get<Schedule>('schedules', s.id)!;
            assert.equal(paused.state, 'paused');
            assert.equal(paused.dream!.halted, failure);
            assert.equal(paused.dream!.runs, 0);
            assert.equal(h.runtime.store.list('proposals').length, 0);
            assert.equal(h.runtime.store.list('jobs').length, 0);
            assert.deepEqual(h.service.listFires(h.source.to).map(f => f.triggerId), [monitor.id]);
            assert.equal(h.runtime.store.list<Envelope>('inbox').filter(e => e.from === `schedule:${s.id}`).length, 0);
            await h.service.tick();
            assert.equal(h.runtime.store.list('jobs').length, 0);
        }
        finally { await h.close(); }
    });
}

test('dream worker receives an abort bounded by remaining deadline rather than the general work timeout', async () => {
    const held = gate(), entered = gate();
    let signal!: AbortSignal;
    let reviews = 0;
    const h = await fixture({
        async generate(evidence, inputSignal) { signal = inputSignal; entered.release(); await held.promise; return approved.generate(evidence, inputSignal); },
        async review() { reviews++; return { approved: true, reason: 'too late' }; }
    });
    try {
        h.service.options.workTimeoutMs = 1000;
        h.create({ deadline: 2025 }); h.time(2000);
        await h.service.tick(); await entered.promise;
        let timer!: ReturnType<typeof setTimeout>;
        const outcome = await Promise.race([
            h.runtime.idle().then(() => 'settled'),
            new Promise<string>(resolve => timer = setTimeout(() => resolve('not-bounded'), 250))
        ]);
        clearTimeout(timer);
        assert.equal(outcome, 'settled');
        assert.equal(signal.aborted, true);
        assert.equal(reviews, 0);
        assert.equal(h.runtime.store.list<Proposal>('proposals')[0].state, 'uncertain');
        assert.equal(h.seen.filter(e => e.kind === 'research').length, 0);
    }
    finally { held.release(); await h.close(); }
});
