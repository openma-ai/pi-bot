import { migrate } from '../migrations.ts';
import { EventLog } from '../events/event-log.ts';
import { derive } from '../events/derive.ts';
import type { Thread } from '../../sdk/protocol/models.ts';
import { threadId } from '../core/ids.ts';
import { PiBotError } from '../core/errors.ts';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { projectChannelMessage, redactChannelText } from './channel-messages.ts';
import type { Bot, Envelope, Job, Outbound, BotStateSnapshot, JobResultPage } from '../../pi/types.ts';
export type { Bot, ChatGroup, ChatRoute, Envelope, Job, Question, Outbound } from '../../pi/types.ts';
type Row = {
    id: string;
    data: string;
};
export class Store {
    readonly db: DatabaseSync;
    readonly events: EventLog;
    private projectingHistory = false;
    scopeForEnvelope = (e: Envelope) => JSON.stringify([e.route?.channelId ?? "private", e.route?.conversationId ?? e.route?.channelId ?? "private", e.route?.threadId ?? ""]);
    constructor(path: string) {
        mkdirSync(dirname(path), {
            recursive: true
        });
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
        for (const t of ['bots', 'inbox', 'jobs', 'questions', 'outbox', 'schedules', 'monitors', 'fires', 'proposals', 'memories', 'groups', 'group_messages'])
            this.db.exec(`CREATE TABLE IF NOT EXISTS ${t}(id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
        this.db.exec('CREATE TABLE IF NOT EXISTS bot_creation_receipts(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, bot_id TEXT NOT NULL)');
        this.db.exec('CREATE TABLE IF NOT EXISTS channel_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,data TEXT NOT NULL,updated_seq INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS channel_message_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS channel_message_channel ON channel_messages(json_extract(data,\'$.channelId\')); CREATE INDEX IF NOT EXISTS channel_event_channel ON channel_message_events(json_extract(data,\'$.channelId\'));');
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS inbox_dedupe ON inbox(json_extract(data,'$.from'),json_extract(data,'$.key')); CREATE UNIQUE INDEX IF NOT EXISTS job_dedupe ON jobs(json_extract(data,'$.botId'),json_extract(data,'$.key')); CREATE UNIQUE INDEX IF NOT EXISTS question_dedupe ON questions(json_extract(data,'$.botId'),json_extract(data,'$.key')); CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe ON outbox(json_extract(data,'$.botId'),json_extract(data,'$.key'));");
        this.transaction(() => migrate(this.db));
        this.events = new EventLog(this.db);
        this.projectingHistory = true;
        // Backfill existing durable envelopes once; identical snapshots add no duplicate events.
        this.transaction(() => {
            for (const table of ['inbox', 'outbox'] as const)
                for (const value of this.list<Envelope | Outbound>(table))
                    this.projectMessage(table, value);
        });
        this.projectingHistory = false;
    }
    transaction<T>(f: () => T): T {
        if (this.db.isTransaction)
            return f();
        const seq = this.events?.seq;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const v = f();
            this.db.exec('COMMIT');
            if (seq !== undefined)
                this.events.publishAfter(seq);
            return v;
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    put<T extends {
        id: string;
    }>(table: string, v: T, options?: { replaceReactions?: boolean }) {
        const write = () => {
            const before = this.get<any>(table, v.id);
            // Runtime state transitions can write an older envelope while the
            // user reacts. Only the reaction transaction replaces this field.
            if (!options?.replaceReactions && before?.reactions && ['inbox', 'outbox', 'group_messages'].includes(table))
                v = { ...v, reactions: before.reactions };
            const value = ['inbox', 'outbox'].includes(table) && typeof (v as any).text === 'string' ? {
                ...v, text: redactChannelText((v as any).text), ...(typeof (v as any).error === 'string' ? {
                    error: redactChannelText((v as any).error)
                } : {})
            } : v;
            this.db.prepare(`INSERT INTO ${this.table(table)}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(v.id, JSON.stringify(value));
            if (table === 'inbox' || table === 'outbox')
                this.projectMessage(table, value as unknown as Envelope | Outbound);
            if (table === 'inbox')
                this.ensureThread(value as unknown as Envelope);
            for (const event of derive(table, before, value, this.recordContext(table, value))) {
                // A reaction is a display update, not a repeated failure/review
                // transition of the underlying execution.
                if (options?.replaceReactions && !['item/updated', 'group/messageUpdated'].includes(event.method))
                    continue;
                if (event.params.item)
                    this.db.prepare('INSERT INTO items(id,data)VALUES(?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data').run(event.params.item.id, JSON.stringify(event.params.item));
                this.events.append(event.method, event.params, this.recordContext(table, value));
            }
        };
        if (!this.db.isTransaction)
            this.transaction(write);
        else
            write();
    }
    ensureThread(e: Envelope): Thread {
        const scopeKey = this.scopeForEnvelope(e), id = threadId(e.to, scopeKey);
        const existing = this.get<Thread>('threads', id);
        if (existing)
            return existing;
        const scope = scopeKey ? JSON.parse(scopeKey) : [null, null, null];
        const thread: Thread = {
            id, botId: e.to, scope: {
                channelId: e.route?.channelId ?? null, conversationId: e.route?.conversationId ?? e.route?.channelId ?? null, threadId: e.route?.threadId || null
            }, scopeKey, status: 'stored', activeTurnId: null, lastActivityAt: e.createdAt, createdAt: e.createdAt
        };
        this.put('threads', thread);
        return thread;
    }
    recordContext(table: string, value: any): {
        botId: string;
        threadId: string;
        turnId?: string;
    } | undefined {
        const current = this.events.context.getStore();
        if (table === 'inbox') {
            const turn = this.list<any>('turns').filter(t => t.inputIds.includes(value.id)).at(-1);
            const key = this.scopeForEnvelope(value);
            return {
                botId: value.to, threadId: threadId(value.to, key), ...(current && current.botId === value.to && current.threadId === threadId(value.to, key) ? {
                    turnId: current.turnId
                } : turn ? {
                    turnId: turn.id
                } : {})
            };
        }
        if (table === 'outbox' || table === 'jobs' || table === 'questions') {
            const inputId = value.replyTo ?? value.messageId;
            const input = inputId ? this.get<Envelope>('inbox', inputId) : undefined;
            if (input) {
                const ctx = this.recordContext('inbox', input)!;
                const turn = this.list<any>('turns').filter(t => t.inputIds.includes(input.id)).at(-1);
                return {
                    ...ctx, turnId: ctx.turnId ?? turn?.id
                };
            }
        }
        return current;
    }
    private projectMessage(table: 'inbox' | 'outbox', value: Envelope | Outbound) {
        const id = `${table}:${value.id}`, data = JSON.stringify(projectChannelMessage(table, value));
        if (table === 'outbox' && value.route?.channelId && this.get('groups', value.route.channelId)) {
            this.db.prepare('INSERT INTO group_messages(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, data);
            if (!this.projectingHistory)
                this.events?.append('group/messageUpdated', {
                    message: JSON.parse(data)
                });
        }
        const old = this.db.prepare('SELECT data FROM channel_messages WHERE id=?').get(id) as {
            data: string;
        } | undefined;
        if (old?.data === data)
            return;
        const event = this.db.prepare('INSERT INTO channel_message_events(id,data) VALUES(?,?)').run(id, data);
        this.db.prepare('INSERT INTO channel_messages(id,data,updated_seq) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_seq=excluded.updated_seq').run(id, data, Number(event.lastInsertRowid));
    }
    get<T>(table: string, id: string): T | undefined {
        const row = this.db.prepare(`SELECT * FROM ${this.table(table)} WHERE id=?`).get(id) as Row | undefined;
        return row ? JSON.parse(row.data) : undefined;
    }
    list<T>(table: string): T[] {
        return (this.db.prepare(`SELECT id, ${table === 'jobs' ? "json_remove(data,'$.result')" : 'data'} AS data FROM ${this.table(table)} ORDER BY rowid`).all() as Row[]).map(r => JSON.parse(r.data));
    }
    find<T>(table: string, owner: string, key: string): T | undefined {
        const field = table === 'inbox' ? 'from' : 'botId';
        const r = this.db.prepare(`SELECT id, ${table === 'jobs' ? "json_remove(data,'$.result')" : 'data'} AS data FROM ${this.table(table)} WHERE json_extract(data,'$.${field}')=? AND json_extract(data,'$.key')=?`).get(owner, key) as Row | undefined;
        return r ? JSON.parse(r.data) : undefined;
    }
    private table(t: string) {
        if (!['bots', 'inbox', 'jobs', 'questions', 'outbox', 'schedules', 'monitors', 'fires', 'proposals', 'memories', 'groups', 'group_messages', 'threads', 'turns', 'requests', 'items'].includes(t))
            throw new PiBotError('invalidParams', 'Invalid table');
        return t;
    }
    createBotOnce(key: string, input: string, create: () => Bot): Bot {
        if(!/^[a-zA-Z0-9_-]{1,128}$/.test(key))throw new PiBotError('invalidParams','Invalid bot creation key');
        const fingerprint=createHash('sha256').update(input).digest('hex');
        return this.transaction(()=>{
            const prior=this.db.prepare('SELECT fingerprint,bot_id FROM bot_creation_receipts WHERE key=?').get(key) as {fingerprint:string;bot_id:string}|undefined;
            if(prior){
                if(prior.fingerprint!==fingerprint)throw new PiBotError('conflict','Creation key reused with different bot details');
                const bot=this.get<Bot>('bots',prior.bot_id);
                if(!bot)throw new PiBotError('notFound','Previously created bot no longer exists');
                return bot;
            }
            const bot=create();
            this.db.prepare('INSERT INTO bot_creation_receipts(key,fingerprint,bot_id) VALUES(?,?,?)').run(key,fingerprint,bot.id);
            return bot;
        });
    }
    createBot(name: string, description = ''): Bot {
        if (!name.trim() || name.length > 100 || description.length > 2000)
            throw new PiBotError('invalidParams', 'Invalid bot profile');
        const b = {
            id: randomUUID(), name, description, sessionFile: null, createdAt: Date.now()
        };
        this.put('bots', b);
        return b;
    }
    recover() {
        this.transaction(() => {
            for (const e of this.list<Envelope>('inbox'))
                if (e.state === 'processing')
                    this.put('inbox', {
                        ...e, state: e.resolvedAt ? 'processed' : 'uncertain', error: e.resolvedAt ? undefined : 'Process ended during model run; explicit review required'
                    });
            for (const j of this.list<Job>('jobs'))
                if (j.state === 'running')
                    this.put('jobs', {
                        ...j, state: 'uncertain', error: 'Process ended during execution; not replayed'
                    });
            for (const o of this.list<Outbound>('outbox'))
                if (o.state === 'sending')
                    this.put('outbox', {
                        ...o, state: 'uncertain'
                    });
        });
    }
    count(table: string, field: string, value: string, state?: string) {
        if (!['to', 'taskId', 'botId'].includes(field))
            throw new PiBotError('invalidParams', 'Invalid field');
        const r = this.db.prepare(`SELECT count(*) AS n FROM ${this.table(table)} WHERE json_extract(data,'$.${field}')=? ${state ? "AND json_extract(data,'$.state')=?" : ''}`).get(...(state ? [value, state] : [value])) as {
            n: number;
        };
        return r.n;
    }
    pending(botId: string, backgroundOpportunity = false, activeUser?: boolean): Envelope | undefined {
        if (backgroundOpportunity) {
            const row = this.db.prepare("SELECT * FROM inbox WHERE json_extract(data,'$.to')=? AND json_extract(data,'$.state')='queued' AND json_extract(data,'$.kind') IN ('schedule','monitor','research','memory') ORDER BY rowid LIMIT 1").get(botId) as Row | undefined;
            if (row)
                return JSON.parse(row.data);
        }
        const eligibility = activeUser === undefined ? '' : activeUser ? "AND json_extract(data,'$.kind') IN ('user','answer','job')" : "AND (json_extract(data,'$.kind') IN ('user','answer','job') OR (json_extract(data,'$.kind')='bot' AND json_extract(data,'$.peerPriority')='urgent' AND coalesce(json_extract(data,'$.deliveryTarget'),'direct')='direct'))";
        const r = this.db.prepare(`SELECT * FROM inbox WHERE json_extract(data,'$.to')=? AND json_extract(data,'$.state')='queued' ${eligibility} ORDER BY CASE WHEN json_extract(data,'$.deferredContinuation')=1 THEN 4 WHEN json_extract(data,'$.kind') IN ('user','answer') AND (json_extract(data,'$.groupMessageId') IS NULL OR json_extract(data,'$.groupAttention')='mention') THEN 0 WHEN json_extract(data,'$.kind') IN ('user','answer') THEN 1 WHEN json_extract(data,'$.kind')='job' THEN 1 WHEN json_extract(data,'$.kind')='bot' AND json_extract(data,'$.peerPriority')='urgent' AND coalesce(json_extract(data,'$.deliveryTarget'),'direct')='direct' THEN 2 WHEN json_extract(data,'$.kind')='bot' THEN 3 ELSE 4 END, rowid LIMIT 1`).get(botId) as Row | undefined;
        return r ? JSON.parse(r.data) : undefined;
    }
    resultPage(botId: string, id: string, offset: number, limit: number): JobResultPage {
        const r = this.db.prepare("SELECT json_extract(data,'$.state') AS state,json_extract(data,'$.error') AS error,length(json_extract(data,'$.result')) AS total,substr(json_extract(data,'$.result'),?,?) AS text FROM jobs WHERE id=? AND json_extract(data,'$.botId')=?").get(offset + 1, limit, id, botId) as {
            state: string;
            error: string | null;
            total: number | null;
            text: string | null;
        } | undefined;
        if (!r)
            throw new PiBotError('notFound', 'Unknown job');
        return {
            id, ...r, total: r.total ?? 0, offset, next: offset + limit < (r.total ?? 0) ? offset + limit : null
        };
    }
    state(botId: string): BotStateSnapshot {
        const select = (table: string, field: string, states: string[], remove: string[]) => {
            const cond = `json_extract(data,'$.${field}')=? AND json_extract(data,'$.state') IN (${states.map(() => '?').join(',')})`;
            const data = remove.length ? `json_remove(data,${remove.map(x => `'$.${x}'`).join(',')})` : 'data';
            const rows = this.db.prepare(`SELECT id,${data} AS data FROM ${table} WHERE ${cond} ORDER BY rowid DESC LIMIT 30`).all(botId, ...states) as Row[];
            const count = this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${cond}`).get(botId, ...states) as {
                n: number;
            };
            return {
                items: rows.map(r => JSON.parse(r.data)), count: count.n
            };
        };
        const jobs = select('jobs', 'botId', ['running', 'uncertain'], ['args', 'result']);
        const questions = select('questions', 'botId', ['pending'], []);
        const inbox = select('inbox', 'to', ['queued', 'processing', 'uncertain'], ['text']);
        const outbox = select('outbox', 'botId', ['pending', 'sending', 'uncertain'], ['text']);
        const schedules = select('schedules', 'botId', ['active', 'paused'], ['prompt']);
        const monitors = select('monitors', 'botId', ['active'], ['prompt', 'baseline', 'cursor']);
        const proposals = select('proposals', 'botId', ['running', 'approved', 'uncertain'], ['candidate', 'evidenceRefs', 'review']);
        return {
            jobs: jobs.items, questions: questions.items, inbox: inbox.items, outbox: outbox.items, counts: {
                jobs: jobs.count, questions: questions.count, inbox: inbox.count, outbox: outbox.count
            }, proactive: {
                schedules: schedules.items, monitors: monitors.items, proposals: proposals.items, counts: {
                    schedules: schedules.count, monitors: monitors.count, proposals: proposals.count
                }
            }
        };
    }
    close() {
        this.db.close();
    }
}
