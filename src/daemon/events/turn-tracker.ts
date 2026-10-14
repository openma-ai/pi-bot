import { backfill } from './backfill.ts';
import type { Store } from '../runtime/store.ts';
import type { Envelope } from '../../pi/types.ts';
import type { Thread, Turn, Usage, Item } from '../../sdk/protocol/models.ts';
import { uuid7, threadId } from '../core/ids.ts';
import { PiBotError, classifyError } from '../core/errors.ts';
export const zeroUsage = (): Usage => ({
    input: 0, output: 0, cacheRead: 0, reasoning: 0, totalTokens: 0, costUsd: 0
});
export class TurnTracker {
    constructor(readonly store: Store) {
        backfill(store);
        for (const e of store.list<Envelope>('inbox'))
            this.ensure(e);
        for (const t of store.list<Turn>('turns'))
            if (t.status === 'running')
                this.end(t.id, 'uncertain', new PiBotError('internal', 'Daemon restarted', {
                    cause: 'daemonRestarted'
                }));
        for (const t of store.list<Thread>('threads'))
            if (t.status === 'loaded')
                store.put('threads', {
                    ...t, status: 'stored', activeTurnId: null
                });
    }
    ensure(e: Envelope) {
        return this.store.ensureThread(e);
    }
    begin(e: Envelope) {
        const thread = this.ensure(e);
        const id = uuid7('trn_');
        const turn: Turn = {
            id, threadId: thread.id, botId: e.to, trigger: e.kind, status: 'running', primaryInputId: e.id, inputIds: [e.id], taskId: e.taskId, startedAt: Date.now(), endedAt: null, usage: zeroUsage(), error: null
        };
        this.store.transaction(() => {
            this.store.put('turns', turn);
            this.store.put('threads', {
                ...thread, status: 'loaded', activeTurnId: id, lastActivityAt: Date.now()
            });
        });
        return turn;
    }
    addInput(turnId: string, e: Envelope) {
        const t = this.store.get<Turn>('turns', turnId);
        if (t && !t.inputIds.includes(e.id))
            this.store.put('turns', {
                ...t, inputIds: [...t.inputIds, e.id]
            });
    }
    usage(turnId: string, u: Usage) {
        const t = this.store.get<Turn>('turns', turnId);
        if (!t)
            return;
        const usage = {
            ...(t.usage ?? zeroUsage())
        };
        for (const k of Object.keys(usage) as (keyof Usage)[])
            usage[k] += Math.max(0, Number(u[k]) || 0);
        this.store.put('turns', {
            ...t, usage
        });
    }
    end(id: string, status: Turn['status'], error?: unknown) {
        const t = this.store.get<Turn>('turns', id);
        if (!t)
            return;
        const err = error ? classifyError(error) : undefined;
        this.store.transaction(() => {
            this.store.put('turns', {
                ...t, status, endedAt: Date.now(), error: err ? {
                    reason: err.reason, message: err.message, ...(err.details ? {
                        details: err.details
                    } : {})
                } : null
            });
            const thread = this.store.get<Thread>('threads', t.threadId);
            if (thread)
                this.store.put('threads', {
                    ...thread, activeTurnId: null, lastActivityAt: Date.now()
                });
        });
    }
    item(item: Item) {
        this.store.put('items', item);
    }
}
