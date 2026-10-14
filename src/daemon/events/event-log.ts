import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { EventEnvelope } from '../../sdk/protocol/notifications.ts';
import { redactTraceValue } from '../../pi/redact.ts';
import { PiBotError } from '../core/errors.ts';
export type Filter = {
    botIds?: string[];
    threadIds?: string[];
    methods?: string[];
};
export class EventLog {
    readonly context = new AsyncLocalStorage<{
        botId: string;
        threadId: string;
        turnId: string;
    }>();
    private listeners = new Set<(e: EventEnvelope) => void>();
    private ack = new Map<string, {
        seq: number;
        at: number;
    }>();
    constructor(readonly db: DatabaseSync) {
    }
    get seq() {
        return Number((this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get() as any).seq) || Number((this.db.prepare('SELECT floor FROM event_retention WHERE id=1').get() as any).floor);
    }
    append(method: string, params: Record<string, any>, scope?: {
        botId?: string;
        threadId?: string;
        turnId?: string;
    }) {
        const ctx = scope ?? this.context.getStore();
        const at = Date.now();
        const redacted: any = redactTraceValue(params);
        if (params.turn?.usage && redacted.turn?.usage)
            redacted.turn.usage.reasoning = Number(params.turn.usage.reasoning) || 0;
        const data = JSON.stringify(redacted);
        const r = this.db.prepare('INSERT INTO events(at,method,bot_id,thread_id,turn_id,data)VALUES(?,?,?,?,?,?)').run(at, method, ctx?.botId ?? null, ctx?.threadId ?? null, ctx?.turnId ?? null, data);
        const e = {
            seq: Number(r.lastInsertRowid), at, method, params: JSON.parse(data)
        };
        if (!this.db.isTransaction)
            this.publish(e);
        return e;
    }
    publish(e: EventEnvelope) {
        for (const f of this.listeners)
            try {
                f(e);
            }
            catch {
            }
    }
    publishAfter(after: number) {
        if (!this.listeners.size)
            return;
        for (const e of this.read(after))
            this.publish(e);
    }
    read(after: number, filter?: Filter): EventEnvelope[] {
        if (after < Number((this.db.prepare('SELECT floor FROM event_retention WHERE id=1').get() as any).floor))
            throw new PiBotError('cursorExpired', 'Event cursor expired');
        if (after > this.seq)
            throw new PiBotError('invalidParams', 'Event cursor is ahead of server');
        return (this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq').all(after) as any[]).map(r => ({
            seq: r.seq, at: r.at, method: r.method, params: JSON.parse(r.data)
        })).filter(e => this.matches(e, filter));
    }
    matches(e: EventEnvelope, f?: Filter) {
        const p = e.params;
        const entity = p.bot ?? p.thread ?? p.turn ?? p.item ?? p.request ?? p.job ?? p.routine ?? p.message;
        const saved = (f?.botIds || f?.threadIds) && e.seq !== null ? this.db.prepare('SELECT bot_id,thread_id FROM events WHERE seq=?').get(e.seq) as any : undefined;
        return (!f?.methods || f.methods.includes(e.method)) && (!f?.botIds || f.botIds.includes(p.botId ?? entity?.botId ?? saved?.bot_id)) && (!f?.threadIds || f.threadIds.includes(p.threadId ?? entity?.threadId ?? p.thread?.id ?? saved?.thread_id));
    }
    subscribe(after: number, listener: (e: EventEnvelope) => void, filter?: Filter) {
        const through = this.seq;
        const replay = this.read(after);
        const send = (e: EventEnvelope) => {
            if (this.matches(e, filter))
                listener(e);
            else if (e.seq !== null)
                listener({
                    seq: null, at: e.at, method: 'events/watermark', params: {
                        seq: e.seq
                    }
                });
        };
        // SQLite and this registration are synchronous: no commit can interleave the switch.
        this.listeners.add(send);
        for (const e of replay)
            send(e);
        return {
            through, close: () => this.listeners.delete(send)
        };
    }
    acknowledge(id: string, seq: number) {
        if (seq < 0 || seq > this.seq)
            throw new PiBotError('invalidParams', 'Invalid event acknowledgement');
        this.ack.set(id, {
            seq: Math.max(seq, this.ack.get(id)?.seq ?? 0), at: Date.now()
        });
    }
    forget(id: string) {
        this.ack.delete(id);
    }
    compact(now = Date.now(), maxAge = 7 * 86400000, maxCount = 1000000) {
        const rows = this.db.prepare('SELECT seq,at FROM events ORDER BY seq').all() as {
            seq: number;
            at: number;
        }[];
        const candidates = rows.filter((r, i) => r.at < now - maxAge || i < rows.length - maxCount);
        let cutoff = candidates.at(-1)?.seq ?? 0;
        for (const a of this.ack.values())
            if (now - a.at < 86400000)
                cutoff = Math.min(cutoff, a.seq);
        if (!cutoff)
            return;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('DELETE FROM events WHERE seq<=?').run(cutoff);
            this.db.prepare('UPDATE event_retention SET floor=max(floor,?) WHERE id=1').run(cutoff);
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
}
