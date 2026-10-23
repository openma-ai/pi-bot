import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { PiBotError } from '../core/errors.ts';
import { fileHandler } from './file.ts';
import { daemonHandler } from './daemon.ts';
import { eventsHandler } from './events.ts';
import { botHandler } from './bot.ts';
import { groupHandler } from './group.ts';
import { threadHandler } from './thread.ts';
import { turnHandler } from './turn.ts';
import { routineHandler } from './routine.ts';
import { jobHandler } from './job.ts';
import { requestHandler } from './request.ts';
import { taskHandler } from './task.ts';
import { desktopHandler } from './desktop.ts';
import { notificationHandler } from './notification.ts';
const handlers: Record<string, (d: PiBotDaemon, c: DaemonConnection, method: string, params: any) => Promise<any>> = {
    file: fileHandler, daemon: daemonHandler, events: eventsHandler, bot: botHandler, group: groupHandler, thread: threadHandler, turn: turnHandler, routine: routineHandler, job: jobHandler, request: requestHandler, task: taskHandler, desktop: desktopHandler, notification: notificationHandler
};
export function handleMethod(d: PiBotDaemon, c: DaemonConnection, method: string, params: any) {
    const handler = handlers[method.split('/')[0]];
    if (!handler)
        throw new PiBotError('invalidRequest', 'Method not implemented');
    return handler(d, c, method, params);
}
