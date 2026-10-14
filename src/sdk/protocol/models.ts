import { Type, type Static } from 'typebox';
export const Id = Type.String({
    minLength: 1, maxLength: 512
});
export const Time = Type.Integer({
    minimum: 0
});
export const Json = Type.Record(Type.String(), Type.Unknown());
import { literals } from './literals.ts';
export const DaemonStatusSchema = literals(['starting', 'recovering', 'ready', 'draining', 'stopped']);
export type DaemonStatus = Static<typeof DaemonStatusSchema>;
export const RequestKindSchema = literals(['approval', 'question', 'credential']);
export type RequestKind = Static<typeof RequestKindSchema>;
export const AvatarSchema = Type.Object({
    shape: Type.Integer({
        minimum: 0, maximum: 12
    }), color: Type.String({
        pattern: '^#[a-fA-F0-9]{6}$'
    }), picture: Type.Optional(Type.String({
        pattern: '^[a-f0-9]{64}$'
    }))
}, {
    additionalProperties: false
});
export const BotSchema = Type.Object({
    avatar: Type.Optional(Type.Union([AvatarSchema, Type.Null()])),
    id: Id, name: Type.String(), description: Type.String(), createdAt: Time, sessionFile: Type.Union([Type.String(), Type.Null()]), sessionFiles: Type.Optional(Type.Record(Type.String(), Type.String())), channelId: Type.Optional(Id), groupIds: Type.Optional(Type.Array(Id))
});
export const GroupSchema = Type.Object({
    id: Id, name: Type.String(), memberIds: Type.Array(Id), createdAt: Time
});
export const ScopeSchema = Type.Object({
    channelId: Type.Union([Id, Type.Null()]), conversationId: Type.Union([Id, Type.Null()]), threadId: Type.Union([Id, Type.Null()])
});
export const ThreadSchema = Type.Object({
    id: Id, botId: Id, scope: ScopeSchema, scopeKey: Type.String(), status: literals(['stored', 'loaded', 'archived']), activeTurnId: Type.Union([Id, Type.Null()]), lastActivityAt: Time, createdAt: Time
});
export type Thread = Static<typeof ThreadSchema>;
export const UsageSchema = Type.Object({
    input: Time, output: Time, cacheRead: Time, reasoning: Time, totalTokens: Time, costUsd: Type.Number({
        minimum: 0
    })
});
export type Usage = Static<typeof UsageSchema>;
export const TurnSchema = Type.Object({
    id: Id, threadId: Id, botId: Id, trigger: literals(['user', 'answer', 'bot', 'job', 'schedule', 'monitor', 'research', 'memory']), status: literals(['queued', 'running', 'completed', 'yielded', 'interrupted', 'uncertain', 'failed']), primaryInputId: Id, inputIds: Type.Array(Id), taskId: Id, startedAt: Type.Union([Time, Type.Null()]), endedAt: Type.Union([Time, Type.Null()]), usage: Type.Union([UsageSchema, Type.Null()]), error: Type.Union([Json, Type.Null()])
});
export type Turn = Static<typeof TurnSchema>;
export const ItemSchema = Type.Object({
    id: Id, type: literals(['inputMessage', 'agentMessage', 'peerMessage', 'toolCall', 'job', 'request', 'compaction', 'internalNote']), threadId: Id, turnId: Type.Union([Id, Type.Null()]), status: literals(['inProgress', 'completed']), text: Type.Optional(Type.String()), toolCallId: Type.Optional(Id), botId: Type.Optional(Id), message: Type.Optional(Json)
}, {
    additionalProperties: true
});
export type Item = Static<typeof ItemSchema> & Record<string, unknown>;
export const PendingRequestSchema = Type.Object({
    id: Id, kind: RequestKindSchema, botId: Id, threadId: Id, turnId: Type.Union([Id, Type.Null()]), params: Json, status: literals(['pending', 'resolved', 'expired', 'cancelled']), createdAt: Time, expiresAt: Type.Union([Time, Type.Null()]), response: Type.Optional(Json), resolvedBy: Type.Optional(Id), resolvedAt: Type.Optional(Time)
});
export type PendingRequest = Static<typeof PendingRequestSchema>;
export const RoutineSchema = Type.Object({
    id: Id, botId: Id, kind: literals(['schedule', 'monitor']), state: Type.String(), prompt: Type.String()
}, {
    additionalProperties: true
});
export const JobSummarySchema = Type.Object({
    id: Id, botId: Id, tool: Id, state: Type.String(), taskId: Id, messageId: Id, error: Type.Optional(Type.String()), threadId: Type.Optional(Id)
}, {
    additionalProperties: true
});
export const TriggerStatusSchema = Type.Object({
    implementation: Type.String(), halted: Type.Boolean(), queued: Type.Integer({
        minimum: 0
    })
});
export const SnapshotSchema = Type.Object({
    trigger: Type.Optional(TriggerStatusSchema), seq: Time, bots: Type.Array(BotSchema), groups: Type.Array(GroupSchema), threads: Type.Array(ThreadSchema), turns: Type.Array(TurnSchema), activeTurns: Type.Array(TurnSchema), items: Type.Array(ItemSchema), pendingRequests: Type.Array(PendingRequestSchema), requests: Type.Array(PendingRequestSchema), routines: Type.Array(RoutineSchema), jobs: Type.Array(JobSummarySchema), budget: Type.Optional(Json), usage: UsageSchema, status: DaemonStatusSchema
}, {
    additionalProperties: true
});
export type Snapshot = Static<typeof SnapshotSchema>;
