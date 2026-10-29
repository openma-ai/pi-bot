import { createHash } from 'node:crypto';
import type { HostStore } from './host.ts';
import type { Envelope, Outbound, MessageReaction } from './types.ts';

export type ReactionTarget = {
    messageId: string; direction: 'inbound' | 'outbound'; channelId: string;
    conversationId: string; threadId: string | null;
};
export type ReactionChange = ReactionTarget & { emoji: string; present: boolean };
export class MessageReactionError extends Error {
    constructor(readonly reason: 'invalidParams' | 'forbidden' | 'notFound' | 'capacity', message: string) { super(message); }
}
/** Stable pseudonym for an authenticated transport identity; never an RPC field. */
export const reactionUserActor = (identity: string) => 'user:' + createHash('sha256').update('pibo-reaction-v1\0' + identity).digest('hex').slice(0, 32);
const scope = (value: any, incoming: boolean) => {
    const channelId = value.route?.channelId ?? `local:${incoming ? value.to : value.botId}`;
    return { channelId, conversationId: value.route?.conversationId ?? channelId, threadId: value.route?.threadId ?? null };
};
const sameScope = (a: any, b: any) => ['channelId', 'conversationId', 'threadId'].every(k => a[k] === b[k]);
export function validReactionEmoji(emoji: string) {
    return typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 32 &&
        [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(emoji)].length === 1 &&
        (/\p{Extended_Pictographic}/u.test(emoji) || /^\p{Regional_Indicator}{2}$/u.test(emoji) || /^[#*0-9]\ufe0f?\u20e3$/u.test(emoji)) &&
        /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f]+$/u.test(emoji);
}

/** JSON-envelope extension: old messages default to [], with no destructive migration. */
export function setMessageReaction(store: HostStore, change: ReactionChange, actorId: string, source?: Envelope) {
    if (!validReactionEmoji(change.emoji) || typeof change.present !== 'boolean' || !['inbound', 'outbound'].includes(change.direction))
        throw new MessageReactionError('invalidParams', 'Use one emoji and an explicit reaction state');
    return store.transaction(() => {
        const incoming = change.direction === 'inbound', table = incoming ? 'inbox' : 'outbox';
        const envelope = store.get<any>(table, change.messageId);
        // A group input has one public id and a per-bot inbox id. Resolve both to
        // the public record so an agent cannot create divergent reaction copies.
        const group = store.get<any>('group_messages', incoming && envelope?.groupMessageId ? envelope.groupMessageId : change.messageId);
        const publicGroup = group?.direction === change.direction && !!store.get('groups', group.channelId);
        const value = publicGroup && incoming ? group : envelope;
        if (!value) throw new MessageReactionError('notFound', 'Message no longer exists');
        const targetScope = publicGroup ? { ...group, threadId: group.threadId ?? null } : scope(value, incoming);
        if (!sameScope(change, targetScope)) throw new MessageReactionError('forbidden', 'Message belongs to another conversation');
        if (!publicGroup && incoming && !['user', 'answer'].includes(value.kind))
            throw new MessageReactionError('forbidden', 'Internal runtime input cannot receive a chat reaction');
        if (source) {
            const stored = store.get<Envelope>('inbox', source.id);
            if (!stored || stored.to !== source.to || !sameScope(scope(stored, true), scope(source, true)) || !sameScope(scope(source, true), targetScope))
                throw new MessageReactionError('forbidden', 'Reaction is outside the current conversation');
            if (publicGroup) {
                if (!store.get<any>('groups', group.channelId)?.memberIds.includes(source.to))
                    throw new MessageReactionError('forbidden', 'Bot is not a current group member');
            } else if ((incoming ? value.to : value.botId) !== source.to) {
                throw new MessageReactionError('forbidden', 'Message belongs to another bot');
            }
        }
        const previous: MessageReaction[] = value.reactions ?? [];
        const found = previous.some(r => r.actorId === actorId && r.emoji === change.emoji);
        if (found === change.present) return { changed: false, reactions: previous, actorId };
        if (change.present && (previous.length >= 256 || previous.filter(r => r.actorId === actorId).length >= 12))
            throw new MessageReactionError('capacity', 'Reaction limit reached');
        const reactions = change.present ? [...previous, { actorId, emoji: change.emoji, createdAt: Date.now() }] : previous.filter(r => r.actorId !== actorId || r.emoji !== change.emoji);
        if (publicGroup && incoming) {
            store.put('group_messages', { ...group, reactions }, { replaceReactions: true });
            // Canonical group input fans out to several bot inboxes. Update each
            // existing mirror without creating input, waking inference or changing text.
            for (const item of store.list<Envelope>('inbox'))
                if (item.groupMessageId === group.messageId && sameScope(scope(item, true), targetScope)) store.put('inbox', { ...item, reactions }, { replaceReactions: true });
        } else {
            store.put(table, { ...(value as Envelope | Outbound), reactions }, { replaceReactions: true });
        }
        return { changed: true, reactions, actorId };
    });
}

export function setAgentMessageReaction(store: HostStore, source: Envelope, target: Pick<ReactionChange, 'messageId' | 'direction' | 'emoji' | 'present'>) {
    return setMessageReaction(store, { ...scope(source, true), ...target }, 'bot:' + source.to, source);
}
