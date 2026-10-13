import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const jobMethods = {
    'job/list': {
        params: O({
            botId: optId, threadId: optId, state: optId
        }), result: O({
            jobs: Type.Array(JobSummarySchema)
        })
    },
    'job/read': {
        params: O({
            jobId: Id, offset: Type.Optional(Time), limit: limit(8000)
        }), result: Json
    },
} as const;
