import { PiBotError } from '../core/errors.ts';
import { randomUUID, createHash } from 'node:crypto';
import type { BotRuntime } from './runtime.ts';
import type { JsonValue } from '@openma/matter';
import { monitorResource, scheduleResource, type CommitResult, type Decision } from '../../pi/state-protection.ts';
import type { Envelope } from './store.ts';
import type { TriggerBase as Base, Schedule, Monitor, Fire, Detection, Candidate, Proposal, MemoryRecord } from '../../pi/types.ts';
export type { Schedule, Monitor, Fire, Detection, Proposal, MemoryRecord } from '../../pi/types.ts';
export type Detector = (input: {
    cursor?: unknown;
    baseline?: unknown;
    dryRun: boolean;
    signal: AbortSignal;
}) => Promise<Detection>;
export type BackgroundWorker = {
    generate: (evidence: Envelope[], signal: AbortSignal) => Promise<Candidate>;
    review: (candidate: Candidate, evidence: Envelope[], signal: AbortSignal) => Promise<{
        approved: boolean;
        reason: string;
    }>;
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
                throw new PiBotError('invalidParams', 'Invalid proactive timeout');
        if (!Number.isSafeInteger(options.maxFiresPerTick ?? 32) || (options.maxFiresPerTick ?? 32) < 1 || (options.maxFiresPerTick ?? 32) > 128)
            throw new PiBotError('invalidParams', 'Invalid trigger batch cap');
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
        if (this.stopped)
            throw new PiBotError('shuttingDown', 'Proactive service closed');
        const e = this.runtime.store.get<Envelope>('inbox', id);
        if (!e)
            throw new PiBotError('notFound', 'Unknown original source');
        this.runtime.assertTaskCurrent(e);
        return e;
    }
    private owned<T extends Base>(table: string, botId: string, id: string): T {
        const item = this.runtime.store.get<T>(table, id);
        if (!item || item.botId !== botId)
            throw new PiBotError('forbidden', 'Trigger owner mismatch');
        return item;
    }
    private validate(source: Envelope, key: string, prompt: string) {
        this.source(source.id);
        if (!key || key.length > 256 || !prompt.trim() || prompt.length > 16000)
            throw new PiBotError('invalidParams', 'Invalid trigger definition');
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
            throw new PiBotError('invalidParams', 'Invalid timezone');
        }
        if (!Number.isSafeInteger(input.at) || input.at < 0 || (input.intervalMs !== undefined && (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1000)))
            throw new PiBotError('invalidParams', 'Invalid schedule time');
        const existing = this.listSchedules(source.to).find(s => s.key === input.key);
        if (existing) {
            if (existing.dream || existing.sourceId !== source.id || existing.prompt !== input.prompt || existing.intervalMs !== input.intervalMs || existing.timezone !== input.timezone || existing.firstFire !== input.at || existing.misfire !== (input.misfire ?? 'coalesce') || existing.overlap !== (input.overlap ?? 'skip'))
                throw new PiBotError('conflict', 'Idempotency key conflict');
            return existing;
        }
        const s: Schedule = {
            id: randomUUID(), botId: source.to, sourceId: source.id, key: input.key, prompt: input.prompt, revision: 1, createdAt: this.now(), state: 'active', nextFire: input.at, firstFire: input.at, timezone: input.timezone, intervalMs: input.intervalMs, misfire: input.misfire ?? 'coalesce', overlap: input.overlap ?? 'skip'
        };
        this.runtime.store.put('schedules', s);
        return s;
    }
    /** Host-only opt-in. Reuses schedule/fire/job/proposal records; never installs a worker. */
    createDream(source: Envelope, input: {
        key: string;
        at: number;
        intervalMs?: number;
        deadline: number;
        maxRuns: number;
        evidenceRefs: string[];
    }): Schedule {
        this.validate(source, input.key, 'Bounded local evidence research');
        if (!this.options.workers?.research)
            throw new PiBotError('forbidden', 'Research worker not host-allowlisted');
        if (!Number.isSafeInteger(input.deadline) || input.deadline <= this.now() || input.at >= input.deadline ||
            !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 8)
            throw new PiBotError('invalidParams', 'Invalid dream bounds');
        this.evidence(source.to, input.evidenceRefs);
        const existing = this.listSchedules(source.to).find(s => s.key === input.key);
        if (existing) {
            if (!existing.dream || existing.sourceId !== source.id || existing.firstFire !== input.at ||
                existing.intervalMs !== input.intervalMs || existing.dream.deadline !== input.deadline ||
                existing.dream.maxRuns !== input.maxRuns || JSON.stringify(existing.dream.evidenceRefs) !== JSON.stringify(input.evidenceRefs))
                throw new PiBotError('conflict', 'Idempotency key conflict');
            return existing;
        }
        return this.runtime.store.transaction(() => {
            const s = this.createSchedule(source, {
                key: input.key, at: input.at, intervalMs: input.intervalMs, timezone: 'UTC',
                prompt: 'Bounded local evidence research', misfire: 'coalesce', overlap: 'skip'
            });
            const dream = { ...s, dream: { evidenceRefs: [...input.evidenceRefs], deadline: input.deadline, maxRuns: input.maxRuns, runs: 0 } };
            this.runtime.store.put('schedules', dream);
            return dream;
        });
    }
    listSchedules(botId: string) {
        return this.runtime.store.list<Schedule>('schedules').filter(s => s.botId === botId);
    }
    listFires(botId: string) {
        return this.runtime.store.list<Fire>('fires').filter(f => f.botId === botId);
    }
    /** Agent calls pass the revision they read; host calls commit against the current revision. */
    cancelSchedule(botId: string, id: string, decision?: Decision): CommitResult<Schedule> {
        return this.runtime.store.transaction(() => {
            const commit = this.commitTrigger<Schedule>('schedule', botId, id, 'schedule.cancel', decision, s => ({
                ...s, state: 'cancelled', revision: s.revision + 1
            }));
            if (commit.status === 'committed')
                this.invalidateFires(id);
            return commit;
        });
    }
    pauseSchedule(botId: string, id: string) {
        const s = this.owned<Schedule>('schedules', botId, id);
        if (s.state === 'paused')
            return;
        if (s.state !== 'active')
            throw new PiBotError('invalidRequest', 'Schedule completed or cancelled');
        this.runtime.store.put('schedules', {
            ...s, state: 'paused', revision: s.revision + 1
        });
        this.invalidateFires(id);
    }
    resumeSchedule(botId: string, id: string) {
        const s = this.owned<Schedule>('schedules', botId, id);
        this.source(s.sourceId);
        if (s.state === 'active')
            return;
        if (s.state !== 'paused')
            throw new PiBotError('invalidRequest', 'Schedule completed or cancelled');
        this.runtime.store.put('schedules', {
            ...s, state: 'active', revision: s.revision + 1
        });
    }
    pauseMonitor(botId: string, id: string) {
        const m = this.owned<Monitor>('monitors', botId, id);
        if (m.state !== 'active')
            throw new PiBotError('invalidRequest', 'Monitor expired or cancelled');
        if (!m.enabled)
            return;
        this.runtime.store.put('monitors', {
            ...m, enabled: false, revision: m.revision + 1
        });
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
            throw new PiBotError('forbidden', 'Detector not host-allowlisted');
        if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1000 || !Number.isSafeInteger(input.deadline) || input.deadline <= this.now())
            throw new PiBotError('invalidParams', 'Invalid monitor bounds');
        const old = this.listMonitors(source.to).find(m => m.key === input.key);
        if (old) {
            if (old.sourceId !== source.id || old.prompt !== input.prompt || old.detector !== input.detector || old.intervalMs !== input.intervalMs || old.deadline !== input.deadline)
                throw new PiBotError('conflict', 'Idempotency key conflict');
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
    enableMonitor(botId: string, id: string, decision?: Decision): CommitResult<Monitor> {
        this.source(this.owned<Monitor>('monitors', botId, id).sourceId);
        return this.commitTrigger<Monitor>('monitor', botId, id, 'monitor.enable', decision, m => {
            if (!m.dryRunVerified)
                throw new PiBotError('invalidRequest', 'Successful dry-run required before enable');
            if (m.state !== 'active' || m.deadline <= this.now())
                throw new PiBotError('invalidRequest', 'Monitor expired or cancelled');
            return m.enabled ? m : {
                ...m, enabled: true, revision: m.revision + 1
            };
        });
    }
    cancelMonitor(botId: string, id: string, decision?: Decision): CommitResult<Monitor> {
        const commit = this.runtime.store.transaction(() => {
            const commit = this.commitTrigger<Monitor>('monitor', botId, id, 'monitor.cancel', decision, m => ({
                ...m, enabled: false, state: 'cancelled', revision: m.revision + 1
            }));
            if (commit.status === 'committed')
                this.invalidateFires(id);
            return commit;
        });
        if (commit.status === 'committed')
            this.controllers.get(id)?.abort();
        return commit;
    }
    /** One conditional write of an owned trigger through the runtime's MutationStore.
     * change returns the same object for a no-op; any other result must advance revision. */
    private commitTrigger<T extends Base>(kind: 'schedule' | 'monitor', botId: string, id: string, operation: string, decision: Decision | undefined, change: (current: T) => T): CommitResult<T> {
        this.owned<T>(kind === 'schedule' ? 'schedules' : 'monitors', botId, id);
        const resourceId = kind === 'schedule' ? scheduleResource(id) : monitorResource(id);
        // The host's own read and commit share one transaction; agents bring their observed revision.
        return this.runtime.store.transaction(() => this.runtime.state.commit<T>({
            botId, operationId: decision?.operationId ?? `host:${randomUUID()}`, operation, input: {
                id
            }, read: [{
                    resourceId, revision: decision ? decision.observed : this.runtime.state.revision(botId, resourceId)
                }], reread: `The ${kind} changed after you read it; nothing was applied. Call ${kind}_list, then decide again.`,
            apply: tx => {
                const current = tx.read(resourceId).value as unknown as T;
                const next = change(current);
                if (next !== current)
                    tx.set(resourceId, next as unknown as JsonValue);
                return next;
            }
        }));
    }
    private invalidateFires(triggerId: string) {
        // Do not replay running tools. Prevent new actions from already-admitted cancelled fires.
        for (const fire of this.runtime.store.list<Fire>('fires').filter(f => f.triggerId === triggerId)) {
            const e = this.runtime.store.get<Envelope>('inbox', fire.inboxId);
            if (e)
                this.runtime.store.put('inbox', {
                    ...e, state: e.state === 'queued' ? 'failed' : e.state, triggerCancelled: true
                });
            for (const p of this.runtime.store.list<Proposal>('proposals'))
                if (p.sourceId === fire.inboxId && !['applied', 'cancelled'].includes(p.state))
                    this.cancelBackgroundWork(p.botId, p.id);
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
            throw new PiBotError('forbidden', 'Proposal owner mismatch');
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
            throw new PiBotError('invalidRequest', 'Applied memory cannot be cancelled');
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
            throw new PiBotError('invalidParams', 'Invalid evidence refs');
        return refs.map(id => {
            const e = this.runtime.store.get<Envelope>('inbox', id);
            if (!e || e.to !== botId || !['user', 'answer'].includes(e.kind) || !['processing', 'processed'].includes(e.state))
                throw new PiBotError('forbidden', 'Evidence must be own admitted host input');
            this.runtime.assertTaskCurrent(e);
            return e;
        });
    }
    startBackgroundWork(source: Envelope, input: {
        kind: 'research' | 'memory';
        key: string;
        evidenceRefs: string[];
        memoryKey?: string;
    }, bounds: { deadline?: number } = {}): Proposal {
        this.validate(source, input.key, 'Background work');
        const worker = this.options.workers?.[input.kind];
        if (!worker)
            throw new PiBotError('forbidden', 'Background worker not host-allowlisted');
        if (input.kind === 'memory' && (!input.memoryKey || input.memoryKey.length > 256))
            throw new PiBotError('invalidParams', 'Memory key required');
        const evidence = this.evidence(source.to, input.evidenceRefs);
        if (JSON.stringify(evidence).length > 128000)
            throw new PiBotError('budgetExhausted', 'Evidence exceeds work budget');
        const old = this.runtime.store.list<Proposal>('proposals').find(p => p.botId === source.to && p.key === input.key);
        if (old) {
            if (old.kind !== input.kind || old.memoryKey !== input.memoryKey || old.sourceId !== source.id || JSON.stringify(old.evidenceRefs) !== JSON.stringify(input.evidenceRefs))
                throw new PiBotError('conflict', 'Idempotency key conflict');
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
                const remaining = bounds.deadline === undefined ? Infinity : bounds.deadline - this.now();
                const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(this.options.workTimeoutMs ?? 60000, remaining)));
                const currentSource = () => {
                    controller.signal.throwIfAborted();
                    this.source(source.id);
                    if (bounds.deadline !== undefined && bounds.deadline <= this.now())
                        throw new PiBotError('invalidRequest', 'Background work deadline reached');
                };
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
                    currentSource();
                    const candidate = await Promise.race([worker.generate(structuredClone(evidence), controller.signal), deadline]);
                    currentSource();
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
                    if (digest(this.evidence(source.to, input.evidenceRefs)) !== p.evidenceHash)
                        throw new PiBotError('conflict', 'Evidence changed during generation');
                    const review = await Promise.race([worker.review(structuredClone(candidate), structuredClone(evidence), controller.signal), deadline]);
                    currentSource();
                    if (digest(this.evidence(source.to, input.evidenceRefs)) !== p.evidenceHash)
                        throw new PiBotError('conflict', 'Evidence changed during review');
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
                    throw new PiBotError('invalidRequest', 'Background work failed; proposal retained for review');
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
                throw new PiBotError('invalidRequest', 'Only memory proposals can apply');
            const existing = this.getMemory(botId, p.memoryKey);
            if (p.state === 'applied') {
                if (existing?.proposalId === id)
                    return existing;
                throw new PiBotError('conflict', 'Applied proposal was superseded');
            }
            if (p.state !== 'approved' || !p.review?.approved || !p.candidate)
                throw new PiBotError('reviewRequired', 'Independent approval required');
            this.source(p.sourceId);
            if (digest(this.evidence(botId, p.evidenceRefs)) !== p.evidenceHash)
                throw new PiBotError('conflict', 'Evidence changed or withdrawn');
            if ((existing?.version ?? 0) !== p.snapshotVersion)
                throw new PiBotError('conflict', 'Memory snapshot changed');
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
    private expireMonitor(m: Monitor) {
        this.fire(m, 'monitor', m.deadline, 'deadline', 'Monitor deadline reached; finish or report unresolved commitment');
        this.runtime.store.put('monitors', {
            ...m, enabled: false, state: 'expired'
        });
    }
    private tickDream(s: Schedule): boolean {
        return this.runtime.store.transaction(() => {
            const dream = s.dream!;
            if (dream.deadline <= this.now()) {
                this.runtime.store.put('schedules', { ...s, state: 'completed' });
                this.invalidateFires(s.id);
                return false;
            }
            const sourceIds = new Set(this.listFires(s.botId).filter(f => f.triggerId === s.id).map(f => f.inboxId));
            const proposals = this.runtime.store.list<Proposal>('proposals').filter(p => sourceIds.has(p.sourceId));
            if (proposals.some(p => this.getProposal(s.botId, p.id).state === 'uncertain') || !this.options.workers?.research) {
                this.runtime.store.put('schedules', {
                    ...s, state: 'paused', dream: { ...dream, halted: this.options.workers?.research ? 'uncertain' : 'worker_unavailable' }
                });
                return false;
            }
            if (proposals.some(p => p.state === 'running'))
                return false;
            if (dream.runs >= dream.maxRuns) {
                this.runtime.store.put('schedules', { ...s, state: 'completed' });
                return false;
            }
            const now = this.now();
            const dueAt = s.intervalMs ? s.nextFire + Math.floor((now - s.nextFire) / s.intervalMs) * s.intervalMs : s.nextFire;
            const eventKey = `schedule:${s.id}:${s.revision}:${createHash('sha256').update(String(dueAt)).digest('hex')}`;
            if (this.runtime.store.get<Fire>('fires', eventKey))
                return false;
            const source = this.source(s.sourceId);
            // A processed host receipt supplies durable provenance without asking the main
            // Pi session to run the research trigger or activating the inbox scheduler.
            const execution: Envelope = {
                id: randomUUID(), from: `schedule:${s.id}`, to: s.botId, kind: 'schedule',
                key: eventKey, taskId: source.taskId, replyTo: source.id, route: source.route,
                hop: source.hop, text: JSON.stringify({ triggerId: s.id, dueAt, dream: true }),
                state: 'processed', createdAt: now, admittedAt: now, consumedAt: now, resolvedAt: now
            };
            this.runtime.store.put('inbox', execution);
            this.runtime.store.put('fires', {
                id: eventKey, eventKey, botId: s.botId, triggerId: s.id, revision: s.revision,
                inboxId: execution.id, dueAt, firedAt: now
            } satisfies Fire);
            this.startBackgroundWork(execution, {
                kind: 'research', key: `dream:${eventKey}`, evidenceRefs: dream.evidenceRefs
            }, { deadline: dream.deadline });
            const runs = dream.runs + 1;
            this.runtime.store.put('schedules', {
                ...s, state: !s.intervalMs || runs >= dream.maxRuns ? 'completed' : 'active',
                nextFire: s.intervalMs ? dueAt + s.intervalMs : dueAt, dream: { ...dream, runs }
            });
            return true;
        });
    }
    private async runTick() {
        let allowance = this.options.maxFiresPerTick ?? 32;
        for (const original of this.runtime.store.list<Schedule>('schedules')) {
            if (original.state !== 'active' || Math.min(original.nextFire, original.dream?.deadline ?? Infinity) > this.now() || allowance <= 0)
                continue;
            try {
                this.source(original.sourceId);
            }
            catch {
                this.cancelSchedule(original.botId, original.id);
                continue;
            }
            if (original.dream) {
                try {
                    if (this.tickDream(original)) allowance--;
                }
                catch (error) {
                    // The failed dispatch transaction has rolled back. Retain a visible
                    // pause instead of retrying work or starving independent monitors.
                    const current = this.runtime.store.get<Schedule>('schedules', original.id)!;
                    const reason = error instanceof PiBotError ? error.reason : undefined;
                    const halted = reason === 'budgetExhausted' || reason === 'capacity' ? 'budget'
                        : reason === 'forbidden' || reason === 'taskCancelled' ? 'invalid_evidence' : 'dispatch_failed';
                    this.runtime.store.put('schedules', { ...current, state: 'paused', dream: { ...current.dream!, halted } });
                }
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
            if (!m.enabled || m.state !== 'active' || Math.min(m.nextCheck, m.deadline) > this.now() || allowance <= 0)
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
                    this.expireMonitor(m);
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
                // Input can replace/cancel the source while a detector is awaiting I/O.
                // Discard its observation without starving other monitors in this tick.
                try {
                    this.source(current.sourceId);
                }
                catch {
                    this.cancelMonitor(current.botId, current.id);
                    return;
                }
                if (current.deadline <= this.now()) {
                    this.expireMonitor(current);
                    allowance--;
                    return;
                }
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
