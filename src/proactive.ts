import { randomUUID, createHash } from 'node:crypto';
import type { BotRuntime } from './runtime.ts';
import type { Envelope } from './store.ts';
type Base = {
    id: string;
    botId: string;
    sourceId: string;
    key: string;
    prompt: string;
    revision: number;
    createdAt: number;
};
export type Schedule = Base & {
    state: 'active' | 'paused' | 'completed' | 'cancelled';
    timezone: string;
    nextFire: number;
    firstFire: number;
    intervalMs?: number;
    misfire: 'skip' | 'coalesce' | 'catchup';
    overlap: 'queue' | 'skip';
    lastSkip?: {
        dueAt: number;
        at: number;
        reason: 'misfire' | 'overlap';
        missedPeriods: number;
    };
};
export type Monitor = Base & {
    detector: string;
    enabled: boolean;
    state: 'active' | 'expired' | 'cancelled';
    intervalMs: number;
    deadline: number;
    nextCheck: number;
    cursor?: unknown;
    baseline?: unknown;
    lastDecision?: 'silent' | 'wake' | 'error';
    error?: string;
    generation?: string;
    dryRunVerified?: boolean;
};
export type Fire = {
    id: string;
    botId: string;
    triggerId: string;
    revision: number;
    eventKey: string;
    inboxId: string;
    dueAt: number;
    firedAt: number;
};
export type Detection = {
    decision: 'silent' | 'wake' | 'error';
    cursor?: unknown;
    baseline?: unknown;
    dedupKey?: string;
    payload?: string;
    error?: string;
};
export type Detector = (input: {
    cursor?: unknown;
    baseline?: unknown;
    dryRun: boolean;
    signal: AbortSignal;
}) => Promise<Detection>;
type Candidate = {
    text: string;
    evidenceRefs: string[];
};
export type BackgroundWorker = {
    generate: (evidence: Envelope[], signal: AbortSignal) => Promise<Candidate>;
    review: (candidate: Candidate, evidence: Envelope[], signal: AbortSignal) => Promise<{
        approved: boolean;
        reason: string;
    }>;
};
export type Proposal = {
    id: string;
    botId: string;
    sourceId: string;
    key: string;
    kind: 'research' | 'memory';
    memoryKey?: string;
    snapshotVersion: number;
    evidenceRefs: string[];
    evidenceHash: string;
    state: 'running' | 'approved' | 'rejected' | 'applied' | 'uncertain' | 'cancelled';
    candidate?: Candidate;
    review?: {
        approved: boolean;
        reason: string;
    };
    jobId?: string;
    appliedVersion?: number;
    consumedAt?: number;
    resultInboxId?: string;
};
export type MemoryRecord = {
    id: string;
    botId: string;
    key: string;
    version: number;
    text: string;
    proposalId: string;
    evidenceRefs: string[];
};
const digest = (evidence: Envelope[]) => createHash('sha256').update(JSON.stringify(evidence.map(e => ({
    id: e.id, text: e.text, taskControl: e.taskControl, triggerCancelled: e.triggerCancelled
})))).digest('hex');
/** Host service; detectors must be host-allowlisted, read-only and signal-cooperative.
 * It persists events before waking Pi. No model polling, credentials or user output here. */
