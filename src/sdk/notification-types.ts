/** Transport-independent proactive notification contracts. No device tokens or native APIs. */
export type NotificationKind = 'action_required' | 'completion' | 'important_change';
export type NotificationPreferences = {
    id: string;
    enabled: boolean;
    timezone: string;
    quiet?: { startMinute: number; endMinute: number };
};
export type NotificationEntry = {
    id: string;
    ownerId: string;
    botId: string;
    threadId: string;
    sourceMessageId: string;
    taskId: string;
    kind: NotificationKind;
    reference: { table: 'requests' | 'outbox' | 'inbox'; id: string };
    summary: string;
    priority: 'normal' | 'action';
    createdAt: number;
    expiresAt: number;
    status: 'active' | 'read' | 'superseded' | 'resolved' | 'expired';
    readAt?: number;
    delivery: {
        state: 'queued' | 'deferred' | 'sending' | 'accepted' | 'retry' | 'uncertain' | 'failed' | 'suppressed';
        attempts: number;
        nextAttemptAt: number;
        adapterId?: string;
        attemptId?: string;
        acceptedAt?: number;
        reason?: string;
    };
};
export type NotificationDelivery = Pick<NotificationEntry, 'id' | 'ownerId' | 'botId' | 'threadId' | 'kind' | 'summary' | 'priority' | 'sourceMessageId' | 'expiresAt'> & {
    /** Stable across safe retries. Adapter acceptance is not a human read receipt. */
    idempotencyKey: string;
};
export type NotificationAdapterResult =
    | { status: 'accepted' }
    /** Definitive non-acceptance; only this result permits automatic bounded retry. */
    | { status: 'retry'; retryAfterMs?: number }
    | { status: 'failed' };
export interface NotificationAdapter {
    readonly id: string;
    deliver(notification: Readonly<NotificationDelivery>, signal: AbortSignal): Promise<NotificationAdapterResult>;
}
