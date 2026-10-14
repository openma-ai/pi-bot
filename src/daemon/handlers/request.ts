import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
export async function requestHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'request/list': return {
            requests: d.broker.list().filter(q => (!p.status || q.status === p.status) && (!p.threadId || q.threadId === p.threadId))
        };
        case 'request/resolve': return {
            request: d.broker.resolve(p.requestId, p.response, c.id)
        };
    }
}
