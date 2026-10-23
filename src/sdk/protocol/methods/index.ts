import { fileMethods } from './file.ts';
import { initializeMethods } from './initialize.ts';
import { daemonMethods } from './daemon.ts';
import { eventsMethods } from './events.ts';
import { botMethods } from './bot.ts';
import { groupMethods } from './group.ts';
import { threadMethods } from './thread.ts';
import { turnMethods } from './turn.ts';
import { routineMethods } from './routine.ts';
import { jobMethods } from './job.ts';
import { requestMethods } from './request.ts';
import { taskMethods } from './task.ts';
import { desktopMethods } from './desktop.ts';
export const methodSchemas = {
    ...fileMethods, ...initializeMethods, ...daemonMethods, ...eventsMethods, ...botMethods, ...groupMethods, ...threadMethods, ...turnMethods, ...routineMethods, ...jobMethods, ...requestMethods, ...taskMethods, ...desktopMethods
} as const;
