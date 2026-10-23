import { Type } from 'typebox';
import { Id } from '../models.ts';
import { NotificationConfigurationSchema, NotificationEntrySchema, NotificationPreferencesSchema } from '../notification-center.ts';
import { O, empty } from './shared.ts';

export const notificationMethods = {
    'notification/list': {
        params: empty, result: O({ notifications: Type.Array(NotificationEntrySchema) })
    },
    'notification/read': {
        params: O({ notificationId: Id }), result: O({ notification: NotificationEntrySchema })
    },
    'notification/preferences': {
        params: empty, result: O({ preferences: NotificationPreferencesSchema })
    },
    'notification/configure': {
        params: NotificationConfigurationSchema, result: O({ preferences: NotificationPreferencesSchema })
    }
} as const;
