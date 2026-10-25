import { Type } from 'typebox';
import { AvatarSchema } from '../models.ts';
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
            key:Type.Optional(Type.String({minLength:1,maxLength:128,pattern:'^[a-zA-Z0-9_-]+$'})),
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
            botId: Id, avatar: Type.Optional(Type.Union([AvatarSchema, Type.Null()])), name: Type.Optional(Type.String({
                minLength: 1, maxLength: 100, pattern: '\\S'
            })), description: Type.Optional(Type.String({
                maxLength: 2000
            }))
        }), result: O({
            bot: BotSchema
        })
    },
    'bot/avatarUpload': {
        params: O({
            botId: Id, mime: literals(['image/png', 'image/jpeg', 'image/webp']), data: Type.String({
                minLength: 1, maxLength: 699052, pattern: '^[A-Za-z0-9+/]+={0,2}$'
            })
        }),
        result: O({
            bot: BotSchema
        })
    }
} as const;
