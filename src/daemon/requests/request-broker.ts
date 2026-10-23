import { uuid7 } from '../core/ids.ts';
import { PiBotError } from '../core/errors.ts';
import type { Envelope } from '../runtime/store.ts';
import type { PendingRequest } from '../../sdk/protocol/models.ts';
import type { BotRuntime } from '../runtime/runtime.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { redactTraceValue } from '../../pi/redact.ts';
export class RequestBroker {
    private waiting = new Map<string, (allow: boolean) => void>();
    private timer: ReturnType<typeof setInterval>;
    constructor(readonly runtime: BotRuntime, readonly connections: Map<string, DaemonConnection>, readonly timeout = 600000) {
        for (const r of this.list())
            if (r.kind === 'approval' && r.status === 'pending')
                this.finish(r, 'cancelled', undefined, 'daemonRestarted');
        for (const q of runtime.store.list<any>('questions'))
            if (q.state === 'pending')
                this.question(q);
        this.timer = setInterval(() => this.sweep(), 1000);
        this.timer.unref();
    }
    list() {
        return this.runtime.store.list<PendingRequest>('requests');
    }
    create(kind: PendingRequest['kind'], source: any, params: any, expiresAt: number | null = null, id = uuid7('req_')) {
        const old = this.runtime.store.get<PendingRequest>('requests', id);
        if (old)
            return old;
        const ctx: any = this.runtime.store.recordContext('inbox', source) ?? {
            threadId: this.runtime.tracker.ensure(source).id
        };
        const r: PendingRequest = {
            id, kind, botId: source.to, threadId: ctx.threadId, turnId: ctx.turnId ?? null, params: redactTraceValue({
                ...params, sourceMessageId: source.id
            }) as any, status: 'pending', createdAt: Date.now(), expiresAt
        };
        this.runtime.store.put('requests', r);
        for (const c of this.connections.values())
            this.send(c, r);
        return r;
    }
    question(q: any) {
        const source = this.runtime.store.get<any>('inbox', q.messageId);
        if (!source)
            return;
        const r = this.create('question', source, {
            botId: q.botId, taskId: q.taskId, questionId: q.id, text: q.text, ...(q.choices?{choices:q.choices}:{})
        }, null, 'req_question:' + q.id);
        if (q.state === 'answered' && r.status === 'pending')
            this.finish(r, 'resolved', {
                text: q.answer
            }, 'host');
        return r;
    }
    send(c: DaemonConnection, r: PendingRequest) {
        if (c.status === 'active' && c.supportsRequest(r.botId, r.threadId) && c.capabilities.serverRequests?.includes(r.kind))
            c.push({
                id: 'srv_' + r.id, method: 'request/' + r.kind, params: {
                    request: r
                }
            });
    }
    sendPending(c: DaemonConnection) {
        for (const r of this.list())
            if (r.status === 'pending')
                this.send(c, r);
    }
    async approval(input: {
        botId: string;
        taskId: string;
        tool: string;
        args: unknown;
        sourceMessageId?: string;
    }) {
        // Legacy callers may omit identity only when a single current source exists.
        // Never guess the oldest/newest envelope of a reused task or another route.
        let source: Envelope | undefined;
        if (input.sourceMessageId) {
            source = this.runtime.store.get<Envelope>('inbox', input.sourceMessageId);
        }
        else {
            const sources = this.runtime.store.list<Envelope>('inbox').filter(e => {
                if (e.to !== input.botId || e.taskId !== input.taskId) return false;
                try { this.runtime.assertTaskCurrent(e); return true; }
                catch { return false; }
            });
            if (sources.length > 1)
                throw new PiBotError('invalidParams', 'Approval requires sourceMessageId for ambiguous task');
            source = sources[0];
        }
        if (!source || source.to !== input.botId || source.taskId !== input.taskId)
            throw new PiBotError('taskCancelled', 'Approval source is missing or does not match task');
        this.runtime.assertTaskCurrent(source);
        const r = this.create('approval', source, input, Date.now() + this.timeout);
        return new Promise<boolean>(resolve => {
            this.waiting.set(r.id, resolve);
        });
    }
    resolve(id: string, response: any, by: string) {
        const r = this.runtime.store.get<PendingRequest>('requests', id);
        if (!r)
            throw new PiBotError('notFound', 'Unknown request');
        if (r.status === 'resolved') {
            if (JSON.stringify(r.response) !== JSON.stringify(redactTraceValue(response)))
                throw new PiBotError('conflict', 'Request already resolved differently');
            return r;
        }
        if (r.status !== 'pending')
            throw new PiBotError('invalidRequest', 'Request is no longer pending');
        if (r.expiresAt !== null && r.expiresAt <= Date.now()) {
            this.finish(r, 'expired', undefined, 'timeout');
            throw new PiBotError('invalidRequest', 'Request expired');
        }
        if (r.kind === 'approval' && (!['approve', 'deny'].includes(response?.decision) || Object.keys(response).some(k => !['decision', 'note'].includes(k))))
            throw new PiBotError('invalidParams', 'Expected approve or deny');
        if (r.kind === 'question' && (typeof response?.text !== 'string' || !response.text.trim() || response.text.length > 4000 || Object.keys(response).some(k => k !== 'text')))
            throw new PiBotError('invalidParams', 'Expected question answer');
        if (r.kind === 'credential')
            throw new PiBotError('invalidRequest', 'Credential submissions must use the direct form');
        this.assertSourceCurrent(r);
        return this.runtime.store.transaction(() => {
            if (r.kind === 'question')
                this.runtime.answer(String(r.params.questionId), response.text, 'request:' + r.id);
            return this.finish(r, 'resolved', response, by);
        });
    }
    finish(r: PendingRequest, status: PendingRequest['status'], response: any, by: string) {
        const next = {
            ...r, status, ...(response ? {
                response: redactTraceValue(response) as any
            } : {}), resolvedBy: by, resolvedAt: Date.now()
        };
        this.runtime.store.put('requests', next);
        this.waiting.get(r.id)?.(status === 'resolved' && response?.decision === 'approve');
        this.waiting.delete(r.id);
        return next;
    }
    private assertSourceCurrent(r: PendingRequest) {
        const id = r.params.sourceMessageId ?? r.params.messageId;
        const source = typeof id === 'string' ? this.runtime.store.get<Envelope>('inbox', id) : undefined;
        if (!source || source.to !== r.botId || (r.params.taskId !== undefined && source.taskId !== r.params.taskId))
            throw new PiBotError('taskCancelled', 'Request source is missing or does not match task');
        this.runtime.assertTaskCurrent(source);
    }
    sweep() {
        for (const r of this.list())
            if (r.status === 'pending') {
                if (r.expiresAt !== null && r.expiresAt <= Date.now()) {
                    this.finish(r, 'expired', undefined, 'timeout');
                    continue;
                }
                try {
                    this.assertSourceCurrent(r);
                }
                catch {
                    this.finish(r, 'cancelled', undefined, 'host');
                }
            }
    }
    close() {
        clearInterval(this.timer);
        for (const r of this.list())
            if (r.status === 'pending' && r.kind === 'approval')
                this.finish(r, 'cancelled', undefined, 'shutdown');
    }
}
