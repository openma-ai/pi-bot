import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import type { Thread } from '../../sdk/protocol/models.ts';
import { saveAvatar, avatarFile } from '../avatar-media.ts';
import { PiBotError } from '../core/errors.ts';
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
            bot: r.createBot(p.name, p.description, p.channelId, p.key)
        };
        case 'bot/update': {
            const old: any = d.required('bots', p.botId);
            if (p.avatar?.picture && !avatarFile(d.dataDir, p.avatar.picture))
                throw new PiBotError('notFound', '头像图片不存在，请重新上传');
            const bot = {
                ...old, ...(p.avatar !== undefined ? {
                    avatar: p.avatar
                } : {}), ...(p.name !== undefined ? {
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
        case 'bot/avatarUpload': {
            const old: any = d.required('bots', p.botId);
            const picture = saveAvatar(d.dataDir, p.mime, p.data);
            const bot = {
                ...old, avatar: {
                    shape: old.avatar?.shape ?? 0, color: old.avatar?.color ?? '#13b8a6', picture
                }
            };
            s.put('bots', bot);
            return {
                bot
            };
        }
    }
}
