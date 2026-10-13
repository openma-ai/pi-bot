import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
export async function eventsHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'events/subscribe': return c.subscribe(p.after, p.filter);
        case 'events/unsubscribe':
            c.unsubscribe(p.subscriptionId);
            return {};
        case 'events/ack':
            d.log.acknowledge(c.id, p.seq);
            return {};
    }
}
