import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const routineMethods = {
    'routine/list': {
        params: O({
            botId: optId, kind: Type.Optional(Type.Union([Type.Literal('schedule'), Type.Literal('monitor')]))
        }), result: O({
            routines: Type.Array(RoutineSchema)
        })
    },
    'routine/create': {
        params: Type.Union([O({
                kind: Type.Literal('schedule'), botId: Id, prompt: Type.String({
                    minLength: 1, maxLength: 20000
                }), key: optId, at: Time, timezone: Id, intervalMs: Type.Optional(Type.Integer({
                    minimum: 1000
                })), groupId: optId
            }), O({
                kind: Type.Literal('monitor'), botId: Id, prompt: Type.String({
                    minLength: 1, maxLength: 20000
                }), key: optId, filePath: Type.Optional(Type.String()), intervalMs: Type.Integer({
                    minimum: 1000
                }), deadline: Time, groupId: optId
            })]), result: O({
            routine: RoutineSchema
        })
    },
    'routine/pause': {
        params: O({
            routineId: Id
        }), result: O({
            routine: RoutineSchema
        })
    },
    'routine/resume': {
        params: O({
            routineId: Id
        }), result: O({
            routine: RoutineSchema
        })
    },
    'routine/cancel': {
        params: O({
            routineId: Id
        }), result: O({
            routine: RoutineSchema
        })
    },
    'routine/enable': {
        params: O({
            routineId: Id
        }), result: O({
            routine: RoutineSchema
        })
    },
    'routine/dryRun': {
        params: O({
            routineId: Id
        }), result: O({
            decision: literals(['silent', 'wake', 'error']), error: Type.Optional(Type.String())
        })
    },
} as const;
