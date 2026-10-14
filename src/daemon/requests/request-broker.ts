import { uuid7 } from '../core/ids.ts';
import { PiBotError } from '../core/errors.ts';
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
            botId: q.botId, taskId: q.taskId, questionId: q.id, text: q.text
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
    }) {
        const source = this.runtime.store.list<any>('inbox').find(e => e.to === input.botId && e.taskId === input.taskId && e.state === 'processing');
        if (!source)
            throw new PiBotError('taskCancelled', 'Task is no longer active');
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
        const source = this.runtime.store.get<any>('inbox', r.params.messageId ?? r.params.sourceMessageId ?? this.runtime.store.list<any>('inbox').find(e => e.to === r.botId && e.taskId === r.params.taskId)?.id);
        if (source)
            this.runtime.assertTaskCurrent(source);
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
    sweep() {
        for (const r of this.list())
            if (r.status === 'pending') {
                if (r.expiresAt !== null && r.expiresAt <= Date.now()) {
                    this.finish(r, 'expired', undefined, 'timeout');
                    continue;
                }
                const source = this.runtime.store.list<any>('inbox').find(e => e.to === r.botId && e.taskId === r.params.taskId);
                if (source)
                    try {
                        this.runtime.assertTaskCurrent(source);
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
