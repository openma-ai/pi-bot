import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const turnMethods = {
    'turn/start': {
        params: O({
            botId: Id, text: Type.String({
                minLength: 1, maxLength: 64000, pattern: '\\S'
            }), key: Id, groupId: optId, threadId: optId
        }), result: O({
            inputId: Id, threadId: Id, status: Type.Literal('queued'), inputIds: Type.Optional(Type.Array(Id))
        })
    },
    'turn/steer': {
        params: O({
            threadId: Id, text: Type.String({
                minLength: 1, maxLength: 64000
            }), key: Id
        }), result: O({
            inputId: Id, threadId: Id, status: Type.Literal('queued')
        })
    },
    'turn/interrupt': {
        params: O({
            threadId: Id, key: Id
        }), result: O({
            inputId: Id
        })
    },
    'turn/list': {
        params: O({
            threadId: Id, ...page
        }), result: O({
            turns: Type.Array(TurnSchema), nextCursor: Type.Union([Id, Type.Null()])
        })
    },
} as const;
