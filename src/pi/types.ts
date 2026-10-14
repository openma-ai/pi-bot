/**
 * Domain records shared by the Pi plugin layer and its hosts.
 * This module is the contract between `src/pi` (plugin) and any host (e.g. `src/daemon`).
 * Type-only: it must stay free of runtime imports.
 */
export type Bot = {
    id: string;
    name: string;
    description: string;
    sessionFile: string | null;
    createdAt: number;
    channelId?: string;
    groupIds?: string[];
    sessionFiles?: Record<string, string>;
    avatar?: {
        shape: number;
        color: string;
        picture?: string;
    } | null;
};
export type ChatGroup = {
    id: string;
    name: string;
    memberIds: string[];
    createdAt: number;
};
/** Host-bound chat routing. Models cannot select an outbound channel. */
export type ChatRoute = {
    channelId: string;
    conversationId?: string;
    threadId: string;
    senderId: string;
};
export type Envelope = {
    id: string;
    from: string;
    to: string;
    kind: 'user' | 'bot' | 'answer' | 'job' | 'schedule' | 'monitor' | 'research' | 'memory';
    deferredContinuation?: boolean;
    groupMessageId?: string;
    mentions?: string[];
    groupAttention?: 'normal' | 'mention';
    peerPriority?: 'normal' | 'urgent';
    deliveryTarget?: 'direct' | 'group';
    triggerCancelled?: boolean;
    text: string;
    taskId: string;
    replyTo: string | null;
    hop: number;
    key: string;
    state: 'queued' | 'processing' | 'processed' | 'uncertain' | 'failed';
    createdAt: number;
    admittedAt?: number;
    consumedAt?: number;
    resolvedAt?: number;
    resolution?: {
        attempt?: number;
        owner: string;
        evidence: string[];
        note?: string;
    };
    error?: string;
    route?: ChatRoute;
    taskControl?: 'replace' | 'cancel';
};
export type Job = {
    id: string;
    botId: string;
    taskId: string;
    messageId: string;
    key: string;
    tool: string;
    args: unknown;
    state: 'running' | 'completed' | 'failed' | 'uncertain';
    result?: string;
    error?: string;
    createdAt: number;
    quiet?: boolean;
    completedAt?: number;
    generation?: string;
    attempt?: number;
    owner?: string;
};
export type Question = {
    id: string;
    botId: string;
    taskId: string;
    messageId: string;
    key: string;
    text: string;
    choices?: string[];
    state: 'pending' | 'answered';
    answer?: string;
    createdAt: number;
};
export type Outbound = {
    toolCallId?: string;
    id: string;
    botId: string;
    taskId: string;
    replyTo: string | null;
    key: string;
    text: string;
    state: 'pending' | 'sending' | 'delivered' | 'uncertain' | 'superseded';
    createdAt: number;
    deliveredAt?: number;
    route?: ChatRoute;
};
/** Fields shared by every host-persisted trigger. */
export type TriggerBase = {
    id: string;
    botId: string;
    sourceId: string;
    key: string;
    prompt: string;
    revision: number;
    createdAt: number;
};
export type Schedule = TriggerBase & {
    state: 'active' | 'paused' | 'completed' | 'cancelled';
    timezone: string;
    nextFire: number;
    firstFire: number;
    intervalMs?: number;
    misfire: 'skip' | 'coalesce' | 'catchup';
    overlap: 'queue' | 'skip';
    lastSkip?: {
        dueAt: number;
        at: number;
        reason: 'misfire' | 'overlap';
        missedPeriods: number;
    };
};
export type Monitor = TriggerBase & {
    detector: string;
    enabled: boolean;
    state: 'active' | 'expired' | 'cancelled';
    intervalMs: number;
    deadline: number;
    nextCheck: number;
    cursor?: unknown;
    baseline?: unknown;
    lastDecision?: 'silent' | 'wake' | 'error';
    error?: string;
    generation?: string;
    dryRunVerified?: boolean;
};
export type Fire = {
    id: string;
    botId: string;
    triggerId: string;
    revision: number;
    eventKey: string;
    inboxId: string;
    dueAt: number;
    firedAt: number;
};
export type Detection = {
    decision: 'silent' | 'wake' | 'error';
    cursor?: unknown;
    baseline?: unknown;
    dedupKey?: string;
    payload?: string;
    error?: string;
};
export type Candidate = {
    text: string;
    evidenceRefs: string[];
};
export type Proposal = {
    id: string;
    botId: string;
    sourceId: string;
    key: string;
    kind: 'research' | 'memory';
    memoryKey?: string;
    snapshotVersion: number;
    evidenceRefs: string[];
    evidenceHash: string;
    state: 'running' | 'approved' | 'rejected' | 'applied' | 'uncertain' | 'cancelled';
    candidate?: Candidate;
    review?: {
        approved: boolean;
        reason: string;
    };
    jobId?: string;
    appliedVersion?: number;
    consumedAt?: number;
    resultInboxId?: string;
};
export type MemoryRecord = {
    id: string;
    botId: string;
    key: string;
    version: number;
    text: string;
    proposalId: string;
    evidenceRefs: string[];
};
/** Read-only snapshot of a bot's durable ledger, as exposed to the model. */
export type BotStateSnapshot = {
    jobs: any[];
    questions: any[];
    inbox: any[];
    outbox: any[];
    counts: {
        jobs: number;
        questions: number;
        inbox: number;
        outbox: number;
    };
    proactive: {
        schedules: any[];
        monitors: any[];
        proposals: any[];
        counts: {
            schedules: number;
            monitors: number;
            proposals: number;
        };
    };
};
/** One page of a durable job result. */
export type JobResultPage = {
    id: string;
    state: string;
    error: string | null;
    total: number;
    text: string | null;
    offset: number;
    next: number | null;
};
