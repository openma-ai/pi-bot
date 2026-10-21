import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import type { Envelope } from '../../pi/types.ts';
import type { Thread } from '../../sdk/protocol/models.ts';
import { PiBotError } from '../core/errors.ts';
export function requestFileScope(d: PiBotDaemon, p: any) {
    const bot: any = d.required('bots', p.botId);
    let route: Envelope['route'] = bot.channelId ? {
        channelId: bot.channelId, conversationId: bot.channelId, threadId: 'gui', senderId: 'user'
    } : undefined;
    if (p.groupId) {
        const group: any = d.required('groups', p.groupId);
        if (!group.memberIds.includes(p.botId))
            throw new PiBotError('forbidden', 'Bot not in group');
        route = {
            channelId: p.groupId, conversationId: p.groupId, threadId: 'gui', senderId: 'user'
        };
    }
    else if (p.threadId) {
        const thread = d.required<Thread>('threads', p.threadId);
        if (thread.botId !== p.botId)
            throw new PiBotError('forbidden', 'Wrong thread');
        route = thread.scope.channelId ? {
            channelId: thread.scope.channelId, conversationId: thread.scope.conversationId ?? thread.scope.channelId, threadId: thread.scope.threadId ?? '', senderId: 'user'
        } : undefined;
    }
    return d.runtime.fileScope({
        to: p.botId, route
    });
}
export async function fileHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any) {
    const owner = c.fileOwner, scope = requestFileScope(d, p), v = d.runtime.files;
    switch (method) {
        case 'file/begin': return {
            file: v.begin(owner, scope, p.name, p.mime, p.size)
        };
        case 'file/append': return v.append(owner, scope, p.id, p.offset, p.data);
        case 'file/finish': return {
            file: v.finish(owner, scope, p.id, p.sha256)
        };
        case 'file/read': return v.read(owner, scope, p.id, p.offset);
        case 'file/cancel': return v.remove(owner, scope, p.id);
    }
}
