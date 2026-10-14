import { createHash } from 'node:crypto';
import type { Store } from '../runtime/store.ts';
import type { Envelope, Outbound, Bot } from '../../pi/types.ts';
import { threadId } from '../core/ids.ts';
import { derive } from './derive.ts';
import { redactTraceValue } from '../../pi/redact.ts';
export function backfill(store: Store) {
    const from = Number((store.db.prepare('SELECT version FROM schema_version').get() as any).version);
    if (from >= 4)
        return;
    store.transaction(() => {
        const insert = (table: string, value: any) => store.db.prepare(`INSERT INTO ${table}(id,data)VALUES(?,?) ON CONFLICT(id)DO NOTHING`).run(value.id, JSON.stringify(value));
        const inputs = store.list<Envelope>('inbox');
        for (const e of inputs) {
            const key = store.scopeForEnvelope(e), id = threadId(e.to, key);
            insert('threads', {
                id, botId: e.to, scopeKey: key, scope: {
                    channelId: e.route?.channelId ?? null, conversationId: e.route?.conversationId ?? e.route?.channelId ?? null, threadId: e.route?.threadId || null
                }, status: 'stored', activeTurnId: null, lastActivityAt: e.resolvedAt ?? e.createdAt, createdAt: e.createdAt
            });
            for (const event of derive('inbox', undefined, e, {
                threadId: id
            }))
                if (event.params.item)
                    insert('items', redactTraceValue(event.params.item));
        }
        for (const e of store.list<Outbound>('outbox')) {
            const source = inputs.find(i => i.id === e.replyTo);
            const key = source ? store.scopeForEnvelope(source) : JSON.stringify([e.route?.channelId ?? 'private', e.route?.conversationId ?? e.route?.channelId ?? 'private', e.route?.threadId ?? '']);
            const id = threadId(e.botId, key);
            for (const event of derive('outbox', undefined, e, {
                threadId: id
            }))
                if (event.params.item)
                    insert('items', redactTraceValue(event.params.item));
        }
        for (const b of store.list<Bot>('bots'))
            for (const storageKey of Object.keys(b.sessionFiles ?? {})) {
                const source = inputs.find(e => e.to === b.id && createHash('sha256').update(store.scopeForEnvelope(e)).digest('hex').slice(0, 24) === storageKey);
                if (source)
                    continue; // Already reconstructed from the authoritative inbox route.
                let scope: any;
                try {
                    scope = JSON.parse(storageKey);
                }
                catch {
                    continue;
                }
                if (!Array.isArray(scope) || scope.length !== 3)
                    continue;
                insert('threads', {
                    id: threadId(b.id, storageKey), botId: b.id, scopeKey: storageKey, scope: {
                        channelId: scope[0] === 'private' ? null : scope[0], conversationId: scope[1] === 'private' ? null : scope[1], threadId: scope[2] || null
                    }, status: 'stored', activeTurnId: null, createdAt: b.createdAt, lastActivityAt: b.createdAt
                });
            }
        for (const q of store.list<any>('questions'))
            if (q.state === 'pending') {
                const source = inputs.find(i => i.id === q.messageId);
                if (source)
                    insert('requests', {
                        id: 'req_question:' + q.id, kind: 'question', botId: q.botId, threadId: threadId(source.to, store.scopeForEnvelope(source)), turnId: null, params: {
                            botId: q.botId, taskId: q.taskId, questionId: q.id, text: q.text, sourceMessageId: source.id
                        }, status: 'pending', createdAt: q.createdAt, expiresAt: null
                    });
            }
        store.db.prepare('UPDATE schema_version SET version=4').run();
        store.events.append('daemon/migrated', {
            fromVersion: from, toVersion: 4
        });
    });
}
