import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const botMethods = {
    'bot/list': {
        params: empty, result: O({
            bots: Type.Array(BotSchema)
        })
    },
    'bot/read': {
        params: O({
            botId: Id
        }), result: O({
            bot: BotSchema, threads: Type.Array(ThreadSchema), state: Json
        })
    },
    'bot/create': {
        params: O({
            name: Type.String({
                minLength: 1, maxLength: 100, pattern: '\\S'
            }), description: Type.Optional(Type.String({
                maxLength: 2000
            })), channelId: optId
        }), result: O({
            bot: BotSchema
        })
    },
    'bot/update': {
        params: O({
            botId: Id, name: Type.Optional(Type.String({
                minLength: 1, maxLength: 100, pattern: '\\S'
            })), description: Type.Optional(Type.String({
                maxLength: 2000
            }))
        }), result: O({
            bot: BotSchema
        })
    },
} as const;
