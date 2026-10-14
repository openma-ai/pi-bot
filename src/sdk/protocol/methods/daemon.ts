import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const daemonMethods = {
    'daemon/status': {
        params: empty, result: Json
    },
    'daemon/snapshot': {
        params: O({
            botIds: Type.Optional(Type.Array(Id))
        }), result: SnapshotSchema
    },
    'daemon/shutdown': {
        params: O({
            drainTimeoutMs: Type.Optional(Type.Integer({
                minimum: 0, maximum: 600000
            }))
        }), result: ok
    },
} as const;
