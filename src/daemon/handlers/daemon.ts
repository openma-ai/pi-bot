import { reactionUserActor } from '../../pi/message-reactions.ts';
import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { PiBotError } from '../core/errors.ts';
import type { Thread, Turn } from '../../sdk/protocol/models.ts';
export async function daemonHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'daemon/status': return {
            status: d.status, startedAt: d.startedAt, protocolVersion: '2026-10-13', loadedThreads: s.list<Thread>('threads').filter(t => t.status === 'loaded').length, activeTurns: s.list<Turn>('turns').filter(t => t.status === 'running').length, runningJobs: s.list<any>('jobs').filter(j => j.state === 'running').length, pendingRequests: d.broker.list().filter(q => q.status === 'pending').length, model: {
                id: d.live?.model ?? 'test', setupRequired: !!(d.live?.configuration as any)?.setupRequired
            }, budget: d.live?.budget
        };
        case 'daemon/snapshot': return { ...d.snapshot(p.botIds), viewerReactionActorId: reactionUserActor(c.fileOwner) };
        case 'daemon/shutdown':
            if (c.transport === 'browser')
                throw new PiBotError('forbidden', 'Shutdown requires a host connection');
            setImmediate(() => void d.close(p.drainTimeoutMs));
            return {};
    }
}
