import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { PiBotError } from '../core/errors.ts';
export async function groupHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'group/list': return {
            groups: r.listGroups()
        };
        case 'group/create': return {
            group: r.createGroup(p.name, p.memberIds)
        };
        case 'group/update': {
            const old: any = d.required('groups', p.groupId);
            const members = [...new Set([...old.memberIds, ...p.addMemberIds ?? []])].filter(id => !p.removeMemberIds?.includes(id));
            if (members.length < 2 || members.some(id => !s.get('bots', id)))
                throw new PiBotError('invalidParams', 'Group needs valid members');
            const group = {
                ...old, name: p.name ?? old.name, memberIds: members
            };
            s.transaction(() => {
                s.put('groups', group);
                for (const bot of r.listBots()) {
                    const groupIds = (bot.groupIds ?? []).filter(id => id !== group.id);
                    if (members.includes(bot.id))
                        groupIds.push(group.id);
                    s.put('bots', {
                        ...bot, groupIds
                    });
                }
            });
            return {
                group
            };
        }
    }
}
