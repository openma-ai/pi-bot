import { redactTraceValue } from '../../pi/redact.ts';
import { authorize, type EventSink, type PluginEvent, type ApprovalPort } from '../../pi/host.ts';
import { TurnTracker } from '../events/turn-tracker.ts';
import { PiBotError } from '../core/errors.ts';
import type { Thread, Turn, Item } from '../../sdk/protocol/models.ts';
import { acquireLock } from './lock.ts';
import { randomUUID } from 'node:crypto';
import { Store, type Bot, type Envelope, type Job, type Question, type Outbound, type ChatRoute, type ChatGroup } from './store.ts';
import { redactChannelText } from './channel-messages.ts';
import type { OpenMatterTrigger } from './openmatter-trigger.ts';
import { groupMentions } from './group-mentions.ts';
import { InferenceYieldError, JobExecutionError, type BotHost, type BotSession, type Permission, type SessionFactory } from '../../pi/host.ts';
export { InferenceYieldError, JobExecutionError, type BotSession, type Permission, type SessionFactory };
export class BotRuntime implements BotHost {
    readonly store: Store;
    readonly tracker: TurnTracker;
    approvals?: ApprovalPort;
    readonly events: EventSink = {
        emit: (botId, event) => {
            try {
                this.pluginEvent(botId, event);
            }
            catch { /* Observers must not interrupt native Pi. */
            }
        }
    };
    private sessions = new Map<string, Promise<BotSession>>();
    private lanes = new Map<string, Promise<void>>();
    private jobs = new Set<Promise<void>>();
    private jobCompletions = new Map<string, Promise<void>>();
    private stopped = false;
    private draining = false;
    private reconfiguring = false;
    private active = new Map<string, {
        session: BotSession;
        batch: Envelope[];
        lane: 'user' | 'peer' | 'background';
        scope: string;
        turnId: string;
    }>();
    private foregroundBursts = new Map<string, number>();
    private readonly generation = randomUUID();
    private delivery: Promise<void> | undefined;
    readonly errors: unknown[] = [];
    private releaseLock: () => void;
    constructor(path: string, private factory: SessionFactory, readonly options: {
        isolateConversations?: boolean;
        activation?: OpenMatterTrigger;
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
            this.store.scopeForEnvelope = e => this.sessionScope(e);
            this.store.recover();
            this.tracker = new TurnTracker(this.store);
        }
        catch (e) {
            this.releaseLock();
            throw e;
        }
    }
    createBot(name: string, description = '', channelId?: string) {
        if (this.store.list('bots').length >= (this.options.maxBots ?? 16))
            throw new PiBotError('capacity', 'Bot capacity reached');
        const bot = this.store.createBot(name, description);
        if (channelId) {
            const group = this.store.get<ChatGroup>('groups', channelId);
            if (group) {
                bot.groupIds = [group.id];
                this.store.transaction(() => {
                    this.store.put('bots', bot);
                    this.store.put('groups', {
                        ...group, memberIds: [...group.memberIds, bot.id]
                    });
                });
            }
            else {
                bot.channelId = channelId;
                this.store.put('bots', bot);
            }
        }
        return bot;
    }
    listBots() {
        return this.store.list<Bot>('bots');
    }
    listGroups() {
        return this.store.list<ChatGroup>('groups');
    }
    createGroup(name: string, memberIds: string[]) {
        if (!name.trim() || name.length > 60 || memberIds.length < 2 || memberIds.length > 16 || new Set(memberIds).size !== memberIds.length || memberIds.some(id => !this.store.get<Bot>('bots', id)))
            throw new PiBotError('invalidParams', '群名及至少两名有效成员必填');
        if (this.listGroups().length >= 32)
            throw new PiBotError('capacity', 'Group capacity reached');
        const group: ChatGroup = {
            id: 'group:' + randomUUID(), name: name.trim(), memberIds, createdAt: Date.now()
        };
        this.store.transaction(() => {
            this.store.put('groups', group);
            for (const id of memberIds) {
                const bot = this.store.get<Bot>('bots', id)!;
                this.store.put('bots', {
                    ...bot, groupIds: [...(bot.groupIds ?? []), group.id]
                });
            }
        });
        return group;
    }
    channelBots(channelId?: string) {
        return this.listBots().filter(b => b.channelId === channelId || (channelId !== undefined && b.groupIds?.includes(channelId)));
    }
    activateInbox(id: string) {
        const e = this.store.get<Envelope>('inbox', id);
        if (!e)
            throw new PiBotError('reviewRequired', 'Missing native inbox; explicit reconciliation required');
        if (e.state === 'queued')
            this.wake(e.to);
    }
    start() {
        this.options.activation?.flush();
        for (const b of this.listBots())
            this.wake(b.id);
    }
    accept(input: {
        from?: string;
        to: string;
        text: string;
        key: string;
        kind?: Envelope['kind'];
        groupMessageId?: string;
        mentions?: string[];
        groupAttention?: Envelope['groupAttention'];
        peerPriority?: Envelope['peerPriority'];
        deliveryTarget?: Envelope['deliveryTarget'];
        taskId?: string;
        replyTo?: string;
        hop?: number;
        route?: ChatRoute;
        taskControl?: Envelope['taskControl'];
    }): Envelope {
        if (this.stopped || (this.draining && input.kind !== 'answer' && input.taskControl !== 'cancel'))
            throw new PiBotError("shuttingDown", "Runtime closing");
        if (!input.key || input.key.length > 256)
            throw new PiBotError('invalidParams', 'Idempotency key required (max 256)');
        if (input.text.length > 64000)
            throw new PiBotError('invalidParams', 'Input exceeds 64000 characters; split it or use an attachment');
        const from = input.from ?? 'user';
        const text = redactChannelText(input.text);
        const deliveryTarget = input.kind === 'bot' ? input.deliveryTarget ?? 'direct' : undefined;
        if (input.taskControl && input.kind && !['user', 'answer'].includes(input.kind))
            throw new PiBotError('forbidden', 'Only host user input can control a task');
        const old = this.store.find<Envelope>('inbox', from, input.key);
        if (old) {
            if (JSON.stringify(old.mentions) !== JSON.stringify(input.mentions) || old.groupMessageId !== input.groupMessageId || old.to !== input.to || old.text !== text || old.taskControl !== input.taskControl || old.peerPriority !== input.peerPriority || (old.kind === 'bot' ? old.deliveryTarget ?? 'direct' : undefined) !== deliveryTarget || JSON.stringify(old.route) !== JSON.stringify(input.route))
                throw new PiBotError('conflict', 'Idempotency key conflict');
            return old;
        }
        const candidateScope = this.sessionScope(input as Envelope);
        const archived = this.store.list<Thread>('threads').find(t => t.botId === input.to && t.scopeKey === candidateScope && t.status === 'archived');
        if (archived)
            throw new PiBotError('threadArchived', 'Thread is archived');
        const recipient = this.store.get<Bot>('bots', input.to);
        if (!recipient)
            throw new PiBotError('notFound', 'Unknown recipient');
        if (recipient.channelId !== input.route?.channelId && !(input.route?.channelId && recipient.groupIds?.includes(input.route.channelId)))
            throw new PiBotError('forbidden', 'Recipient channel mismatch');
        const hop = input.hop ?? 0;
        if (hop > (this.options.maxHops ?? 8))
            throw new PiBotError('budgetExhausted', 'Message hop budget exceeded');
        const taskId = input.taskId ?? randomUUID();
        if (input.kind === 'bot' && this.store.count('inbox', 'taskId', taskId) >= (this.options.maxTaskMessages ?? 32))
            throw new PiBotError('budgetExhausted', 'Task message budget exceeded');
        if (input.kind !== 'job' && input.kind !== 'answer' && this.store.count('inbox', 'to', input.to, 'queued') >= (this.options.maxPending ?? 100))
            throw new PiBotError('capacity', 'Inbox capacity reached');
        const e: Envelope = {
            id: randomUUID(), from, to: input.to, text, key: input.key, kind: input.kind ?? 'user', taskId, replyTo: input.replyTo ?? null, hop, state: 'queued', createdAt: Date.now(), ...(input.route ? {
                route: {
                    ...input.route
                }
            } : {}), ...(input.taskControl ? {
                taskControl: input.taskControl
            } : {}), ...(input.groupMessageId ? {
                groupMessageId: input.groupMessageId, mentions: input.mentions ?? [], groupAttention: input.groupAttention ?? 'normal'
            } : {}), ...(input.peerPriority ? {
                peerPriority: input.peerPriority
            } : {}), ...(deliveryTarget ? {
                deliveryTarget
            } : {})
        };
        this.options.activation?.publish(e);
        this.store.put('inbox', e);
        if (this.options.activation) {
            if (!this.store.db.isTransaction)
                this.options.activation.flush();
        }
        else
            this.wake(e.to);
        return e;
    }
    acceptGroupUser(groupId: string, text: string, key: string) {
        const group = this.listGroups().find(g => g.id === groupId);
        if (!group)
            throw new PiBotError('notFound', 'Unknown group');
        const members = group.memberIds.map(id => this.store.get<Bot>('bots', id)!);
        const mentions = groupMentions(text, members).ids;
        const messageId = 'user-group:' + key;
        const old = this.store.get<{
            text: string;
            channelId: string;
        }>('group_messages', messageId);
        if (old && (old.text !== redactChannelText(text) || old.channelId !== groupId))
            throw new PiBotError('conflict', 'Idempotency key conflict');
        const taskId = old ? (old as any).taskId : randomUUID();
        return this.store.transaction(() => {
            const deliveries = members.map(bot => this.accept({
                to: bot.id, text, key: key + ':' + bot.id, taskId, groupMessageId: messageId, mentions, groupAttention: mentions.includes(bot.id) ? 'mention' : 'normal', route: {
                    channelId: groupId, conversationId: groupId, threadId: 'gui', senderId: 'user'
                }
            }));
            if (!old)
                this.store.put('group_messages', {
                    ...this.projectGroup(deliveries[0]), id: messageId, messageId, groupMessageId: messageId, recipient: 'group', mentions, status: 'received'
                });
            return {
                ...deliveries[0], deliveries: deliveries.map(e => ({
                    id: e.id, to: e.to, state: e.state, groupAttention: e.groupAttention
                }))
            };
        });
    }
    private projectGroup(e: Envelope) {
        return {
            messageId: e.id, channelId: e.route!.channelId, conversationId: e.route!.conversationId ?? e.route!.channelId, threadId: e.route!.threadId, direction: 'inbound', sourceKind: e.kind, sender: e.from, recipient: e.to, botId: e.to, taskId: e.taskId, causationId: e.replyTo, text: redactChannelText(e.text), status: e.state, receivedAt: e.createdAt
        };
    }
    private sessionScope(e: Envelope) {
        return this.options.isolateConversations ? JSON.stringify([e.route?.channelId ?? 'private', e.route?.conversationId ?? e.route?.channelId ?? 'private', e.route?.threadId ?? '']) : '';
    }
    sendToBot(source: Envelope, to: string, text: string, key: string, options?: Envelope['peerPriority'] | {
        priority?: boolean;
    }) {
        this.assertTaskCurrent(source);
        const peerPriority = typeof options === 'string' ? options : options?.priority ? 'urgent' : undefined;
        return this.accept({
            from: source.to, to, text, key, kind: 'bot', taskId: source.taskId, replyTo: source.id, hop: source.hop + 1, route: source.route, peerPriority, deliveryTarget: 'direct'
        });
    }
    sendToGroup(source: Envelope, text: string, key: string, _priority = false): Envelope[] {
        this.assertTaskCurrent(source);
        if (!source.route?.channelId)
            throw new PiBotError('forbidden', 'Group delivery requires an inherited channel');
        const recipients = this.channelBots(source.route.channelId).filter(b => b.id !== source.to);
        const messageId = `bot-group:${source.to}:${key}`;
        return this.store.transaction(() => {
            const deliveries = recipients.map(b => this.accept({
                from: source.to, to: b.id, kind: 'bot', text, key: `${key}:${b.id}`, taskId: source.taskId, replyTo: source.id, hop: source.hop + 1, route: source.route, deliveryTarget: 'group', groupMessageId: messageId
            }));
            if (deliveries[0] && this.store.get('groups', source.route!.channelId))
                this.store.put('group_messages', {
                    ...this.projectGroup(deliveries[0]), id: messageId, messageId, groupMessageId: messageId, recipient: 'group', status: 'received'
                });
            return deliveries;
        });
    }
    private wake(id: string) {
        if (this.stopped || this.reconfiguring)
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
            if (active.scope !== this.sessionScope(e)) {
                if (!e.deferredContinuation && ['user', 'answer'].includes(e.kind) && (!e.groupMessageId || e.groupAttention === 'mention'))
                    active.session.yieldForUser?.();
                break;
            }
            const item = e;
            if (['user', 'answer'].includes(item.kind))
                active.lane = 'user';
            this.store.put('inbox', {
                ...item, state: 'processing', admittedAt: Date.now()
            });
            active.batch.push(item);
            this.tracker.addInput(active.turnId, item);
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
            const turn = this.tracker.begin(e);
            await this.store.events.context.run({
                botId: id, threadId: turn.threadId, turnId: turn.id
            }, async () => {
                let finalStatus: Turn['status'] = 'completed';
                let finalError: unknown;
                this.foregroundBursts.set(id, ['schedule', 'monitor', 'research', 'memory'].includes(e.kind) ? 0 : (this.foregroundBursts.get(id) ?? 0) + 1);
                this.store.put('inbox', {
                    ...e, state: 'processing', admittedAt: Date.now()
                });
                const batch = [e];
                let activeSession: BotSession | undefined;
                try {
                    const scope = this.sessionScope(e);
                    const sessionKey = id + ':' + scope;
                    let s = this.sessions.get(sessionKey);
                    if (!s) {
                        s = this.factory(this.store.get<Bot>('bots', id)!, this, scope || undefined);
                        this.sessions.set(sessionKey, s);
                    }
                    const session = await s;
                    activeSession = session;
                    const run = session.run(e);
                    this.active.set(id, {
                        session, batch, scope, turnId: turn.id, lane: ['user', 'answer'].includes(e.kind) ? 'user' : ['bot', 'job'].includes(e.kind) ? 'peer' : 'background'
                    });
                    this.pump(id);
                    await run;
                    this.active.delete(id);
                    for (const item of batch)
                        if (this.store.get<Envelope>('inbox', item.id)?.state === 'processing')
                            this.store.put('inbox', {
                                ...this.store.get<Envelope>('inbox', item.id)!, state: session.consumed && !session.consumed(item) ? (item.id === e.id ? 'uncertain' : 'queued') : 'processed', ...(session.consumed && !session.consumed(item) ? {} : {
                                    resolvedAt: Date.now()
                                })
                            });
                }
                catch (error) {
                    this.active.delete(id);
                    if (error instanceof InferenceYieldError) {
                        for (const item of batch) {
                            const saved = this.store.get<Envelope>('inbox', item.id);
                            if (saved?.state === 'processing')
                                this.store.put('inbox', {
                                    ...saved, state: saved.resolvedAt ? 'processed' : 'queued', deferredContinuation: !saved.resolvedAt
                                });
                        }
                        finalStatus = 'yielded';
                        return;
                    }
                    finalError = error;
                    finalStatus = 'failed';
                    for (const item of batch) {
                        const saved = this.store.get<Envelope>('inbox', item.id)!;
                        const resolved = saved.resolvedAt || activeSession?.resolved?.(item);
                        this.store.put('inbox', {
                            ...saved, state: resolved ? 'processed' : 'uncertain', error: resolved ? undefined : String(error), ...(resolved ? {
                                resolvedAt: saved.resolvedAt ?? Date.now()
                            } : {})
                        });
                    }
                    this.errors.push(error);
                }
                finally {
                    const primary = this.store.get<Envelope>('inbox', e.id);
                    if (finalStatus === 'completed' && primary?.state === 'uncertain')
                        finalStatus = 'uncertain';
                    if (primary?.state === 'processed' && e.taskControl === 'cancel')
                        finalStatus = 'interrupted';
                    if (finalStatus === 'failed' && primary?.state === 'processed')
                        finalStatus = 'completed';
                    this.tracker.end(turn.id, finalStatus, finalError);
                }
            });
        }
    }
    /** Trusted adapter checkpoint. A receipt/provider admission is not a resolution. */
    checkpointInbox(ids: Iterable<string>, stage: 'consumed' | 'resolved') {
        for (const id of ids) {
            const e = this.store.get<Envelope>('inbox', id);
            if (e?.state !== 'processing')
                continue;
            this.store.put('inbox', {
                ...e, consumedAt: e.consumedAt ?? Date.now(), ...(stage === 'resolved' ? {
                    resolvedAt: Date.now(), resolution: {
                        owner: 'native-final', evidence: []
                    }
                } : {})
            });
        }
    }
    /** Host-only reconciliation: delivered correlated output is independently verifiable. */
    reconcileInbox(id: string, review: {
        outcome: 'processed' | 'failed' | 'queued';
        evidence: string[];
        note?: string;
    }) {
        const e = this.store.get<Envelope>('inbox', id);
        if (!e || e.state !== 'uncertain')
            throw new PiBotError('reviewRequired', 'Inbox must be uncertain');
        if (!review.evidence.length)
            throw new PiBotError('reviewRequired', 'Resolution requires evidence');
        if (review.outcome === 'processed' && !review.evidence.every(ref => {
            const o = this.store.get<Outbound>('outbox', ref);
            return o?.state === 'delivered' && o.replyTo === id && o.botId === e.to && o.taskId === e.taskId;
        }))
            throw new PiBotError('reviewRequired', 'Evidence must be delivered correlated output');
        if (review.outcome !== 'processed' && !review.note?.trim())
            throw new PiBotError('reviewRequired', 'Host review note required before retry or failure');
        this.store.put('inbox', {
            ...e, state: review.outcome, error: undefined, resolvedAt: review.outcome === 'queued' ? undefined : Date.now(), resolution: {
                owner: 'host-review', evidence: review.evidence, note: review.note, attempt:(e.resolution?.attempt??0)+1
            }
        });
        if (review.outcome === 'queued') {
            const reviewed = this.store.get<Envelope>('inbox', id)!;
            if (this.options.activation) {
                this.options.activation.publish(reviewed, `resume:${reviewed.id}:${reviewed.resolution!.attempt}`);
                this.options.activation.flush();
            }
            else
                this.wake(e.to);
        }
    }
    sendMessage(e: Envelope, text: string, key: string, toolCallId?: string) {
        this.assertTaskCurrent(e, true);
        text = redactChannelText(text);
        if (text.length > 64000)
            throw new PiBotError('invalidParams', 'Message too large');
        const old = this.store.find<Outbound>('outbox', e.to, key);
        if (old) {
            if (old.text !== text || old.taskId !== e.taskId || JSON.stringify(old.route) !== JSON.stringify(e.route))
                throw new PiBotError('conflict', 'Idempotency key conflict');
            return old;
        }
        if (this.store.count('outbox', 'taskId', e.taskId) >= 64)
            throw new PiBotError('budgetExhausted', 'Task outbox budget exceeded');
        const o: Outbound = {
            id: randomUUID(), botId: e.to, taskId: e.taskId, replyTo: e.id, key, text, ...(toolCallId ? {
                toolCallId
            } : {}), state: 'pending', createdAt: Date.now(), ...(e.route ? {
                route: {
                    ...e.route
                }
            } : {})
        };
        this.store.put('outbox', o);
        return o;
    }
    askUser(e: Envelope, text: string, key: string, choices?:string[]) {
        this.assertTaskCurrent(e);
        if (text.length > 4000)
            throw new PiBotError('invalidParams', 'Question exceeds 4000 characters');
        if(choices&&(!Array.isArray(choices)||choices.length<1||choices.length>6||choices.some(c=>typeof c!=='string'||!c.trim()||c.length>300)||new Set(choices).size!==choices.length))throw new PiBotError('invalidParams','Invalid decision choices');
        const old = this.store.find<Question>('questions', e.to, key);
        if (old) {
            if (old.text !== text || JSON.stringify(old.choices??[])!==JSON.stringify(choices??[]))
                throw new PiBotError('conflict', 'Idempotency key conflict');
            return old;
        }
        if (this.store.count('questions', 'botId', e.to, 'pending') >= 16)
            throw new PiBotError('capacity', 'Pending question capacity reached');
        return this.store.transaction(() => {
            const q: Question = {
                id: randomUUID(), botId: e.to, taskId: e.taskId, messageId: e.id, key, text, ...(choices?{choices:[...choices]}:{}), state: 'pending', createdAt: Date.now()
            };
            this.store.put('questions', q);
            (this as any).requestBroker?.question(q);
            this.sendMessage(e, JSON.stringify({
                questionId: q.id, question: text, ...(choices?{choices:q.choices}:{})
            }), `question:${q.id}`);
            return q;
        });
    }
    answer(id: string, text: string, key: string) {
        const q = this.store.get<Question>('questions', id);
        if (!q)
            throw new PiBotError('notFound', 'Unknown question');
        if (q.state === 'answered') {
            if (q.answer !== text)
                throw new PiBotError('conflict', 'Question already answered');
            return;
        }
        const source = this.store.get<Envelope>('inbox', q.messageId);
        if (!source)
            throw new PiBotError('taskCancelled', 'Question source is unavailable');
        this.assertTaskCurrent(source);
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
    startJob(e: Envelope, tool: string, args: unknown, key: string, execute: () => Promise<unknown>, options: {
        quiet?: boolean;
        onSettled?: (state: Job['state']) => void;
    } = {}): Job {
        this.assertTaskCurrent(e);
        const old = this.store.find<Job>('jobs', e.to, key);
        if (old) {
            if (old.tool !== tool || JSON.stringify(old.args) !== JSON.stringify(args))
                throw new PiBotError('conflict', 'Idempotency key conflict');
            return old;
        }
        if (this.store.count('jobs', 'taskId', e.taskId) >= 32)
            throw new PiBotError('budgetExhausted', 'Task job budget exceeded');
        if (this.jobs.size >= (this.options.maxJobs ?? 8))
            throw new PiBotError('capacity', 'Concurrent job budget reached');
        const j: Job = {
            id: randomUUID(), botId: e.to, taskId: e.taskId, messageId: e.id, key, tool, args, state: 'running', createdAt: Date.now(), generation: randomUUID(), attempt: 1, owner: this.generation, ...(options.quiet ? {
                quiet: true
            } : {})
        };
        this.store.put('jobs', j);
        const p = Promise.resolve().then(async () => {
            try {
                if ((this.options.permission || this.approvals) && !await authorize(this, {
                    botId: e.to, tool, args, taskId: e.taskId
                }))
                    throw new PiBotError('forbidden', 'Permission denied');
                this.assertTaskCurrent(e);
                const value = await execute();
                this.settleJob(j, 'completed', JSON.stringify(value) ?? 'null');
            }
            catch (error) {
                this.settleJob(j, 'failed', error instanceof JobExecutionError ? JSON.stringify(error.outcome) : undefined, String(error));
            }
        }).finally(() => {
            this.jobs.delete(p);
            this.jobCompletions.delete(j.id);
            if (options.onSettled) {
                try {
                    options.onSettled(this.store.get<Job>('jobs', j.id)!.state);
                }
                catch (error) {
                    this.errors.push(error);
                }
            }
        });
        this.jobs.add(p);
        void p.catch(() => {
        });
        this.jobCompletions.set(j.id, p);
        return j;
    }
    /** Await the existing host execution; never create or replay work. */
    async waitForJob(id: string): Promise<Job> {
        if (!this.store.get<Job>('jobs', id))
            throw new PiBotError('notFound', 'Unknown job');
        const completion = this.jobCompletions.get(id);
        if (completion)
            await completion;
        return this.store.get<Job>('jobs', id)!;
    }
    /** Host-declared replacement/cancellation prevents future obsolete actions.
     * A dispatched job continues; its eventual result remains available. */
    assertTaskCurrent(e: Envelope, allowCancellationReply = false) {
        if (this.stopped)
            throw new PiBotError("taskCancelled", "Runtime closed; no new action permitted");
        let ancestor: Envelope | undefined = this.store.get<Envelope>('inbox', e.id) ?? e;
        const visited = new Set<string>();
        while (ancestor && !visited.has(ancestor.id)) {
            visited.add(ancestor.id);
            if (ancestor.triggerCancelled)
                throw new PiBotError('taskCancelled', 'Trigger cancelled; no new action permitted');
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
            throw new PiBotError('taskCancelled', 'Task superseded or cancelled; no new action permitted');
    }
    private settleJob(j: Job, state: Job['state'], result?: string, error?: string) {
        error = error?.slice(0, 2000);
        this.store.transaction(() => {
            const current = this.store.get<Job>('jobs', j.id);
            if (!current || current.state !== 'running' || current.generation !== j.generation || current.owner !== j.owner)
                return;
            this.store.put('jobs', {
                ...j, state, result, error, completedAt: Date.now()
            });
            if (j.quiet)
                return;
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
    private pluginEvent(botId: string, event: PluginEvent) {
        const ctx = this.store.events.context.getStore();
        if (!ctx || ctx.botId !== botId)
            return;
        const { threadId, turnId } = ctx;
        if (event.type === 'usage') {
            this.tracker.usage(turnId, event);
            return;
        }
        if (event.type === 'internalDelta') {
            this.store.events.publish({
                seq: null, at: Date.now(), method: 'item/internal/delta', params: {
                    botId, threadId, turnId, textDelta: redactChannelText(event.textDelta).slice(0, 4096)
                }
            });
            return;
        }
        if (event.type === 'replyDelta') {
            this.store.events.publish({
                seq: null, at: Date.now(), method: 'item/agentMessage/delta', params: {
                    botId, threadId, turnId, itemId: 'reply:' + event.toolCallId, toolCallId: event.toolCallId, textDelta: redactChannelText(event.textDelta).slice(0, 4096)
                }
            });
            return;
        }
        if (event.type === 'toolDelta') {
            this.store.events.publish({
                seq: null, at: Date.now(), method: 'item/toolCall/delta', params: {
                    botId, threadId, turnId, itemId: 'tool:' + event.toolCallId, partial: redactChannelText(event.partial).slice(0, 4096)
                }
            });
            return;
        }
        if (event.type === 'compaction') {
            this.tracker.item({
                id: 'compaction:' + turnId + ':' + Date.now(), type: 'compaction', botId, threadId, turnId, status: 'completed', tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter
            });
            return;
        }
        const id = 'tool:' + event.toolCallId;
        const old = this.store.get<Item>('items', id);
        if (event.type === 'toolStarted')
            this.tracker.item({
                id, type: 'toolCall', botId, threadId, turnId, status: 'inProgress', toolCallId: event.toolCallId, tool: event.tool, args: redactTraceValue(event.args)
            });
        if (event.type === 'toolCompleted') {
            const safe = redactTraceValue(event.result);
            const raw = JSON.stringify(safe) ?? 'null';
            const result = raw.length > 8000 ? {
                preview: raw.slice(0, 8000), truncated: true
            } : safe;
            this.tracker.item({
                ...old, id, type: 'toolCall', botId, threadId, turnId, status: 'completed', toolCallId: event.toolCallId, result, isError: event.isError
            });
        }
    }
    async unloadThread(id: string): Promise<{
        unloaded: boolean;
        blockedBy?: string[];
    }> {
        const thread = this.store.get<Thread>('threads', id);
        if (!thread)
            throw new PiBotError('notFound', 'Unknown thread');
        const blockedBy: string[] = [];
        if (this.active.get(thread.botId)?.scope === thread.scopeKey)
            blockedBy.push('activeTurn');
        const inputs = this.store.list<Envelope>('inbox').filter(e => e.to === thread.botId && this.sessionScope(e) === thread.scopeKey);
        const ids = new Set(inputs.map(e => e.id));
        if (this.store.list<Job>('jobs').some(j => ids.has(j.messageId) && j.state === 'running'))
            blockedBy.push('runningJob');
        if (inputs.some(e => e.state === 'queued' || e.state === 'processing'))
            blockedBy.push('pendingInput');
        if (this.store.list<any>('requests').some(q => q.threadId === id && q.status === 'pending'))
            blockedBy.push('pendingRequest');
        if (blockedBy.length)
            return {
                unloaded: false, blockedBy
            };
        const lane = this.lanes.get(thread.botId);
        if (lane) {
            await lane;
            return this.unloadThread(id);
        }
        const key = thread.botId + ':' + thread.scopeKey;
        const session = this.sessions.get(key);
        if (!session) {
            if (thread.status === 'loaded')
                this.store.put('threads', {
                    ...thread, status: 'stored', activeTurnId: null
                });
            return {
                unloaded: true
            };
        }
        const close = (async () => {
            await (await session).close();
            this.sessions.delete(key);
            this.store.put('threads', {
                ...thread, status: 'stored', activeTurnId: null
            });
        })();
        this.lanes.set(thread.botId, close);
        try {
            await close;
            return {
                unloaded: true
            };
        }
        finally {
            this.lanes.delete(thread.botId);
            this.wake(thread.botId);
        }
    }
    /** Swap only at a quiescent boundary. Queued inputs retain their original IDs and routes. */
    get canReconfigure() {
        return !this.stopped && !this.draining && !this.reconfiguring && !this.lanes.size && !this.jobs.size && !this.store.list<any>('requests').some(r => r.status === 'pending');
    }
    async reconfigure(factory: SessionFactory): Promise<boolean> {
        if (!this.canReconfigure)
            return false;
        this.reconfiguring = true;
        try {
            await Promise.all([...this.sessions.values()].map(async (session) => (await session).close()));
            this.sessions.clear();
            this.factory = factory;
            for (const thread of this.store.list<Thread>('threads'))
                if (thread.status === 'loaded')
                    this.store.put('threads', {
                        ...thread, status: 'stored', activeTurnId: null
                    });
            return true;
        }
        finally {
            this.reconfiguring = false;
            for (const bot of this.listBots())
                if (this.pending(bot.id))
                    this.wake(bot.id);
        }
    }
    beginDrain() {
        this.draining = true;
    }
    forceClose() {
        this.stopped = true;
        for (const s of this.sessions.values())
            void s.then(session => session.close()).catch(() => {
            });
        this.sessions.clear();
        this.store.close();
        this.releaseLock();
    }
    async idle() {
        for (;;) {
            if (!this.store.db.isTransaction)
                this.options.activation?.flush();
            if (!this.lanes.size && !this.jobs.size)
                return;
            await Promise.allSettled([...this.lanes.values(), ...this.jobs]);
        }
    }
    async close() {
        if (this.stopped)
            return;
        await this.idle();
        if (this.delivery)
            await this.delivery;
        this.stopped = true;
        await Promise.allSettled([...this.sessions.values()].map(async (s) => (await s).close()));
        this.store.close();
        this.releaseLock();
    }
}
