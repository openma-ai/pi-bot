import { PiBotError } from '../core/errors.ts';
import type { Bot } from './store.ts';
/** Host parses addressing from prose only; quoted/code mentions are inert. */
export function groupMentions(text: string, members: Pick<Bot, 'id' | 'name'>[]) {
    const prose = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`]*`/g, '').replace(/^\s*>.*$/gm, '');
    const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const names = ['全体成员', ...members.map(b => b.name)].sort((a, b) => b.length - a.length);
    const expression = new RegExp('(^|\\s)@(' + names.map(escaped).join('|') + ')(?=$|[\\s，,:：。.!！？?])', 'gu');
    const ids = new Set<string>();
    let all = false;
    const remainder = prose.replace(expression, (_match, space: string, name: string) => {
        if (name === '全体成员') {
            all = true;
            for (const member of members)
                ids.add(member.id);
        }
        else {
            const matches = members.filter(b => b.name === name);
            if (matches.length !== 1)
                throw new PiBotError('invalidParams', '被 @ 的 bot 名称不唯一');
            ids.add(matches[0].id);
        }
        return space;
    });
    if (/(^|\s)@[^\s，,:：。!！？?]+/u.test(remainder))
        throw new PiBotError('invalidParams', '找不到被 @ 的群成员');
    return {
        ids: [...ids], all
    };
}
