import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
export async function routineHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'routine/list': return {
            routines: d.snapshot().routines.filter((x: any) => (!p.botId || x.botId === p.botId) && (!p.kind || x.kind === p.kind))
        };
        case 'routine/create': return {
            routine: d.createRoutine(p)
        };
        case 'routine/dryRun': return d.routineAction('dry-run', p.routineId);
        case 'routine/pause':
        case 'routine/resume':
        case 'routine/enable':
        case 'routine/cancel': return {
            routine: await d.routineAction(method.split('/')[1], p.routineId)
        };
    }
}
