import { acquireLock } from './lock.ts';
import { randomUUID } from 'node:crypto';
import { Store, type Bot, type Envelope, type Job, type Question, type Outbound } from './store.ts';
export class JobExecutionError extends Error {
    constructor(message: string, readonly outcome: unknown) {
        super(message);
    }
}
export interface BotSession {
    run(e: Envelope): Promise<void>;
    enqueue?(e: Envelope): Promise<void>;
    close(): Promise<void>;
}
export type SessionFactory = (bot: Bot, runtime: BotRuntime) => Promise<BotSession>;
export type Permission = (request: {
    botId: string;
    tool: string;
    args: unknown;
    taskId: string;
}) => Promise<boolean> | boolean;
export class BotRuntime {
    readonly store: Store;
    private sessions = new Map<string, Promise<BotSession>>();
    private lanes = new Map<string, Promise<void>>();
    private jobs = new Set<Promise<void>>();
    private stopped = false;
    private active = new Map<string, {
        session: BotSession;
        batch: Envelope[];
    }>();
    private delivery: Promise<void> | undefined;
    readonly errors: unknown[] = [];
    private releaseLock: () => void;
    constructor(path: string, private factory: SessionFactory, readonly options: {
        maxBots?: number;
        maxHops?: number;
        maxTaskMessages?: number;
        maxPending?: number;
        maxJobs?: number;
        permission?: Permission;
    } = {}) {
        this.releaseLock = acquireLock(path);
        try {
            this.store = new Store(path);
            this.store.recover();
        }
        catch (e) {
            this.releaseLock();
            throw e;
        }
    }
    createBot(name: string, description = '') {
        if (this.store.list('bots').length >= (this.options.maxBots ?? 16))
            throw Error('Bot capacity reached');
        return this.store.createBot(name, description);
    }
    listBots() {
        return this.store.list<Bot>('bots');
    }
    start() {
        for (const b of this.listBots())
            this.wake(b.id);
    }
    accept(input: {
        from?: string;
        to: string;
        text: string;
        key: string;
        kind?: Envelope['kind'];
        taskId?: string;
        replyTo?: string;
        hop?: number;
    }): Envelope {
        if (this.stopped)
            throw Error('Runtime closing');
        if (!input.key || input.key.length > 256)
            throw Error('Idempotency key required (max 256)');
        if (input.text.length > 64000)
            throw Error('Input exceeds 64000 characters; split it or use an attachment');
        const from = input.from ?? 'user';
        const old = this.store.find<Envelope>('inbox', from, input.key);
        if (old) {
            if (old.to !== input.to || old.text !== input.text)
                throw Error('Idempotency key conflict');
            return old;
        }
        if (!this.store.get<Bot>('bots', input.to))
            throw Error('Unknown recipient');
        const hop = input.hop ?? 0;
        if (hop > (this.options.maxHops ?? 8))
            throw Error('Message hop budget exceeded');
        const taskId = input.taskId ?? randomUUID();
        if (input.kind === 'bot' && this.store.count('inbox', 'taskId', taskId) >= (this.options.maxTaskMessages ?? 32))
            throw Error('Task message budget exceeded');
        if (input.kind !== 'job' && input.kind !== 'answer' && this.store.count('inbox', 'to', input.to, 'queued') >= (this.options.maxPending ?? 100))
            throw Error('Inbox capacity reached');
        const e: Envelope = {
            id: randomUUID(), from, to: input.to, text: input.text, key: input.key, kind: input.kind ?? 'user', taskId, replyTo: input.replyTo ?? null, hop, state: 'queued', createdAt: Date.now()
        };
        this.store.put('inbox', e);
        this.wake(e.to);
        return e;
    }
    sendToBot(source: Envelope, to: string, text: string, key: string) {
        return this.accept({
            from: source.to, to, text, key, kind: 'bot', taskId: source.taskId, replyTo: source.id, hop: source.hop + 1
        });
    }
    private wake(id: string) {
        if (this.stopped)
            return;
        if (this.lanes.has(id)) {
            this.pump(id);
            return;
        }
        const p = Promise.resolve().then(() => this.drain(id)).catch(e => {
            this.errors.push(e);
        }).finally(() => {
            this.lanes.delete(id);
            if (!this.stopped && this.pending(id))
                this.wake(id);
        });
        this.lanes.set(id, p);
    }
    private pending(id: string) {
        return this.store.pending(id);
    }
    private pump(id: string) {
        const active = this.active.get(id);
        if (!active?.session.enqueue)
            return;
        let e: Envelope | undefined;
        while ((e = this.pending(id))) {
            const item = e;
            this.store.put('inbox', {
                ...item, state: 'processing'
            });
            active.batch.push(item);
            void active.session.enqueue(item).catch(error => {
                this.errors.push(error);
                this.store.put('inbox', {
                    ...item, state: 'uncertain', error: String(error)
                });
            });
        }
    }
    private async drain(id: string) {
        while (!this.stopped) {
            const e = this.pending(id);
            if (!e)
                return;
            this.store.put('inbox', {
                ...e, state: 'processing'
            });
            const batch = [e];
            try {
                let s = this.sessions.get(id);
                if (!s) {
                    s = this.factory(this.store.get<Bot>('bots', id)!, this);
                    this.sessions.set(id, s);
                }
                const session = await s;
                const run = session.run(e);
                this.active.set(id, {
                    session, batch
                });
                this.pump(id);
                await run;
                this.active.delete(id);
                for (const item of batch)
                    if (this.store.get<Envelope>('inbox', item.id)?.state === 'processing')
                        this.store.put('inbox', {
                            ...item, state: 'processed'
                        });
            }
            catch (error) {
                this.active.delete(id);
                for (const item of batch)
                    this.store.put('inbox', {
                        ...item, state: 'uncertain', error: String(error)
                    });
                this.errors.push(error);
            }
        }
    }
    sendMessage(e: Envelope, text: string, key: string) {
        if (text.length > 64000)
            throw Error('Message too large');
        const old = this.store.find<Outbound>('outbox', e.to, key);
        if (old) {
            if (old.text !== text)
                throw Error('Idempotency key conflict');
            return old;
        }
        if (this.store.count('outbox', 'taskId', e.taskId) >= 64)
            throw Error('Task outbox budget exceeded');
        const o: Outbound = {
            id: randomUUID(), botId: e.to, taskId: e.taskId, replyTo: e.id, key, text, state: 'pending', createdAt: Date.now()
        };
        this.store.put('outbox', o);
        return o;
    }
    askUser(e: Envelope, text: string, key: string) {
        if (text.length > 4000)
            throw Error('Question exceeds 4000 characters');
        const old = this.store.find<Question>('questions', e.to, key);
        if (old) {
            if (old.text !== text)
                throw Error('Idempotency key conflict');
            return old;
        }
        if (this.store.count('questions', 'botId', e.to, 'pending') >= 16)
            throw Error('Pending question capacity reached');
        return this.store.transaction(() => {
            const q: Question = {
                id: randomUUID(), botId: e.to, taskId: e.taskId, messageId: e.id, key, text, state: 'pending', createdAt: Date.now()
            };
            this.store.put('questions', q);
            this.sendMessage(e, JSON.stringify({
                questionId: q.id, question: text
            }), `question:${q.id}`);
            return q;
        });
    }
    answer(id: string, text: string, key: string) {
        const q = this.store.get<Question>('questions', id);
        if (!q)
            throw Error('Unknown question');
        if (q.state === 'answered') {
            if (q.answer !== text)
                throw Error('Question already answered');
            return;
        }
        this.store.transaction(() => {
            this.accept({
                to: q.botId, text: JSON.stringify({
                    questionId: id, answer: text
                }), key, kind: 'answer', taskId: q.taskId, replyTo: q.messageId
            });
            this.store.put('questions', {
                ...q, state: 'answered', answer: text
            });
        });
    }
    startJob(e: Envelope, tool: string, args: unknown, key: string, execute: () => Promise<unknown>): Job {
        const old = this.store.find<Job>('jobs', e.to, key);
        if (old) {
            if (old.tool !== tool || JSON.stringify(old.args) !== JSON.stringify(args))
                throw Error('Idempotency key conflict');
            return old;
        }
        if (this.store.count('jobs', 'taskId', e.taskId) >= 32)
            throw Error('Task job budget exceeded');
        if (this.jobs.size >= (this.options.maxJobs ?? 8))
            throw Error('Concurrent job budget reached');
        const j: Job = {
            id: randomUUID(), botId: e.to, taskId: e.taskId, messageId: e.id, key, tool, args, state: 'running', createdAt: Date.now()
        };
        this.store.put('jobs', j);
        const p = Promise.resolve().then(async () => {
            try {
                if (this.options.permission && !await this.options.permission({
                    botId: e.to, tool, args, taskId: e.taskId
                }))
                    throw Error('Permission denied');
                const value = await execute();
                this.settleJob(j, 'completed', JSON.stringify(value) ?? 'null');
            }
            catch (error) {
                this.settleJob(j, 'failed', error instanceof JobExecutionError ? JSON.stringify(error.outcome) : undefined, String(error));
            }
        }).finally(() => this.jobs.delete(p));
        this.jobs.add(p);
        return j;
    }
    private settleJob(j: Job, state: Job['state'], result?: string, error?: string) {
        error = error?.slice(0, 2000);
        this.store.transaction(() => {
            this.store.put('jobs', {
                ...j, state, result, error
            });
            try {
                this.accept({
                    from: `job:${j.id}`, to: j.botId, kind: 'job', key: `settled:${j.id}`, taskId: j.taskId, replyTo: j.messageId, text: JSON.stringify({
                        jobId: j.id, state, error, resultPreview: result?.slice(0, 2000), resultCharacters: result?.length, retrieve: 'job_result'
                    })
                });
            }
            catch (e) {
                this.errors.push(e);
            }
        });
    }
    jobResult(botId: string, id: string, offset = 0, limit = 4000) {
        offset = Math.max(0, Math.floor(offset));
        limit = Math.min(8000, Math.max(1, Math.floor(limit)));
        return this.store.resultPage(botId, id, offset, limit);
    }
    async deliver(sink: (o: Outbound) => Promise<void>) {
        if (this.delivery)
            return this.delivery;
        const work = async () => {
            for (const o of this.store.list<Outbound>('outbox').filter(x => x.state === 'pending')) {
                this.store.put('outbox', {
                    ...o, state: 'sending'
                });
                try {
                    await sink(o);
                    this.store.put('outbox', {
                        ...o, state: 'delivered'
                    });
                }
                catch (e) {
                    this.store.put('outbox', {
                        ...o, state: 'uncertain'
                    });
                    throw e;
                }
            }
        };
        this.delivery = work();
        try {
            await this.delivery;
        }
        finally {
            this.delivery = undefined;
        }
    }
    async idle() {
        while (this.lanes.size || this.jobs.size)
            await Promise.all([...this.lanes.values(), ...this.jobs]);
    }
    async close() {
        if (this.stopped)
            return;
        await this.idle();
        if (this.delivery)
            await this.delivery;
        this.stopped = true;
        for (const s of this.sessions.values())
            await (await s).close();
        this.store.close();
        this.releaseLock();
    }
}
