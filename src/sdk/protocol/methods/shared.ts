import { Type, type TSchema } from 'typebox';
import { Id, Time, Json, BotSchema, GroupSchema, ThreadSchema, TurnSchema, ItemSchema, PendingRequestSchema, RoutineSchema, JobSummarySchema, SnapshotSchema, DaemonStatusSchema, RequestKindSchema } from '../models.ts';
export const O = <const P extends Record<string, TSchema>>(p: P) => Type.Object(p, {
    additionalProperties: false
});
export const empty = O({}), optId = Type.Optional(Id), limit = (n: number) => Type.Optional(Type.Integer({
    minimum: 1, maximum: n
}));
export const page = {
    cursor: optId, limit: limit(100)
};
export const ok = empty;
export const filter = O({
    botIds: Type.Optional(Type.Array(Id)), threadIds: Type.Optional(Type.Array(Id)), methods: Type.Optional(Type.Array(Id))
});
