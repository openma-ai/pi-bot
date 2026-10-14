import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const threadMethods = {
    'thread/list': {
        params: O({
            botId: optId, status: Type.Optional(literals(['stored', 'loaded', 'archived'])), ...page
        }), result: O({
            threads: Type.Array(ThreadSchema), nextCursor: Type.Union([Id, Type.Null()])
        })
    },
    'thread/read': {
        params: O({
            threadId: Id, cursor: optId, limit: limit(200)
        }), result: O({
            thread: ThreadSchema, turns: Type.Array(TurnSchema), items: Type.Array(ItemSchema), seq: Time, nextCursor: Type.Union([Id, Type.Null()])
        })
    },
    'thread/archive': {
        params: O({
            threadId: Id
        }), result: O({
            thread: ThreadSchema
        })
    },
    'thread/unarchive': {
        params: O({
            threadId: Id
        }), result: O({
            thread: ThreadSchema
        })
    },
    'thread/unload': {
        params: O({
            threadId: Id
        }), result: O({
            unloaded: Type.Boolean(), blockedBy: Type.Optional(Type.Array(Id))
        })
    },
} as const;
