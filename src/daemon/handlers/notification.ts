import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';

/** Owner comes only from authenticated transport. No shared event-log payloads. */
export async function notificationHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any) {
    const owner = c.fileOwner;
    switch (method) {
        case 'notification/list': return { notifications: d.notifications.list(owner) };
        case 'notification/read': return { notification: d.notifications.read(owner, p.notificationId) };
        case 'notification/preferences': return { preferences: d.notifications.preferences(owner) };
        case 'notification/configure': return { preferences: d.notifications.setPreferences(owner, p) };
    }
}
