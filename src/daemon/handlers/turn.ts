import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { PiBotError } from '../core/errors.ts';
import type { Thread, Turn } from '../../sdk/protocol/models.ts';
import type { Envelope } from '../../pi/types.ts';
export async function turnHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'turn/start': return d.startTurn(p, c.fileOwner);
        case 'turn/steer':
        case 'turn/interrupt': {
            const thread = d.required<Thread>('threads', p.threadId);
            const input = s.list<Envelope>('inbox').filter(e => e.to === thread.botId && s.scopeForEnvelope(e) === thread.scopeKey).at(-1);
            if (!input)
                throw new PiBotError('notFound', 'Thread has no task');
            const e = r.accept({
                to: thread.botId, text: method === 'turn/interrupt' ? 'Cancel current task' : p.text, key: p.key, taskId: input.taskId, taskControl: method === 'turn/interrupt' ? 'cancel' : 'replace', route: input.route
            });
            return method === 'turn/interrupt' ? {
                inputId: e.id
            } : {
                inputId: e.id, threadId: thread.id, status: 'queued'
            };
        }
        case 'turn/list': {
            d.required('threads', p.threadId);
            const page = d.page(s.list<Turn>('turns').filter(t => t.threadId === p.threadId), p);
            return {
                turns: page.items, nextCursor: page.nextCursor
            };
        }
    }
}
