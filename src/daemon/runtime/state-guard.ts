import { Effect, Either } from 'effect';
import type { JsonValue } from '@openma/matter';
import { makeMutationStore, MutationError, type MutationBackend, type MutationBackendTransaction, type MutationRecord, type MutationStore, type MutationTransaction, type ObservedState } from '@openma/matter/store';
import { createHash } from 'node:crypto';
import { PiBotError } from '../core/errors.ts';
import { conversationInputKinds, type CommitResult, type Revision } from '../../pi/state-protection.ts';
import type { Store, Outbound } from './store.ts';
type Trigger = {
    id: string;
    botId: string;
    revision: number;
};
const unsupported = (message: string): never => {
    throw new MutationError({
        code: 'unsupported', message
    });
};
const botOf = (authority: string) => authority.startsWith('bot:') && authority.length > 4 ? authority.slice(4) : unsupported('Unknown authority');
const split = (resourceId: string) => {
    const at = resourceId.indexOf(':');
    return at > 0 ? [resourceId.slice(0, at), resourceId.slice(at + 1)] as const : unsupported('Unknown resource');
};
const triggerTables = {
    schedule: 'schedules', monitor: 'monitors'
} as const;
/** MutationBackend over pi-bot's own SQLite tables: no shadow copy of domain state.
 * Revisions are derived from the domain rows, so host writes outside this port
 * (new user input, trigger bookkeeping) are seen by the comparison too.
 * - conversation:<route>  read-only; the latest user/answer input id in that route.
 * - outbox:<key>          create-once outbound message; content-hash revision.
 * - schedule:<id>, monitor:<id>  the trigger's own business revision. */
export function storeMutationBackend(store: Store): MutationBackend {
    const read = (authority: string, resourceId: string): ObservedState => {
        const botId = botOf(authority), [kind, name] = split(resourceId);
        const absent: ObservedState = {
            authority, resourceId, revision: null, exists: false
        };
        if (kind === 'conversation') {
            const [channelId, conversationId, threadId] = JSON.parse(name) as [string, string, string];
            const row = store.db.prepare(`SELECT id FROM inbox WHERE json_extract(data,'$.to')=? AND json_extract(data,'$.kind') IN (${conversationInputKinds.map(() => '?').join(',')}) AND coalesce(json_extract(data,'$.route.channelId'),'private')=? AND coalesce(json_extract(data,'$.route.conversationId'),json_extract(data,'$.route.channelId'),'private')=? AND coalesce(json_extract(data,'$.route.threadId'),'')=? ORDER BY rowid DESC LIMIT 1`).get(botId, ...conversationInputKinds, channelId, conversationId, threadId) as {
                id: string;
            } | undefined;
            return row ? {
                authority, resourceId, revision: row.id, exists: true, value: {
                    latestInputId: row.id
                }
            } : absent;
        }
        if (kind === 'outbox') {
            const row = store.find<Outbound>('outbox', botId, name);
            return row ? {
                authority, resourceId, revision: createHash('sha256').update(JSON.stringify(row)).digest('hex'), exists: true, value: row as unknown as JsonValue
            } : absent;
        }
        if (kind === 'schedule' || kind === 'monitor') {
            const row = store.get<Trigger>(triggerTables[kind], name);
            return row && row.botId === botId ? {
                authority, resourceId, revision: String(row.revision), exists: true, value: row as unknown as JsonValue
            } : absent;
        }
        return unsupported('Unknown resource');
    };
    const write = (state: ObservedState) => {
        const botId = botOf(state.authority), [kind, name] = split(state.resourceId);
        const value = state.value as Record<string, unknown> | undefined;
        if (!state.exists || !value)
            unsupported('Deletion is not supported');
        if (kind === 'outbox') {
            if (read(state.authority, state.resourceId).exists || value!.botId !== botId || value!.key !== name)
                unsupported('Outbound messages are created once by their key');
            store.put('outbox', value as unknown as Outbound);
            return;
        }
        if (kind === 'schedule' || kind === 'monitor') {
            const current = read(state.authority, state.resourceId);
            if (!current.exists || value!.id !== name || value!.botId !== botId || String(value!.revision) === current.revision)
                unsupported('A trigger write must keep its identity and advance its revision');
            store.put(triggerTables[kind], value as unknown as Trigger);
            return;
        }
        unsupported('Read-only resource');
    };
    const tx: MutationBackendTransaction = {
        read, write,
        receipt(authority, operationId) {
            const row = store.db.prepare('SELECT data FROM mutation_receipts WHERE authority=? AND operation_id=?').get(authority, operationId) as {
                data: string;
            } | undefined;
            return row ? JSON.parse(row.data) as MutationRecord : undefined;
        },
        record(record) {
            store.db.prepare('INSERT INTO mutation_receipts(authority,operation_id,data) VALUES(?,?,?)').run(record.intent.authority, record.intent.operationId, JSON.stringify(record));
        }
    };
    return {
        // Inside an enclosing host transaction a savepoint keeps this commit all-or-nothing.
        atomic: body => {
            if (!store.db.isTransaction)
                return store.transaction(() => body(tx));
            store.db.exec('SAVEPOINT state_mutation');
            try {
                const value = body(tx);
                store.db.exec('RELEASE state_mutation');
                return value;
            }
            catch (error) {
                store.db.exec('ROLLBACK TO state_mutation');
                store.db.exec('RELEASE state_mutation');
                throw error;
            }
        },
        read,
        close: () => {
        }
    };
}
/** Conditional commits for agent-facing state-changing tools (issue #6). */
export class StateGuard {
    readonly mutations: MutationStore;
    constructor(store: Store) {
        this.mutations = makeMutationStore(storeMutationBackend(store));
    }
    static authority(botId: string) {
        return `bot:${botId}`;
    }
    /** Host-side read; agent decisions must use revisions the agent was shown instead. */
    revision(botId: string, resourceId: string): Revision {
        return this.run(this.mutations.read(StateGuard.authority(botId), resourceId)).revision;
    }
    /** Compare the read set and apply in one transaction. A conflict has no business effect. */
    commit<A>(request: {
        botId: string;
        operationId: string;
        operation: string;
        input: JsonValue;
        read: readonly {
            resourceId: string;
            revision: Revision;
        }[];
        reread: string;
        apply: (tx: MutationTransaction, input: JsonValue) => A;
    }): CommitResult<A> {
        const authority = StateGuard.authority(request.botId);
        const result = this.run(this.mutations.execute({
            authority, operationId: request.operationId, operation: request.operation, input: request.input, preconditions: request.read.map(r => ({
                authority, resourceId: r.resourceId, revision: r.revision
            }))
        }, (tx, intent) => request.apply(tx, intent.input) as JsonValue));
        return result.status === 'committed' ? {
            ...result, value: result.value as A
        } : {
            ...result, reread: request.reread
        };
    }
    private run<A>(effect: Effect.Effect<A, MutationError>): A {
        const outcome = Effect.runSync(Effect.either(effect));
        if (Either.isRight(outcome))
            return outcome.right;
        const error = outcome.left;
        if (error.code === 'transaction-failed' && error.cause instanceof PiBotError)
            throw error.cause;
        if (error.code === 'idempotency-conflict')
            throw new PiBotError('conflict', 'Idempotency key conflict: a new decision needs a new key');
        throw new PiBotError(error.code === 'invalid-intent' ? 'invalidParams' : 'internal', error.message);
    }
}
