import { PiBotError } from '../core/errors.ts';
import { DatabaseSync } from 'node:sqlite';
import type { Envelope, Outbound } from './store.ts';
import type { ChannelMessage } from '../../sdk/protocol.ts';
export type { ChannelMessage } from '../../sdk/protocol.ts';
import { redactChannelText } from '../../pi/redact.ts';
export { redactChannelText };
export function projectChannelMessage(table: 'inbox' | 'outbox', value: Envelope | Outbound): ChannelMessage {
    const incoming = table === 'inbox', e = value as Envelope, o = value as Outbound;
    const botId = incoming ? e.to : o.botId;
    const channelId = value.route?.channelId ?? `local:${botId}`;
    return {
        messageId: value.id, channelId, conversationId: value.route?.conversationId ?? channelId, threadId: value.route?.threadId ?? null, direction: incoming ? 'inbound' : 'outbound', sourceKind: incoming ? e.kind : 'bot', sender: incoming ? e.from : o.botId, recipient: incoming ? e.to : value.route?.senderId ?? 'user', botId, taskId: value.taskId, causationId: value.replyTo, text: redactChannelText(value.text), status: value.state, receivedAt: value.createdAt, ...(incoming ? {
            groupMessageId: e.groupMessageId, mentions: e.mentions, groupAttention: e.groupAttention, admittedAt: e.admittedAt, consumedAt: e.consumedAt, resolvedAt: e.resolvedAt, deliveryTarget: e.deliveryTarget, peerPriority: e.peerPriority, error: e.error ? redactChannelText(e.error) : undefined
        } : {
            deliveredAt: o.deliveredAt
        })
    };
}
type Query = {
    channelId: string;
    conversationId?: string;
    threadId?: string;
    botId?: string;
    direction?: ChannelMessage['direction'];
    after?: string;
    limit?: number;
};
/** Local GUI SDK. Read-only connection, explicit channel allowlist, no listening socket. */
export class ChannelMessageReader {
    private readonly db: DatabaseSync;
    constructor(path: string, private scope: {
        channels: string[];
        botIds?: string[];
    }) {
        if (!scope.channels.length)
            throw new PiBotError('invalidParams', 'Explicit channel scope required');
        this.db = new DatabaseSync(path, {
            readOnly: true
        });
        this.db.exec('PRAGMA query_only=ON');
    }
    private query(input: Query, changes: boolean) {
        if (!this.scope.channels.includes(input.channelId) || (input.botId && this.scope.botIds && !this.scope.botIds.includes(input.botId)))
            throw new PiBotError('forbidden', 'Channel query outside scope');
        const after = input.after ?? '0';
        if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
            throw new PiBotError('invalidParams', 'Invalid cursor');
        const limit = input.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
            throw new PiBotError('invalidParams', 'Invalid page limit');
        const conditions = ["json_extract(data,'$.channelId')=?", 'seq>?'];
        const args: (string | number)[] = [input.channelId, Number(after)];
        for (const field of ['conversationId', 'threadId', 'botId', 'direction'] as const)
            if (input[field] !== undefined) {
                conditions.push(`json_extract(data,'$.${field}')=?`);
                args.push(input[field]!);
            }
        if (this.scope.botIds) {
            conditions.push(`json_extract(data,'$.botId') IN (${this.scope.botIds.map(() => '?').join(',') || 'NULL'})`);
            args.push(...this.scope.botIds);
        }
        const table = changes ? 'channel_message_events' : 'channel_messages';
        this.db.exec('BEGIN');
        try {
            const rows = this.db.prepare(`SELECT seq,data,${changes ? 'seq' : 'updated_seq'} AS revision FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args, limit + 1) as {
                seq: number;
                data: string;
                revision: number;
            }[];
            const page = rows.slice(0, limit);
            const watermark = this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM channel_message_events').get() as {
                seq: number;
            };
            this.db.exec('COMMIT');
            return {
                items: page.map(row => ({
                    ...JSON.parse(row.data) as ChannelMessage, sequence: row.seq, revision: row.revision
                })), nextCursor: String(page.at(-1)?.seq ?? after), hasMore: rows.length > limit, changeCursor: String(watermark.seq)
            };
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    list(input: Query) {
        return this.query(input, false);
    }
    changes(input: Query) {
        return this.query(input, true);
    }
    close() {
        this.db.close();
    }
}
