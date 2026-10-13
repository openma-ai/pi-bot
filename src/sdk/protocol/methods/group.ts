import { Type } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
import { literals } from '../literals.ts';
import { O, empty, optId, limit, page, ok, filter } from './shared.ts';
export const groupMethods = {
    'group/list': {
        params: empty, result: O({
            groups: Type.Array(GroupSchema)
        })
    },
    'group/create': {
        params: O({
            name: Type.String({
                minLength: 1, maxLength: 100, pattern: '\\S'
            }), memberIds: Type.Array(Id, {
                minItems: 2, uniqueItems: true
            })
        }), result: O({
            group: GroupSchema
        })
    },
    'group/update': {
        params: O({
            groupId: Id, name: Type.Optional(Type.String({
                minLength: 1, maxLength: 100, pattern: '\\S'
            })), addMemberIds: Type.Optional(Type.Array(Id, {
                uniqueItems: true
            })), removeMemberIds: Type.Optional(Type.Array(Id, {
                uniqueItems: true
            }))
        }), result: O({
            group: GroupSchema
        })
    },
} as const;
