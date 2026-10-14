import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const requestMethods = {
    'request/list': {
        params: O({
            status: Type.Optional(Type.Literal('pending')), threadId: optId
        }), result: O({
            requests: Type.Array(PendingRequestSchema)
        })
    },
    'request/resolve': {
        params: O({
            requestId: Id, response: Type.Union([O({
                    decision: literals(['approve', 'deny']), note: Type.Optional(Type.String({
                        maxLength: 2000
                    }))
                }), O({
                    text: Type.String({
                        minLength: 1, maxLength: 4000
                    })
                }), O({
                    submitted: Type.Literal(true)
                })])
        }), result: O({
            request: PendingRequestSchema
        })
    },
} as const;
