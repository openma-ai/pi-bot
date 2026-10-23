import { createHash, randomUUID } from 'node:crypto';
import type { NotificationAdapter, NotificationAdapterResult, NotificationEntry, NotificationKind, NotificationPreferences } from '../../sdk/notification-types.ts';
import type { PendingRequest } from '../../sdk/protocol/models.ts';
import type { BotRuntime } from './runtime.ts';
import type { Envelope, Outbound } from './store.ts';
import { PiBotError } from '../core/errors.ts';

/** Host policy over canonical requests/results. No timers, model calls or default external sink. */
export class NotificationService {
    private flushing?: Promise<void>;
    private readonly maxAttempts: number;
    private readonly retryDelay: number;
    private readonly timeout: number;
    constructor(readonly runtime: BotRuntime, readonly options: {
        adapter?: NotificationAdapter;
        now?: () => number;
        maxAttempts?: number;
        retryDelayMs?: number;
        attemptTimeoutMs?: number;
    } = {}) {
        this.maxAttempts = options.maxAttempts ?? 3;
        this.retryDelay = options.retryDelayMs ?? 1000;
        this.timeout = options.attemptTimeoutMs ?? 10000;
        for (const [value, max] of [[this.maxAttempts, 10], [this.retryDelay, 3600000], [this.timeout, 60000]])
            if (!Number.isSafeInteger(value) || value < 1 || value > max)
                throw new PiBotError('invalidParams', 'Invalid notification limits');
        if (options.adapter && (!options.adapter.id.trim() || options.adapter.id.length > 256))
            throw new PiBotError('invalidParams', 'Invalid notification adapter');
    }
    private now() { return (this.options.now ?? Date.now)(); }
    private root(e: Envelope) {
        const visited = new Set<string>();
        while (e.kind !== 'user' && e.replyTo && !visited.has(e.id)) {
            visited.add(e.id);
            const parent = this.runtime.store.get<Envelope>('inbox', e.replyTo);
            if (!parent || parent.to !== e.to || parent.taskId !== e.taskId || this.runtime.store.scopeForEnvelope(parent) !== this.runtime.store.scopeForEnvelope(e))
                throw new PiBotError('forbidden', 'Notification source lineage mismatch');
            e = parent;
        }
        if (!['user', 'answer'].includes(e.kind))
            throw new PiBotError('forbidden', 'Notification requires original host input');
        if (!e.fileOwner && this.runtime.store.list<Envelope>('inbox').some(other =>
            other.to === e.to && other.taskId === e.taskId && this.runtime.store.scopeForEnvelope(other) === this.runtime.store.scopeForEnvelope(e) && other.fileOwner && other.fileOwner !== 'local'))
            throw new PiBotError('forbidden', 'Notification owner is ambiguous');
        return e;
    }
    private source(id: string) {
        const e = this.runtime.store.get<Envelope>('inbox', id);
        if (!e) throw new PiBotError('notFound', 'Notification source missing');
        this.runtime.assertTaskCurrent(e);
        return e;
    }
    private put(n: NotificationEntry) {
        this.runtime.store.put('notification_entries', n);
        return n;
    }
    private create(source: Envelope, kind: NotificationKind, reference: NotificationEntry['reference'], expiresAt: number) {
        const root = this.root(source);
        const ownerId = root.fileOwner ?? 'local'; // Assigned by authenticated host transport, never RPC input.
        const id = createHash('sha256').update(JSON.stringify([ownerId, source.to, source.taskId, source.id, kind, reference])).digest('hex');
        const old = this.runtime.store.get<NotificationEntry>('notification_entries', id);
        if (old) return old;
        return this.put({
            id, ownerId, botId: source.to, threadId: this.runtime.store.ensureThread(source).id,
            sourceMessageId: source.id, taskId: source.taskId, kind, reference,
            summary: kind === 'action_required' ? 'Pibo needs your input' : kind === 'completion' ? 'Pibo has a task result' : 'Pibo has an important update',
            priority: kind === 'action_required' ? 'action' : 'normal', createdAt: this.now(), expiresAt,
            status: 'active', delivery: { state: 'queued', attempts: 0, nextAttemptAt: this.now() }
        });
    }
    /** Host-only: call after verifying a final result or authorizing an important finding.
     * An internal job/turn completion alone never creates a completion notification. */
    publishResult(outboxId: string, kind: Exclude<NotificationKind, 'action_required'> = 'completion') {
        if (!['completion', 'important_change'].includes(kind))
            throw new PiBotError('invalidParams', 'Invalid result notification kind');
        return this.runtime.store.transaction(() => {
            const result = this.runtime.store.get<Outbound>('outbox', outboxId);
            if (!result || !result.replyTo || ['superseded', 'uncertain'].includes(result.state))
                throw new PiBotError('invalidRequest', 'Notification requires a committed current result');
            return this.create(this.source(result.replyTo), kind, { table: 'outbox', id: result.id }, result.createdAt + 86400000);
        });
    }
    /** Rebuildable projection: replay/restart uses canonical identity, not an observer-only queue. */
    reconcile() {
        this.runtime.store.transaction(() => {
            for (const r of this.runtime.store.list<PendingRequest>('requests')) {
                if (r.status !== 'pending') continue;
                const id = r.params.sourceMessageId ?? r.params.messageId;
                if (typeof id !== 'string') continue;
                try {
                    const e = this.source(id);
                    if (e.to !== r.botId || (r.params.taskId !== undefined && e.taskId !== r.params.taskId)) continue;
                    this.create(e, 'action_required', { table: 'requests', id: r.id }, r.expiresAt ?? r.createdAt + 86400000);
                } catch { /* Invalidated/missing sources cannot become new reminders. */ }
            }
            for (const e of this.runtime.store.list<Envelope>('inbox'))
                if (['failed', 'uncertain'].includes(e.state)) {
                    try {
                        this.create(this.source(e.id), 'important_change', { table: 'inbox', id: e.id }, e.createdAt + 86400000);
                    } catch { /* A cancelled task is not a new important finding. */ }
                }
            for (const n of this.runtime.store.list<NotificationEntry>('notification_entries'))
                this.refresh(n);
        });
    }
    private refresh(n: NotificationEntry) {
        let status = n.status;
        try { this.source(n.sourceMessageId); }
        catch { status = 'superseded'; }
        if (status !== 'superseded') {
            if (n.reference.table === 'requests') {
                const r = this.runtime.store.get<PendingRequest>('requests', n.reference.id);
                if (!r || r.status !== 'pending') status = 'resolved';
            }
            else if (n.reference.table === 'outbox') {
                const r = this.runtime.store.get<Outbound>('outbox', n.reference.id);
                if (!r || r.state === 'superseded') status = 'superseded';
                else if (r.state === 'uncertain') status = 'resolved';
            }
            else {
                const e = this.runtime.store.get<Envelope>('inbox', n.reference.id);
                if (!e || !['failed', 'uncertain'].includes(e.state)) status = 'resolved';
            }
            if (status === 'active' && n.expiresAt <= this.now()) status = 'expired';
        }
        const delivery = status !== 'active' && ['queued', 'deferred', 'retry'].includes(n.delivery.state)
            ? { ...n.delivery, state: 'suppressed' as const, reason: status } : n.delivery;
        return status !== n.status || delivery !== n.delivery ? this.put({ ...n, status, delivery }) : n;
    }
    list(ownerId: string) {
        this.reconcile();
        return this.runtime.store.list<NotificationEntry>('notification_entries').filter(n => n.ownerId === ownerId);
    }
    read(ownerId: string, id: string) {
        return this.runtime.store.transaction(() => {
            const n = this.runtime.store.get<NotificationEntry>('notification_entries', id);
            if (!n || n.ownerId !== ownerId) throw new PiBotError('notFound', 'Unknown notification');
            if (n.readAt !== undefined) return this.refresh(n);
            return this.refresh(this.put({ ...n, status: n.status === 'active' ? 'read' : n.status, readAt: this.now() }));
        });
    }
    preferences(ownerId: string): NotificationPreferences {
        return this.runtime.store.get<NotificationPreferences>('notification_preferences', ownerId) ?? { id: ownerId, enabled: false, timezone: 'UTC' };
    }
    setPreferences(ownerId: string, input: Omit<NotificationPreferences, 'id'>) {
        if (typeof input.enabled !== 'boolean') throw new PiBotError('invalidParams', 'Invalid notification preference');
        try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); }
        catch { throw new PiBotError('invalidParams', 'Invalid notification timezone'); }
        if (input.quiet && (![input.quiet.startMinute, input.quiet.endMinute].every(v => Number.isInteger(v) && v >= 0 && v < 1440) || input.quiet.startMinute === input.quiet.endMinute))
            throw new PiBotError('invalidParams', 'Invalid quiet hours');
        const preferences = { id: ownerId, enabled: input.enabled, timezone: input.timezone, ...(input.quiet ? { quiet: { ...input.quiet } } : {}) };
        this.runtime.store.transaction(() => {
            this.runtime.store.put('notification_preferences', preferences);
            for (const n of this.runtime.store.list<NotificationEntry>('notification_entries'))
                if (n.ownerId === ownerId && n.delivery.state === 'deferred')
                    this.put({ ...n, delivery: { ...n.delivery, state: 'queued', nextAttemptAt: this.now() } });
        });
        return preferences;
    }
    private quietUntil(p: NotificationPreferences) {
        if (!p.quiet) return this.now();
        const format = new Intl.DateTimeFormat('en', { timeZone: p.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const quiet = (at: number) => {
            const parts = format.formatToParts(at);
            const minute = Number(parts.find(v => v.type === 'hour')!.value) * 60 + Number(parts.find(v => v.type === 'minute')!.value);
            const { startMinute: start, endMinute: end } = p.quiet!;
            return start < end ? minute >= start && minute < end : minute >= start || minute < end;
        };
        if (!quiet(this.now())) return this.now();
        // Iterate real instants rather than guessing a timezone offset across DST gaps/folds.
        let at = Math.floor(this.now() / 60000) * 60000 + 60000;
        const cap = at + 27 * 3600000;
        while (at < cap && quiet(at)) at += 60000;
        return at;
    }
    /** Explicit host drain. One adapter channel per entry; changing channel never silently resends. */
    flush(): Promise<void> {
        if (!this.flushing) this.flushing = this.runFlush().finally(() => { this.flushing = undefined; });
        return this.flushing;
    }
    private async runFlush() {
        this.reconcile();
        const adapter = this.options.adapter;
        if (!adapter) return;
        let count = 0;
        for (const item of this.runtime.store.list<NotificationEntry>('notification_entries').sort((a, b) => Number(b.priority === 'action') - Number(a.priority === 'action'))) {
            if (count >= 32) break;
            const claimed = this.runtime.store.transaction(() => {
                const n = this.refresh(this.runtime.store.get<NotificationEntry>('notification_entries', item.id)!);
                if (n.status !== 'active' || !['queued', 'deferred', 'retry'].includes(n.delivery.state) || n.delivery.nextAttemptAt > this.now()) return;
                const p = this.preferences(n.ownerId);
                if (!p.enabled) return;
                const until = this.quietUntil(p);
                if (until > this.now()) {
                    this.put({ ...n, delivery: { ...n.delivery, state: 'deferred', nextAttemptAt: until, reason: 'quiet_hours' } });
                    return;
                }
                if (n.delivery.adapterId && n.delivery.adapterId !== adapter.id) return;
                if (n.delivery.attempts >= this.maxAttempts) {
                    this.put({ ...n, delivery: { ...n.delivery, state: 'failed', reason: 'attempt_limit' } });
                    return;
                }
                return this.put({ ...n, delivery: { ...n.delivery, state: 'sending', attempts: n.delivery.attempts + 1, attemptId: randomUUID(), adapterId: adapter.id, reason: undefined } });
            });
            if (!claimed) continue;
            count++;
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const timeout = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => { controller.abort(); reject(Error('notification_timeout')); }, this.timeout);
                });
                const result = await Promise.race([adapter.deliver(Object.freeze({
                    id: claimed.id, ownerId: claimed.ownerId, idempotencyKey: claimed.id, botId: claimed.botId, threadId: claimed.threadId,
                    kind: claimed.kind, summary: claimed.summary, priority: claimed.priority,
                    sourceMessageId: claimed.sourceMessageId, expiresAt: claimed.expiresAt
                }), controller.signal), timeout]);
                this.settle(claimed, result);
            }
            catch { this.settle(claimed); }
            finally { clearTimeout(timer); }
        }
    }
    private settle(claimed: NotificationEntry, result?: NotificationAdapterResult) {
        this.runtime.store.transaction(() => {
            const current = this.runtime.store.get<NotificationEntry>('notification_entries', claimed.id)!;
            if (current.delivery.state !== 'sending' || current.delivery.attemptId !== claimed.delivery.attemptId) return;
            const n = this.refresh(current);
            let delivery: NotificationEntry['delivery'];
            if (result?.status === 'accepted') delivery = { ...n.delivery, state: 'accepted', acceptedAt: this.now() };
            else if (result?.status === 'failed') delivery = { ...n.delivery, state: 'failed', reason: 'adapter_refused' };
            else if (result?.status === 'retry' && (result.retryAfterMs === undefined || (Number.isSafeInteger(result.retryAfterMs) && result.retryAfterMs >= 1 && result.retryAfterMs <= 86400000))) {
                delivery = n.delivery.attempts >= this.maxAttempts ? { ...n.delivery, state: 'failed', reason: 'attempt_limit' }
                    : { ...n.delivery, state: n.status === 'active' ? 'retry' : 'suppressed', nextAttemptAt: this.now() + Math.max(result.retryAfterMs ?? 0, this.retryDelay * 2 ** (n.delivery.attempts - 1)), reason: 'adapter_retry' };
            }
            else delivery = { ...n.delivery, state: 'uncertain', reason: 'acknowledgement_unknown' };
            // Preserve read/cancel changes while awaiting the adapter; acceptance remains a separate fact.
            this.put({ ...n, delivery });
        });
    }
}
