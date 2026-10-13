import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const eventsMethods = {
    'events/subscribe': {
        params: O({
            after: Time, filter: Type.Optional(filter)
        }), result: O({
            subscriptionId: Id, replayedThrough: Time
        })
    },
    'events/unsubscribe': {
        params: O({
            subscriptionId: Id
        }), result: ok
    },
    'events/ack': {
        params: O({
            seq: Time
        }), result: ok
    },
} as const;