export class ProactiveService {
    private ticking?: Promise<void>;
    private timer?: ReturnType<typeof setInterval>;
    private stopped = false;
    private controllers = new Map<string, AbortController>();
    constructor(readonly runtime: BotRuntime, readonly options: {
        now?: () => number;
        detectors?: Record<string, Detector>;
        detectorTimeoutMs?: number;
        maxFiresPerTick?: number;
        workers?: Partial<Record<'research' | 'memory', BackgroundWorker>>;
        workTimeoutMs?: number;
    } = {}) {
        for (const value of [options.detectorTimeoutMs ?? 10000, options.workTimeoutMs ?? 60000])
            if (!Number.isSafeInteger(value) || value < 1 || value > 600000)
                throw Error('Invalid proactive timeout');
        if (!Number.isSafeInteger(options.maxFiresPerTick ?? 32) || (options.maxFiresPerTick ?? 32) < 1 || (options.maxFiresPerTick ?? 32) > 128)
            throw Error('Invalid trigger batch cap');
        for (const p of runtime.store.list<Proposal>('proposals'))
            if (p.state === 'running' && (!p.jobId || ['failed', 'uncertain'].includes(runtime.store.get<{
                state: string;
            }>('jobs', p.jobId)?.state ?? '')))
                runtime.store.put('proposals', {
                    ...p, state: 'uncertain'
                });
    }
    private now() {
        return (this.options.now ?? Date.now)();
    }
    private source(id: string) {
        const e = this.runtime.store.get<Envelope>('inbox', id);
        if (!e)
            throw Error('Unknown original source');
        this.runtime.assertTaskCurrent(e);
        return e;
    }
    private owned<T extends Base>(table: string, botId: string, id: string): T {
        const item = this.runtime.store.get<T>(table, id);
        if (!item || item.botId !== botId)
            throw Error('Trigger owner mismatch');
        return item;
    }
    private validate(source: Envelope, key: string, prompt: string) {
        this.source(source.id);
        if (!key || key.length > 256 || !prompt.trim() || prompt.length > 16000)
            throw Error('Invalid trigger definition');
    }
    createSchedule(source: Envelope, input: {
        key: string;
        prompt: string;
        at: number;
        timezone: string;
        intervalMs?: number;
        misfire?: Schedule['misfire'];
        overlap?: Schedule['overlap'];
    }): Schedule {
        this.validate(source, input.key, input.prompt);
        try {
            new Intl.DateTimeFormat('en', {
                timeZone: input.timezone
            });
        }
        catch {
            throw Error('Invalid timezone');
        }
        if (!Number.isSafeInteger(input.at) || input.at < 0 || (input.intervalMs !== undefined && (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1000)))
            throw Error('Invalid schedule time');
        const existing = this.listSchedules(source.to).find(s => s.key === input.key);
        if (existing) {
            if (existing.sourceId !== source.id || existing.prompt !== input.prompt || existing.intervalMs !== input.intervalMs || existing.timezone !== input.timezone || existing.firstFire !== input.at || existing.misfire !== (input.misfire ?? 'coalesce') || existing.overlap !== (input.overlap ?? 'skip'))
                throw Error('Idempotency key conflict');
            return existing;
        }
        const s: Schedule = {
            id: randomUUID(), botId: source.to, sourceId: source.id, key: input.key, prompt: input.prompt, revision: 1, createdAt: this.now(), state: 'active', nextFire: input.at, firstFire: input.at, timezone: input.timezone, intervalMs: input.intervalMs, misfire: input.misfire ?? 'coalesce', overlap: input.overlap ?? 'skip'
        };
        this.runtime.store.put('schedules', s);
        return s;
    }
    listSchedules(botId: string) {
        return this.runtime.store.list<Schedule>('schedules').filter(s => s.botId === botId);
    }
    listFires(botId: string) {
        return this.runtime.store.list<Fire>('fires').filter(f => f.botId === botId);
    }
    cancelSchedule(botId: string, id: string) {
        const s = this.owned<Schedule>('schedules', botId, id);
        this.runtime.store.put('schedules', {
            ...s, state: 'cancelled', revision: s.revision + 1
        });
        this.invalidateFires(id);
    }
    pauseSchedule(botId: string, id: string) {
        const s = this.owned<Schedule>('schedules', botId, id);
        if (s.state === 'paused') return;
        if (s.state !== 'active') throw Error('Schedule completed or cancelled');
        this.runtime.store.put('schedules', { ...s, state: 'paused', revision: s.revision + 1 });
        this.invalidateFires(id);
    }
    resumeSchedule(botId: string, id: string) {
        const s = this.owned<Schedule>('schedules', botId, id);
        this.source(s.sourceId);
        if (s.state === 'active') return;
        if (s.state !== 'paused') throw Error('Schedule completed or cancelled');
        this.runtime.store.put('schedules', { ...s, state: 'active', revision: s.revision + 1 });
    }
    pauseMonitor(botId: string, id: string) {
        const m = this.owned<Monitor>('monitors', botId, id);
        if (m.state !== 'active') throw Error('Monitor expired or cancelled');
        if (!m.enabled) return;
        this.runtime.store.put('monitors', { ...m, enabled: false, revision: m.revision + 1 });
        this.controllers.get(id)?.abort();
        this.invalidateFires(id);
    }
    createMonitor(source: Envelope, input: {
        key: string;
        detector: string;
        prompt: string;
        intervalMs: number;
        deadline: number;
    }): Monitor {
        this.validate(source, input.key, input.prompt);
        if (!this.options.detectors?.[input.detector])
            throw Error('Detector not host-allowlisted');
        if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1000 || !Number.isSafeInteger(input.deadline) || input.deadline <= this.now())
            throw Error('Invalid monitor bounds');
        const old = this.listMonitors(source.to).find(m => m.key === input.key);
        if (old) {
            if (old.sourceId !== source.id || old.prompt !== input.prompt || old.detector !== input.detector || old.intervalMs !== input.intervalMs || old.deadline !== input.deadline)
                throw Error('Idempotency key conflict');
            return old;
        }
        const m: Monitor = {
            ...input, id: randomUUID(), botId: source.to, sourceId: source.id, revision: 1, createdAt: this.now(), enabled: false, state: 'active', nextCheck: this.now()
        };
        this.runtime.store.put('monitors', m);
        return m;
    }
    listMonitors(botId: string) {
        return this.runtime.store.list<Monitor>('monitors').filter(m => m.botId === botId);
    }
    enableMonitor(botId: string, id: string) {
        const m = this.owned<Monitor>('monitors', botId, id);
        this.source(m.sourceId);
        if (!m.dryRunVerified)
            throw Error('Successful dry-run required before enable');
        if (m.state !== 'active' || m.deadline <= this.now())
            throw Error('Monitor expired or cancelled');
        if (m.enabled)
            return;
        this.runtime.store.put('monitors', {
            ...m, enabled: true, revision: m.revision + 1
        });
    }
    cancelMonitor(botId: string, id: string) {
        const m = this.owned<Monitor>('monitors', botId, id);
        this.runtime.store.put('monitors', {
            ...m, enabled: false, state: 'cancelled', revision: m.revision + 1
        });
        this.controllers.get(id)?.abort();
        this.invalidateFires(id);
    }
    private invalidateFires(triggerId: string) {
        // Do not replay running tools. Prevent new actions from already-admitted cancelled fires.
        for (const fire of this.runtime.store.list<Fire>('fires').filter(f => f.triggerId === triggerId)) {
            const e = this.runtime.store.get<Envelope>('inbox', fire.inboxId);
            if (e)
                this.runtime.store.put('inbox', {
                    ...e, state: e.state === 'queued' ? 'failed' : e.state, triggerCancelled: true
                });
        }
    }
    async dryRunMonitor(botId: string, id: string) {
        const m = this.owned<Monitor>('monitors', botId, id);
        const result = await this.detect(m, true);
        const current = this.owned<Monitor>('monitors', botId, id);
        if (current.revision === m.revision && current.state === 'active')
            this.runtime.store.put('monitors', {
                ...current, dryRunVerified: result.decision !== 'error'
            });
        return result;
    }
    getProposal(botId: string, id: string): Proposal {
        const p = this.runtime.store.get<Proposal>('proposals', id);
        if (!p || p.botId !== botId)
            throw Error('Proposal owner mismatch');
        if (p.state === 'running' && p.jobId && ['failed', 'uncertain'].includes(this.runtime.store.get<{
            state: string;
        }>('jobs', p.jobId)?.state ?? '')) {
            const uncertain = {
                ...p, state: 'uncertain' as const
            };
            this.runtime.store.put('proposals', uncertain);
            this.controllers.delete(p.id);
            return uncertain;
        }
        return p;
    }
    readProposal(botId: string, id: string): Proposal {
        const p = this.getProposal(botId, id);
        if (p.state === 'running')
            return p;
        const read = {
            ...p, consumedAt: p.consumedAt ?? this.now()
        };
        this.runtime.store.put('proposals', read);
        return {
            ...read, ...(!['approved', 'applied'].includes(read.state) ? {
                candidate: undefined
            } : {})
        };
    }
    cancelBackgroundWork(botId: string, id: string) {
        const p = this.getProposal(botId, id);
        if (p.state === 'applied')
            throw Error('Applied memory cannot be cancelled');
        this.runtime.store.put('proposals', {
            ...p, state: 'cancelled'
        });
        this.controllers.get(id)?.abort();
        if (p.resultInboxId) {
            const e = this.runtime.store.get<Envelope>('inbox', p.resultInboxId)!;
            this.runtime.store.put('inbox', {
                ...e, triggerCancelled: true, state: e.state === 'queued' ? 'failed' : e.state
            });
        }
    }
    getMemory(botId: string, key: string) {
        return this.runtime.store.get<MemoryRecord>('memories', JSON.stringify([botId, key]));
    }
    private evidence(botId: string, refs: string[]) {
        if (!refs.length || refs.length > 32 || new Set(refs).size !== refs.length)
            throw Error('Invalid evidence refs');
        return refs.map(id => {
            const e = this.runtime.store.get<Envelope>('inbox', id);
            if (!e || e.to !== botId || !['user', 'answer'].includes(e.kind) || !['processing', 'processed'].includes(e.state))
                throw Error('Evidence must be own admitted host input');
            this.runtime.assertTaskCurrent(e);
            return e;
        });
    }
    startBackgroundWork(source: Envelope, input: {
        kind: 'research' | 'memory';
        key: string;
        evidenceRefs: string[];
        memoryKey?: string;
    }): Proposal {
        this.validate(source, input.key, 'Background work');
        const worker = this.options.workers?.[input.kind];
        if (!worker)
            throw Error('Background worker not host-allowlisted');
        if (input.kind === 'memory' && (!input.memoryKey || input.memoryKey.length > 256))
            throw Error('Memory key required');
        const evidence = this.evidence(source.to, input.evidenceRefs);
        if (JSON.stringify(evidence).length > 128000)
            throw Error('Evidence exceeds work budget');
        const old = this.runtime.store.list<Proposal>('proposals').find(p => p.botId === source.to && p.key === input.key);
        if (old) {
            if (old.kind !== input.kind || old.memoryKey !== input.memoryKey || old.sourceId !== source.id || JSON.stringify(old.evidenceRefs) !== JSON.stringify(input.evidenceRefs))
                throw Error('Idempotency key conflict');
            return old;
        }
        const p: Proposal = {
            ...input, id: randomUUID(), botId: source.to, sourceId: source.id, snapshotVersion: input.memoryKey ? this.getMemory(source.to, input.memoryKey)?.version ?? 0 : 0, evidenceHash: digest(evidence), state: 'running'
        };
        this.runtime.store.put('proposals', p);
        const controller = new AbortController();
        this.controllers.set(p.id, controller);
        let job;
        try {
            job = this.runtime.startJob(source, `background_${input.kind}`, {
                proposalId: p.id
            }, `proposal:${p.id}`, async () => {
                const timer = setTimeout(() => controller.abort(), this.options.workTimeoutMs ?? 60000);
                let abort!: () => void;
                const deadline = new Promise<never>((_resolve, reject) => {
                    abort = () => reject(Error('Background work deadline'));
                    controller.signal.addEventListener('abort', abort, {
                        once: true
                    });
                    if (controller.signal.aborted)
                        abort();
                });
                try {
                    const candidate = await Promise.race([worker.generate(structuredClone(evidence), controller.signal), deadline]);
                    if (!candidate.text?.trim() || candidate.text.length > 16000 || !Array.isArray(candidate.evidenceRefs) || !candidate.evidenceRefs.length || !candidate.evidenceRefs.every(id => input.evidenceRefs.includes(id))) {
                        this.runtime.store.put('proposals', {
                            ...this.getProposal(source.to, p.id), state: 'rejected', review: {
                                approved: false, reason: 'Unsupported evidence or oversized candidate'
                            }
                        });
                        return {
                            proposalId: p.id, state: 'rejected'
                        };
                    }
                    const review = await Promise.race([worker.review(structuredClone(candidate), structuredClone(evidence), controller.signal), deadline]);
                    controller.signal.throwIfAborted();
                    this.source(source.id);
                    if (digest(this.evidence(source.to, input.evidenceRefs)) !== p.evidenceHash)
                        throw Error('Evidence changed during review');
                    const approved = review.approved === true && typeof review.reason === 'string' && review.reason.length <= 4000;
                    this.runtime.store.transaction(() => {
                        let resultInboxId: string | undefined;
                        if (approved && input.kind === 'research')
                            resultInboxId = this.runtime.accept({
                                from: `research:${p.id}`, to: source.to, kind: 'research', key: `proposal:${p.id}:approved`, taskId: source.taskId, replyTo: source.id, route: source.route, text: JSON.stringify({
                                    proposalId: p.id, state: 'approved', retrieve: 'background_result', notification: 'Send only useful authorized findings; no automatic completion acknowledgement'
                                })
                            }).id;
                        this.runtime.store.put('proposals', {
                            ...this.getProposal(source.to, p.id), candidate, review: {
                                approved, reason: review.reason?.slice(0, 4000) ?? 'Invalid review'
                            }, state: approved ? 'approved' : 'rejected', resultInboxId
                        });
                    });
                    return {
                        proposalId: p.id, state: approved ? 'approved' : 'rejected', notify: false
                    };
                }
                catch {
                    const current = this.getProposal(source.to, p.id);
                    if (current.state !== 'cancelled')
                        this.runtime.store.put('proposals', {
                            ...current, state: 'uncertain'
                        });
                    throw Error('Background work failed; proposal retained for review');
                }
                finally {
                    clearTimeout(timer);
                    controller.signal.removeEventListener('abort', abort);
                    this.controllers.delete(p.id);
                }
            }, {
                quiet: true, onSettled: state => {
                    const current = this.runtime.store.get<Proposal>('proposals', p.id)!;
                    if (current.state === 'running' && state !== 'running' && state !== 'completed')
                        this.runtime.store.put('proposals', {
                            ...current, state: 'uncertain'
                        });
                    this.controllers.delete(p.id);
                }
            });
        }
        catch (error) {
            this.runtime.store.put('proposals', {
                ...p, state: 'uncertain'
            });
            this.controllers.delete(p.id);
            throw error;
        }
        const saved = {
            ...p, jobId: job.id
        };
        this.runtime.store.put('proposals', saved);
        return saved;
    }
    applyMemory(botId: string, id: string): MemoryRecord {
        return this.runtime.store.transaction(() => {
            const p = this.getProposal(botId, id);
            if (p.kind !== 'memory' || !p.memoryKey)
                throw Error('Only memory proposals can apply');
            const existing = this.getMemory(botId, p.memoryKey);
            if (p.state === 'applied') {
                if (existing?.proposalId === id)
                    return existing;
                throw Error('Applied proposal was superseded');
            }
            if (p.state !== 'approved' || !p.review?.approved || !p.candidate)
                throw Error('Independent approval required');
            this.source(p.sourceId);
            if (digest(this.evidence(botId, p.evidenceRefs)) !== p.evidenceHash)
                throw Error('Evidence changed or withdrawn');
            if ((existing?.version ?? 0) !== p.snapshotVersion)
                throw Error('Memory snapshot changed');
            const memory: MemoryRecord = {
                id: JSON.stringify([botId, p.memoryKey]), botId, key: p.memoryKey, version: p.snapshotVersion + 1, text: p.candidate.text, proposalId: id, evidenceRefs: p.candidate.evidenceRefs
            };
            this.runtime.store.put('memories', memory);
            this.runtime.store.put('proposals', {
                ...p, state: 'applied', appliedVersion: memory.version
            });
            return memory;
        });
    }
    private async detect(m: Monitor, dryRun: boolean): Promise<Detection> {
        const detector = this.options.detectors?.[m.detector];
        if (!detector)
            return {
                decision: 'error', error: 'Detector unavailable'
            };
        const controller = new AbortController();
        if (!dryRun)
            this.controllers.set(m.id, controller);
        const timer = setTimeout(() => controller.abort(), this.options.detectorTimeoutMs ?? 10000);
        let abort!: () => void;
        const timeout = new Promise<Detection>(resolve => {
            abort = () => resolve({
                decision: 'error', error: 'Detector cancelled or timed out'
            });
            controller.signal.addEventListener('abort', abort, {
                once: true
            });
        });
        try {
            const result = await Promise.race([detector({
                    cursor: structuredClone(m.cursor), baseline: structuredClone(m.baseline), dryRun, signal: controller.signal
                }), timeout]);
            if (!['silent', 'wake', 'error'].includes(result.decision) || (result.decision === 'wake' && (!result.dedupKey || !result.payload || result.payload.length > 16000 || result.dedupKey.length > 256)))
                return {
                    decision: 'error', error: 'Invalid detector protocol'
                };
            if (JSON.stringify(result).length > 64000)
                return {
                    decision: 'error', error: 'Detector state too large'
                };
            return result;
        }
        catch {
            return {
                decision: 'error', error: 'Detector failed'
            };
        }
        finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', abort);
            if (!dryRun)
                this.controllers.delete(m.id);
        }
    }
    private fire(trigger: Base, kind: 'schedule' | 'monitor', dueAt: number, suffix: string, payload: string) {
        const eventKey = `${kind}:${trigger.id}:${trigger.revision}:${createHash('sha256').update(suffix).digest('hex')}`;
        const id = eventKey;
        if (this.runtime.store.get<Fire>('fires', id))
            return;
        const source = this.source(trigger.sourceId);
        const e = this.runtime.accept({
            from: `${kind}:${trigger.id}`, to: trigger.botId, kind, key: eventKey, text: JSON.stringify({
                triggerId: trigger.id, revision: trigger.revision, dueAt, prompt: trigger.prompt, observation: payload
            }), taskId: source.taskId, replyTo: source.id, route: source.route
        });
        this.runtime.store.put('fires', {
            id, botId: trigger.botId, triggerId: trigger.id, revision: trigger.revision, eventKey, inboxId: e.id, dueAt, firedAt: this.now()
        } satisfies Fire);
    }
    tick(): Promise<void> {
        if (this.stopped)
            return Promise.resolve();
        if (!this.ticking)
            this.ticking = this.runTick().finally(() => this.ticking = undefined);
        return this.ticking;
    }
    private async runTick() {
        let allowance = this.options.maxFiresPerTick ?? 32;
        for (const original of this.runtime.store.list<Schedule>('schedules')) {
            if (original.state !== 'active' || original.nextFire > this.now() || allowance <= 0)
                continue;
            try {
                this.source(original.sourceId);
            }
            catch {
                this.cancelSchedule(original.botId, original.id);
                continue;
            }
            this.runtime.store.transaction(() => {
                let s = this.runtime.store.get<Schedule>('schedules', original.id)!;
                const now = this.now();
                while (s.nextFire <= now && allowance > 0) {
                    const dueAt = s.misfire === 'coalesce' && s.intervalMs ? s.nextFire + Math.floor((now - s.nextFire) / s.intervalMs) * s.intervalMs : s.nextFire;
                    const busy = this.listFires(s.botId).some(f => f.triggerId === s.id && ['queued', 'processing', 'uncertain'].includes(this.runtime.store.get<Envelope>('inbox', f.inboxId)?.state ?? ''));
                    const skipped = (s.misfire === 'skip' && dueAt < now) || (s.overlap === 'skip' && busy);
                    if (!skipped) {
                        this.fire(s, 'schedule', dueAt, String(dueAt), 'Scheduled task due');
                        allowance--;
                    }
                    const next = s.intervalMs ? (s.misfire === 'skip' ? s.nextFire + (Math.floor((now - s.nextFire) / s.intervalMs) + 1) * s.intervalMs : dueAt + s.intervalMs) : dueAt;
                    s = {
                        ...s, nextFire: next, state: s.intervalMs ? 'active' : 'completed', ...(skipped ? {
                            lastSkip: {
                                dueAt, at: now, reason: busy && s.overlap === 'skip' ? 'overlap' as const : 'misfire' as const, missedPeriods: s.intervalMs ? Math.floor((now - s.nextFire) / s.intervalMs) + 1 : 1
                            }
                        } : {})
                    };
                    this.runtime.store.put('schedules', s);
                    if (!s.intervalMs || s.misfire !== 'catchup')
                        break;
                    // Bounded even when all missed fires are skipped due to overlap.
                    if (skipped) {
                        s = {
                            ...s, nextFire: now + s.intervalMs
                        };
                        this.runtime.store.put('schedules', s);
                        break;
                    }
                }
            });
        }
        for (const m of this.runtime.store.list<Monitor>('monitors')) {
            if (!m.enabled || m.state !== 'active' || m.nextCheck > this.now() || allowance <= 0)
                continue;
            try {
                this.source(m.sourceId);
            }
            catch {
                this.cancelMonitor(m.botId, m.id);
                continue;
            }
            if (m.deadline <= this.now()) {
                this.runtime.store.transaction(() => {
                    this.fire(m, 'monitor', m.deadline, 'deadline', 'Monitor deadline reached; finish or report unresolved commitment');
                    this.runtime.store.put('monitors', {
                        ...m, enabled: false, state: 'expired'
                    });
                });
                allowance--;
                continue;
            }
            const generation = randomUUID();
            this.runtime.store.put('monitors', {
                ...m, generation
            });
            const result = await this.detect(m, false);
            if (this.stopped)
                return;
            this.runtime.store.transaction(() => {
                const current = this.runtime.store.get<Monitor>('monitors', m.id)!;
                if (!current.enabled || current.state !== 'active' || current.revision !== m.revision || current.generation !== generation)
                    return;
                if (result.decision === 'wake') {
                    this.fire(m, 'monitor', this.now(), result.dedupKey!, result.payload!);
                    allowance--;
                }
                this.runtime.store.put('monitors', {
                    ...current, nextCheck: this.now() + m.intervalMs, lastDecision: result.decision, error: result.error, ...(result.decision === 'error' ? {} : {
                        cursor: result.cursor, baseline: result.baseline
                    })
                });
            });
        }
    }
    start(intervalMs = 1000) {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            void this.tick().catch(() => this.runtime.errors.push(Error('Proactive trigger failed; persistent state retained')));
        }, intervalMs);
        this.timer.unref();
    }
    async close() {
        this.stopped = true;
        clearInterval(this.timer);
        for (const c of this.controllers.values())
            c.abort();
        await this.ticking;
    }
}
