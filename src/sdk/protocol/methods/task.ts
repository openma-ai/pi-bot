import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const taskMethods = {
    'task/reconcile': {
        params: O({
            inputId: Id
        }), result: O({
            outcome: Type.Union([Type.Literal('processed'), Type.Literal('queued')])
        })
    },
} as const;
