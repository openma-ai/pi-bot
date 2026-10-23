import { Type } from 'typebox';
import { Id, Time } from './models.ts';
import { literals } from './literals.ts';
import { O } from './methods/shared.ts';

export const NotificationConfigurationSchema = O({
    enabled: Type.Boolean(), timezone: Id,
    quiet: Type.Optional(O({
        startMinute: Type.Integer({ minimum: 0, maximum: 1439 }),
        endMinute: Type.Integer({ minimum: 0, maximum: 1439 })
    }))
});
export const NotificationPreferencesSchema = O({
    id: Id, ...NotificationConfigurationSchema.properties
});
export const NotificationEntrySchema = O({
    id: Id, ownerId: Id, botId: Id, threadId: Id, sourceMessageId: Id, taskId: Id,
    kind: literals(['action_required', 'completion', 'important_change']),
    reference: O({ table: literals(['requests', 'outbox', 'inbox']), id: Id }),
    summary: Type.String(), priority: literals(['normal', 'action']),
    createdAt: Time, expiresAt: Time,
    status: literals(['active', 'read', 'superseded', 'resolved', 'expired']),
    readAt: Type.Optional(Time),
    delivery: O({
        state: literals(['queued', 'deferred', 'sending', 'accepted', 'retry', 'uncertain', 'failed', 'suppressed']),
        attempts: Type.Integer({ minimum: 0 }), nextAttemptAt: Time,
        adapterId: Type.Optional(Id), attemptId: Type.Optional(Id),
        acceptedAt: Type.Optional(Time), reason: Type.Optional(Type.String())
    })
});
