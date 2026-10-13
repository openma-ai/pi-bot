import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { PiBotError } from '../core/errors.ts';
import type { Thread, Turn, Item } from '../../sdk/protocol/models.ts';
export async function threadHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'thread/list': {
            const page = d.page(s.list<Thread>('threads').filter(t => (!p.botId || t.botId === p.botId) && (!p.status || t.status === p.status)), p);
            return {
                threads: page.items, nextCursor: page.nextCursor
            };
        }
        case 'thread/read': {
            const thread = d.required<Thread>('threads', p.threadId);
            return s.transaction(() => {
                const page = d.page(s.list<Turn>('turns').filter(t => t.threadId === thread.id), p, 200);
                const turns = new Set(page.items.map(t => t.id));
                return {
                    thread, turns: page.items, items: s.list<Item>('items').filter(i => i.threadId === thread.id && (!i.turnId || turns.has(i.turnId))), seq: d.log.seq, nextCursor: page.nextCursor
                };
            });
        }
        case 'thread/archive':
        case 'thread/unarchive': {
            const thread = d.required<Thread>('threads', p.threadId);
            if (thread.status === 'loaded')
                throw new PiBotError('invalidRequest', 'Unload thread before archiving', {
                    cause: 'threadLoaded'
                });
            const next = {
                ...thread, status: method === 'thread/archive' ? 'archived' : 'stored'
            };
            s.put('threads', next);
            return {
                thread: next
            };
        }
        case 'thread/unload': return r.unloadThread(p.threadId);
    }
}
