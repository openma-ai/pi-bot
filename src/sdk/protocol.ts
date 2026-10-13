/**
 * Pi Bot daemon wire protocol (HTTP JSON API).
 *
 * Browser-safe and type-only. Domain records come from the plugin contract
 * (`src/pi/types.ts`) via type-only re-exports, so importing this module never
 * pulls in Pi, Node or daemon code.
 */
import type { Bot, BotStateSnapshot, ChatGroup, Monitor, Schedule } from '../pi/types.ts';
export type { Bot, BotStateSnapshot, ChatGroup, ChatRoute, Envelope, Job, Monitor, Outbound, Question, Schedule } from '../pi/types.ts';

/** Header carrying the per-process write token returned by `GET /api/state`. */
export const TOKEN_HEADER = 'x-gui-token';

/** Channel-scoped, redacted projection of a durable inbox/outbox record. */
export type ChannelMessage = {
    messageId: string;
    channelId: string;
    conversationId: string;
    threadId: string | null;
    direction: 'inbound' | 'outbound';
    sourceKind: string;
    sender: string;
    recipient: string;
    botId: string;
    taskId: string;
    causationId: string | null;
    text: string;
    status: string;
    receivedAt: number;
    admittedAt?: number;
    consumedAt?: number;
    resolvedAt?: number;
    deliveredAt?: number;
    deliveryTarget?: string;
    peerPriority?: string;
    groupMessageId?: string;
    mentions?: string[];
    groupAttention?: string;
    error?: string;
};

export type ModelUsage = {
    responses: number;
    input: number;
    output: number;
    cacheRead: number;
    reasoning: number;
    totalTokens: number;
    estimatedUsd: number;
};
export type ModelBudget = {
    requests: number;
    inputReserved: number;
    maxRequests: number;
    maxInput: number;
    expiresAt: number;
};
export type PublicConfiguration = {
    setupRequired?: boolean;
    message?: string;
    [key: string]: unknown;
};
export type JobSummary = {
    id: string;
    botId: string;
    tool: string;
    state: string;
    error?: string;
};
/** Per-bot ledger; `proactive` is replaced by live service views (no proposals/counts). */
export type BotState = Omit<BotStateSnapshot, 'proactive'> & {
    proactive: {
        schedules: Schedule[];
        monitors: Omit<Monitor, 'cursor' | 'baseline'>[];
    };
};
/** `GET /api/state` */
export type StateResponse = {
    mode: string;
    configuration?: PublicConfiguration;
    budget?: ModelBudget;
    usage: ModelUsage;
    watchFile: string;
    token: string;
    bots: Bot[];
    trigger: { implementation: string; halted: boolean; queued: number };
    groups: ChatGroup[];
    groupMessages: ChannelMessage[];
    messages: ChannelMessage[];
    errors: string[];
    jobs: JobSummary[];
    states: Record<string, BotState>;
};

/** `POST /api/message` */
export type SendMessageRequest = { to: string; text: string; key?: string; groupId?: string };
/** `POST /api/group` */
export type CreateGroupRequest = { name: string; memberIds: string[] };
/** `POST /api/bot` */
export type CreateBotRequest = { name: string };
export type RoutineKind = 'schedule' | 'monitor';
/** `POST /api/routine/create` */
export type CreateRoutineRequest = {
    kind: RoutineKind;
    botId: string;
    prompt: string;
    groupId?: string;
    /** schedule: first fire time (Unix ms) */
    at?: number;
    timezone?: string;
    intervalMs?: number;
    /** monitor: repository file to watch */
    filePath?: string;
    /** monitor: expiry (Unix ms) */
    deadline?: number;
};
export type ScheduleAction = 'pause' | 'resume' | 'cancel';
export type MonitorAction = 'dry-run' | 'enable' | 'pause' | 'cancel';
/** `POST /api/routine/action` */
export type RoutineActionRequest =
    | { kind: 'schedule'; botId: string; id: string; action: ScheduleAction }
    | { kind: 'monitor'; botId: string; id: string; action: MonitorAction };
/** `POST /api/job` */
export type JobResultRequest = { botId: string; id: string; offset?: number };
/** `POST /api/reconcile` */
export type ReconcileRequest = { id: string };
export type ReconcileResponse = { outcome: 'processed' | 'queued' };
/** `POST /api/answer` */
export type AnswerRequest = { id: string; text: string };
/** `POST /api/cancel` */
export type CancelRoutineRequest = { kind: RoutineKind; botId: string; id: string };
export type OkResponse = { ok: true };
export type ErrorResponse = { error: string };
