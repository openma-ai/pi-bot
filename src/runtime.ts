import { acquireLock } from './lock.ts';
import { randomUUID } from 'node:crypto';
import { Store, type Bot, type Envelope, type Job, type Question, type Outbound, type ChatRoute } from './store.ts';
import { redactChannelText } from './channel-messages.ts';
export class JobExecutionError extends Error {
    constructor(message: string, readonly outcome: unknown) {
        super(message);
    }
}
export interface BotSession {
    run(e: Envelope): Promise<void>;
    enqueue?(e: Envelope): Promise<void>;
    /** Native adapter confirms event actually reached a provider boundary. */
    consumed?(e: Envelope): boolean;
    /** A successful final native step, unlike merely reaching a provider boundary. */
    resolved?(e: Envelope): boolean;
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
    private jobCompletions = new Map<string, Promise<void>>();
    private stopped = false;
    private active = new Map<string, {
        session: BotSession;
        batch: Envelope[];
        lane: 'user' | 'peer' | 'background';
    }>();
    private foregroundBursts = new Map<string, number>();
    private readonly generation = randomUUID();
    private delivery: Promise<void> | undefined;
    readonly errors: unknown[] = [];
    private releaseLock: () => void;
    constructor(path: string, private factory: SessionFactory, readonly options: {
        maxBots?: number;
        maxHops?: number;
        maxTaskMessages?: number;
        maxPending?: number;
        maxJobs?: number;
        maxForegroundBurst?: number;
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
    createBot(name: string, description = '', channelId?: string) {
        if (this.store.list('bots').length >= (this.options.maxBots ?? 16))
            throw Error('Bot capacity reached');
        const bot = this.store.createBot(name, description);
        if (channelId) {
            bot.channelId = channelId;
            this.store.put('bots', bot);
        }
        return bot;
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
        peerPriority?: Envelope['peerPriority'];
        deliveryTarget?: Envelope['deliveryTarget'];
        taskId?: string;
        replyTo?: string;
        hop?: number;
        route?: ChatRoute;
        taskControl?: Envelope['taskControl'];
    }): Envelope {
        if (this.stopped)
            throw Error('Runtime closing');
        if (!input.key || input.key.length > 256)
            throw Error('Idempotency key required (max 256)');
        if (input.text.length > 64000)
            throw Error('Input exceeds 64000 characters; split it or use an attachment');
        const from = input.from ?? 'user';
        const text = redactChannelText(input.text);
        const deliveryTarget = input.kind === 'bot' ? input.deliveryTarget ?? 'direct' : undefined;
        if (input.taskControl && input.kind && !['user', 'answer'].includes(input.kind))
            throw Error('Only host user input can control a task');
        const old = this.store.find<Envelope>('inbox', from, input.key);
        if (old) {
            if (old.to !== input.to || old.text !== text || old.taskControl !== input.taskControl || old.peerPriority !== input.peerPriority || (old.kind === 'bot' ? old.deliveryTarget ?? 'direct' : undefined) !== deliveryTarget || JSON.stringify(old.route) !== JSON.stringify(input.route))
                throw Error('Idempotency key conflict');
            return old;
        }
        const recipient = this.store.get<Bot>('bots', input.to);
        if (!recipient)
            throw Error('Unknown recipient');
        if (recipient.channelId !== input.route?.channelId)
            throw Error('Recipient channel mismatch');
        const hop = input.hop ?? 0;
        if (hop > (this.options.maxHops ?? 8))
            throw Error('Message hop budget exceeded');
        const taskId = input.taskId ?? randomUUID();
        if (input.kind === 'bot' && this.store.count('inbox', 'taskId', taskId) >= (this.options.maxTaskMessages ?? 32))
            throw Error('Task message budget exceeded');
        if (input.kind !== 'job' && input.kind !== 'answer' && this.store.count('inbox', 'to', input.to, 'queued') >= (this.options.maxPending ?? 100))
            throw Error('Inbox capacity reached');
        const e: Envelope = {
            id: randomUUID(), from, to: input.to, text, key: input.key, kind: input.kind ?? 'user', taskId, replyTo: input.replyTo ?? null, hop, state: 'queued', createdAt: Date.now(), ...(input.route ? {
                route: {
                    ...input.route
                }
            } : {}), ...(input.taskControl ? {
                taskControl: input.taskControl
            } : {}), ...(input.peerPriority ? { peerPriority: input.peerPriority } : {}), ...(deliveryTarget ? { deliveryTarget } : {})
        };
        this.store.put('inbox', e);
        this.wake(e.to);
        return e;
    }
    sendToBot(source: Envelope, to: string, text: string, key: string, options?: Envelope['peerPriority'] | { priority?: boolean }) {
        this.assertTaskCurrent(source);
        const peerPriority = typeof options === 'string' ? options : options?.priority ? 'urgent' : undefined;
        return this.accept({
            from: source.to, to, text, key, kind: 'bot', taskId: source.taskId, replyTo: source.id, hop: source.hop + 1, route: source.route, peerPriority, deliveryTarget: 'direct'
        });
    }
    sendToGroup(source: Envelope, text: string, key: string, _priority = false): Envelope[] {
        this.assertTaskCurrent(source);
        if (!source.route?.channelId) throw Error('Group delivery requires an inherited channel');
        const recipients = this.listBots().filter(b => b.channelId === source.route!.channelId && b.id !== source.to);
        return this.store.transaction(() => recipients.map(b => this.accept({ from: source.to, to: b.id, kind: 'bot', text, key: `${key}:${b.id}`, taskId: source.taskId, replyTo: source.id, hop: source.hop + 1, route: source.route, deliveryTarget: 'group' })));
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
    private pending(id: string, fair = true, activeUser?: boolean) {
        return this.store.pending(id, fair && (this.foregroundBursts.get(id) ?? 0) >= (this.options.maxForegroundBurst ?? 8), activeUser);
    }
    private pump(id: string) {
        const active = this.active.get(id);
        if (!active?.session.enqueue)
            return;
        let e: Envelope | undefined;
        while ((e = this.pending(id, false, active.lane === 'user'))) {
            const item = e;
            if (['user', 'answer'].includes(item.kind)) active.lane = 'user';
            this.store.put('inbox', {
                ...item, state: 'processing', admittedAt: Date.now()
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
            this.foregroundBursts.set(id, ['schedule', 'monitor', 'research', 'memory'].includes(e.kind) ? 0 : (this.foregroundBursts.get(id) ?? 0) + 1);
            this.store.put('inbox', {
                ...e, state: 'processing', admittedAt: Date.now()
            });
            const batch = [e];
            let activeSession: BotSession | undefined;
            try {
                let s = this.sessions.get(id);
                if (!s) {
                    s = this.factory(this.store.get<Bot>('bots', id)!, this);
                    this.sessions.set(id, s);
                }
                const session = await s;
                activeSession = session;
                const run = session.run(e);
                this.active.set(id, {
                    session, batch, lane: ['user', 'answer'].includes(e.kind) ? 'user' : ['bot', 'job'].includes(e.kind) ? 'peer' : 'background'
                });
                this.pump(id);
                await run;
                this.active.delete(id);
                for (const item of batch)
                    if (this.store.get<Envelope>('inbox', item.id)?.state === 'processing')
                        this.store.put('inbox', {
                            ...this.store.get<Envelope>('inbox', item.id)!, state: session.consumed && !session.consumed(item) ? (item.id === e.id ? 'uncertain' : 'queued') : 'processed', ...(session.consumed && !session.consumed(item) ? {} : { resolvedAt: Date.now() })
                        });
            }
            catch (error) {
                this.active.delete(id);
                for (const item of batch) {
                    const saved = this.store.get<Envelope>('inbox', item.id)!;
                    const resolved = saved.resolvedAt || activeSession?.resolved?.(item);
                    this.store.put('inbox', {
                        ...saved, state: resolved ? 'processed' : 'uncertain', error: resolved ? undefined : String(error), ...(resolved ? { resolvedAt: saved.resolvedAt ?? Date.now() } : {})
                    });
                }
                this.errors.push(error);
            }
        }
    }
    /** Trusted adapter checkpoint. A receipt/provider admission is not a resolution. */
    checkpointInbox(ids: Iterable<string>, stage: 'consumed' | 'resolved') {
        for (const id of ids) {
            const e = this.store.get<Envelope>('inbox', id);
            if (e?.state !== 'processing') continue;
            this.store.put('inbox', { ...e, consumedAt: e.consumedAt ?? Date.now(), ...(stage === 'resolved' ? { resolvedAt: Date.now(), resolution: { owner: 'native-final', evidence: [] } } : {}) });
        }
    }
    /** Host-only reconciliation: delivered correlated output is independently verifiable. */
    reconcileInbox(id: string, review: { outcome: 'processed' | 'failed' | 'queued'; evidence: string[]; note?: string }) {
        const e = this.store.get<Envelope>('inbox', id);
        if (!e || e.state !== 'uncertain') throw Error('Inbox must be uncertain');
        if (!review.evidence.length) throw Error('Resolution requires evidence');
        if (review.outcome === 'processed' && !review.evidence.every(ref => {
            const o = this.store.get<Outbound>('outbox', ref);
            return o?.state === 'delivered' && o.replyTo === id && o.botId === e.to && o.taskId === e.taskId;
        })) throw Error('Evidence must be delivered correlated output');
        if (review.outcome !== 'processed' && !review.note?.trim()) throw Error('Host review note required before retry or failure');
        this.store.put('inbox', { ...e, state: review.outcome, error: undefined, resolvedAt: review.outcome === 'queued' ? undefined : Date.now(), resolution: { owner: 'host-review', evidence: review.evidence, note: review.note } });
        if (review.outcome === 'queued') this.wake(e.to);
    }
    sendMessage(e: Envelope, text: string, key: string) {
        this.assertTaskCurrent(e, true);
        text = redactChannelText(text);
        if (text.length > 64000)
            throw Error('Message too large');
        const old = this.store.find<Outbound>('outbox', e.to, key);
        if (old) {
            if (old.text !== text || old.taskId !== e.taskId || JSON.stringify(old.route) !== JSON.stringify(e.route))
                throw Error('Idempotency key conflict');
            return old;
        }
        if (this.store.count('outbox', 'taskId', e.taskId) >= 64)
            throw Error('Task outbox budget exceeded');
        const o: Outbound = {
            id: randomUUID(), botId: e.to, taskId: e.taskId, replyTo: e.id, key, text, state: 'pending', createdAt: Date.now(), ...(e.route ? {
                route: {
                    ...e.route
                }
            } : {})
        };
        this.store.put('outbox', o);
        return o;
    }
    askUser(e: Envelope, text: string, key: string) {
        this.assertTaskCurrent(e);
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
                }), key, kind: 'answer', taskId: q.taskId, replyTo: q.messageId, route: this.store.get<Envelope>('inbox', q.messageId)?.route
            });
            this.store.put('questions', {
                ...q, state: 'answered', answer: text
            });
        });
    }
    startJob(e: Envelope, tool: string, args: unknown, key: string, execute: () => Promise<unknown>, options: { quiet?: boolean; onSettled?: (state: Job['state']) => void } = {}): Job {
        this.assertTaskCurrent(e);
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
            id: randomUUID(), botId: e.to, taskId: e.taskId, messageId: e.id, key, tool, args, state: 'running', createdAt: Date.now(), generation: randomUUID(), attempt: 1, owner: this.generation, ...(options.quiet ? { quiet: true } : {})
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
        }).finally(() => {
            this.jobs.delete(p); this.jobCompletions.delete(j.id);
            if (options.onSettled) { try { options.onSettled(this.store.get<Job>('jobs', j.id)!.state); } catch (error) { this.errors.push(error); } }
        });
        this.jobs.add(p);
        this.jobCompletions.set(j.id, p);
        return j;
    }
    /** Await the existing host execution; never create or replay work. */
    async waitForJob(id: string): Promise<Job> {
        if (!this.store.get<Job>('jobs', id)) throw Error('Unknown job');
        const completion = this.jobCompletions.get(id);
        if (completion) await completion;
        return this.store.get<Job>('jobs', id)!;
    }
    /** Host-declared replacement/cancellation prevents future obsolete actions.
     * A dispatched job continues; its eventual result remains available. */
    assertTaskCurrent(e: Envelope, allowCancellationReply = false) {
        let ancestor: Envelope | undefined = this.store.get<Envelope>('inbox', e.id) ?? e;
        const visited = new Set<string>();
        while (ancestor && !visited.has(ancestor.id)) {
            visited.add(ancestor.id);
            if (ancestor.triggerCancelled) throw Error('Trigger cancelled; no new action permitted');
            ancestor = ancestor.replyTo ? this.store.get<Envelope>('inbox', ancestor.replyTo) : undefined;
        }
        const inbox = this.store.list<Envelope>('inbox');
        const controls = inbox.filter(item => item.taskId === e.taskId && item.taskControl &&
            item.route?.channelId === e.route?.channelId && (item.route?.conversationId ?? item.route?.channelId) === (e.route?.conversationId ?? e.route?.channelId) && item.route?.threadId === e.route?.threadId && item.route?.senderId === e.route?.senderId);
        const latest = controls.at(-1);
        if (!latest)
            return;
        if (latest.taskControl === 'cancel' && allowCancellationReply && latest.id === e.id)
            return;
        let root = e;
        const seen = new Set<string>();
        while (!['user', 'answer'].includes(root.kind) && root.replyTo && !seen.has(root.id)) {
            seen.add(root.id);
            const parent = this.store.get<Envelope>('inbox', root.replyTo);
            if (!parent)
                break;
            root = parent;
        }
        if (latest.taskControl === 'cancel' || inbox.findIndex(item => item.id === root.id) < inbox.findIndex(item => item.id === latest.id))
            throw Error('Task superseded or cancelled; no new action permitted');
    }
    private settleJob(j: Job, state: Job['state'], result?: string, error?: string) {
        error = error?.slice(0, 2000);
        this.store.transaction(() => {
            const current = this.store.get<Job>('jobs', j.id);
            if (!current || current.state !== 'running' || current.generation !== j.generation || current.owner !== j.owner) return;
            this.store.put('jobs', {
                ...j, state, result, error, completedAt: Date.now()
            });
            if (j.quiet) return;
            try {
                this.accept({
                    from: `job:${j.id}`, to: j.botId, kind: 'job', key: `settled:${j.id}`, taskId: j.taskId, replyTo: j.messageId, route: this.store.get<Envelope>('inbox', j.messageId)?.route, text: JSON.stringify({
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
                const source = o.replyTo && this.store.get<Envelope>('inbox', o.replyTo);
                if (source) {
                    try {
                        this.assertTaskCurrent(source, true);
                    }
                    catch {
                        this.store.put('outbox', {
                            ...o, state: 'superseded'
                        });
                        continue;
                    }
                }
                this.store.put('outbox', {
                    ...o, state: 'sending'
                });
                try {
                    await sink(o);
                    this.store.put('outbox', {
                        ...o, state: 'delivered', deliveredAt: Date.now()
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
