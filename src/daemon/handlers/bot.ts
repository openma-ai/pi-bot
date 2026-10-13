import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import type { Thread } from '../../sdk/protocol/models.ts';
export async function botHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'bot/list': return {
            bots: r.listBots()
        };
        case 'bot/read': return {
            bot: d.required('bots', p.botId), threads: s.list<Thread>('threads').filter(t => t.botId === p.botId), state: s.state(p.botId)
        };
        case 'bot/create': return {
            bot: r.createBot(p.name, p.description, p.channelId)
        };
        case 'bot/update': {
            const old: any = d.required('bots', p.botId);
            const bot = {
                ...old, ...(p.name !== undefined ? {
                    name: p.name
                } : {}), ...(p.description !== undefined ? {
                    description: p.description
                } : {})
            };
            s.put('bots', bot);
            return {
                bot
            };
        }
    }
}
