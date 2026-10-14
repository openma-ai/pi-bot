import {recoveryPlan} from '../runtime/task-recovery.ts';
import { PiSettings } from '../pi-settings.ts';
import { handleMethod } from '../handlers/index.ts';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BotRuntime, type SessionFactory } from '../runtime/runtime.ts';
import { ProactiveService, type Monitor } from '../runtime/proactive.ts';
import { OpenMatterTrigger } from '../runtime/openmatter-trigger.ts';
import { livePiFactory } from '../live-pi.ts';
import { createFileChangeDetector } from '../runtime/proactive-detectors.ts';
import { DesktopClient } from '../../pi/desktop-client.ts';
import { Router } from './router.ts';
import { DaemonConnection } from './connection.ts';
import { PiBotError } from './errors.ts';
import { CredentialBroker } from '../runtime/credentials.ts';
import { RequestBroker } from '../requests/request-broker.ts';
import { zeroUsage } from '../events/turn-tracker.ts';
import { jobView, routineView } from '../events/derive.ts';
import { projectChannelMessage, redactChannelText } from '../runtime/channel-messages.ts';
import type { Thread, Turn, Item, DaemonStatus, Snapshot } from '../../sdk/protocol/index.ts';
import type { Envelope, Outbound } from '../../pi/types.ts';
export class PiBotDaemon {
    status: DaemonStatus = 'starting';
    readonly startedAt = Date.now();
    private lastTriggerHalted=false;
    readonly connections = new Map<string, DaemonConnection>();
    readonly router = new Router(this);
    piSettings?: PiSettings;
    private piReloadPending = false;
    private piReloading = false;
    private lastRetention = 0;
    credentials!: CredentialBroker;
    runtime!: BotRuntime;
    proactive!: ProactiveService;
    trigger!: OpenMatterTrigger;
    broker!: RequestBroker;
    live?: Awaited<ReturnType<typeof livePiFactory>>;
    desktop?: DesktopClient;
    private timer?: ReturnType<typeof setInterval>;
    private closePromise?: Promise<void>;
    private detectors: Record<string, ReturnType<typeof createFileChangeDetector>> = {};
    private constructor(readonly dataDir: string, readonly options: {
        factory?: SessionFactory;
        approvalRequired?: boolean;
        approvalTimeoutMs?: number;
        idleUnloadMs?: number;
        maxLoadedThreads?: number;
        drainTimeoutMs?: number;
        modelRound?: {
            maxRequests: number;
            durationMs: number;
        };
        piOptions?: {
            agentDir?: string;
            cwd?: string;
        };
    }) {
    }
    static async create(options: {
        dataDir?: string;
        factory?: SessionFactory;
        approvalRequired?: boolean;
        approvalTimeoutMs?: number;
        idleUnloadMs?: number;
        maxLoadedThreads?: number;
        drainTimeoutMs?: number;
        modelRound?: {
            maxRequests: number;
            durationMs: number;
        };
        piOptions?: {
            agentDir?: string;
            cwd?: string;
        };
    } = {}) {
        const d = new PiBotDaemon(resolve(options.dataDir ?? process.env.PI_BOT_DIR ?? 'work/gui/demo'), options);
        mkdirSync(d.dataDir, {
            recursive: true
        });
        d.status = 'recovering';
        d.credentials = new CredentialBroker(Date.now, {
            created: form => {
                const source = d.runtime.store.list<Envelope>('inbox').find(e => e.to === form.scope.botId && e.taskId === form.scope.taskId);
                if (!source)
                    throw new PiBotError('notFound', 'Unknown credential source');
                d.runtime.assertTaskCurrent(source);
                d.broker.create('credential', source, {
                    botId: form.scope.botId, taskId: form.scope.taskId, sourceMessageId: source.id, tool: form.scope.tool, label: form.label, formUrl: '/credential/' + form.requestId, formId: form.requestId, expiresAt: form.expiresAt
                }, form.expiresAt, 'req_credential:' + form.requestId);
            },
            submitted: (id, scope) => {
                const request = d.runtime.store.get<any>('requests', 'req_credential:' + id);
                if (!request || request.status !== 'pending')
                    throw new PiBotError('invalidRequest', 'Credential request is no longer pending');
                const source = d.runtime.store.get<Envelope>('inbox', request.params.sourceMessageId);
                if (!source)
                    throw new PiBotError('notFound', 'Credential source missing');
                d.runtime.assertTaskCurrent(source);
                d.broker.finish(request, 'resolved', {
                    submitted: true
                }, 'directForm');
            }
        });
        d.detectors.file = createFileChangeDetector(resolve(process.env.PI_BOT_WATCH_FILE ?? 'README.md'));
        if (!options.factory)
            d.live = await livePiFactory(d.dataDir, () => d.proactive, d.credentials, options.piOptions, budget => d.budgetChanged(budget), options.modelRound);
        try {
            d.piSettings = await PiSettings.create(options.piOptions);
            d.piSettings.onLogin = () => d.requestPiReload();
        }
        catch { /* GUI reports unavailable without leaking native auth errors. */
        }
        d.desktop = DesktopClient.load(resolve('work/gui/desktop/control.json'));
        d.trigger = new OpenMatterTrigger(join(d.dataDir, 'triggers.db'));
        d.runtime = new BotRuntime(join(d.dataDir, 'runtime.db'), options.factory ?? d.live!.factory, {
            isolateConversations: true, activation: d.trigger
        });
        d.trigger.bind(id => d.runtime.activateInbox(id));
        for (const m of d.runtime.store.list<Monitor>('monitors'))
            if (m.detector.startsWith('file:'))
                d.registerFile(m.detector.slice(5));
        d.proactive = new ProactiveService(d.runtime, {
            detectors: d.detectors
        });
        d.broker = new RequestBroker(d.runtime, d.connections, options.approvalTimeoutMs);
        (d.runtime as any).requestBroker = d.broker;
        for (const request of d.broker.list())
            if (request.kind === 'credential' && request.status === 'pending')
                d.credentials.restoreForm({
                    requestId: String(request.params.formId), scope: {
                        botId: request.botId, taskId: String(request.params.taskId), tool: String(request.params.tool)
                    }, label: String(request.params.label), expiresAt: request.expiresAt!, fields: [{
                            name: 'secret', type: 'password', autocomplete: 'off'
                        }]
                });
        if (options.approvalRequired)
            d.runtime.approvals = {
                request: input => d.broker.approval(input)
            };
        d.setStatus('ready');
        if (d.live)
            d.runtime.store.transaction(() => d.log.append('daemon/configurationChanged', {
                mode: `真实 Pi · ${d.live!.model}`, configuration: d.live!.configuration, ...(d.live?.budget ? {
                    budget: d.live.budget
                } : {})
            }));
        d.runtime.start();
        d.lastTriggerHalted=d.trigger.halted;
        d.runtime.store.transaction(()=>d.log.append('daemon/triggerChanged',{trigger:{implementation:'OpenMatter SQLite DurableInbox',halted:d.trigger.halted,queued:d.trigger.inspect().filter(r=>r.state!=='completed').length}}));
        d.proactive.start();
        d.timer = setInterval(() => {
            if (!d.runtime.store.db.isTransaction)
                d.trigger.flush();
            if(d.lastTriggerHalted!==d.trigger.halted){d.lastTriggerHalted=d.trigger.halted;d.runtime.store.transaction(()=>d.log.append('daemon/triggerChanged',{trigger:{implementation:'OpenMatter SQLite DurableInbox',halted:d.trigger.halted,queued:d.trigger.inspect().filter(r=>r.state!=='completed').length}}));}
            void d.runtime.deliver(async () => {
            }).catch(() => {
            });
            void d.unloadIdle();
            void d.applyPiSettings();
            if (Date.now() - d.lastRetention > 60000) {
                d.lastRetention = Date.now();
                d.log.compact();
            }
        }, 100);
        d.timer.unref();
        return d;
    }
    private budgetChanged(budget: Record<string, number>) {
        if (this.runtime && this.status !== 'stopped')
            this.runtime.store.transaction(() => this.log.append('daemon/budgetUpdated', {
                budget
            }));
    }
    get piConfigurationPending() {
        return this.piReloadPending;
    }
    async requestPiReload() {
        if (this.options.factory)
            return {
                pending: false, applied: false
            };
        this.piReloadPending = true;
        await this.applyPiSettings();
        return {
            pending: this.piReloadPending, applied: !this.piReloadPending && !(this.live?.configuration as any)?.setupRequired
        };
    }
    private async applyPiSettings() {
        if (!this.piReloadPending || this.piReloading || this.status !== 'ready' || this.options.factory || !this.runtime.canReconfigure)
            return;
        this.piReloading = true;
        let next: Awaited<ReturnType<typeof livePiFactory>> | undefined;
        try {
            next = await livePiFactory(this.dataDir, () => this.proactive, this.credentials, this.options.piOptions, budget => this.budgetChanged(budget), this.options.modelRound);
            if (await this.runtime.reconfigure(next.factory)) {
                const previous = this.live;
                this.live = next;
                next = undefined;
                this.piReloadPending = false;
                await previous?.dispose();
                this.runtime.store.transaction(() => this.log.append('daemon/configurationChanged', {
                    mode: `真实 Pi · ${this.live!.model}`, configuration: this.live!.configuration, ...(this.live?.budget ? {
                        budget: this.live.budget
                    } : {})
                }));
            }
        }
        catch { /* Keep running configuration; retry at the next quiescent boundary. */
        }
        finally {
            await next?.dispose();
            this.piReloading = false;
        }
    }
    get log() {
        return this.runtime.store.events;
    }
    connect(transport = 'in-process') {
        const c = new DaemonConnection(this, transport);
        this.connections.set(c.id, c);
        return c;
    }
    setStatus(to: DaemonStatus) {
        const from = this.status;
        this.status = to;
        if (this.runtime)
            this.runtime.store.transaction(() => this.log.append('daemon/statusChanged', {
                from, to, at: Date.now()
            }));
    }
    snapshot(botIds?: string[]): Snapshot & Record<string, any> {
        return this.runtime.store.transaction(() => {
            const all = this.runtime.store;
            const own = (r: any) => !botIds || botIds.includes(r.botId ?? r.to ?? r.id);
            const threads = all.list<Thread>('threads').filter(own);
            const ids = new Set(threads.map(t => t.id));
            const turns = all.list<Turn>('turns').filter(own);
            const items = all.list<Item>('items').filter(i => ids.has(i.threadId));
            const usage = zeroUsage();
            for (const t of turns)
                for (const key of Object.keys(usage) as (keyof typeof usage)[])
                    usage[key] += t.usage?.[key] ?? 0;
            const requests = this.broker.list().filter(own), bots = this.runtime.listBots().filter(own);
            return {
                seq: this.log.seq, status: this.status, bots, groups: this.runtime.listGroups(), threads, turns, activeTurns: turns.filter(t => t.status === 'running'), items, requests, pendingRequests: requests.filter(r => r.status === 'pending'), routines: [...all.list<any>('schedules').filter(own).map(r => routineView('schedules', r)), ...all.list<any>('monitors').filter(own).map(r => routineView('monitors', r))], jobs: all.list<any>('jobs').filter(own).map(jobView), ...(this.live?.budget ? {
                    budget: this.live.budget
                } : {}), usage,
                mode: this.live ? `真实 Pi · ${this.live.model}` : '测试 runtime', configuration: this.live?.configuration, desktop: !!this.desktop, watchFile: resolve(process.env.PI_BOT_WATCH_FILE ?? 'README.md'), trigger: {
                    implementation: 'OpenMatter SQLite DurableInbox', halted: this.trigger.halted, queued: this.trigger.inspect().filter(r => r.state !== 'completed').length
                },
                messages: items.map(i => i.message).filter(Boolean), groupMessages: all.list('group_messages'), errors: [], states: Object.fromEntries(bots.map(b => [b.id, {
                        ...all.state(b.id), proactive: {
                            schedules: this.proactive.listSchedules(b.id), monitors: this.proactive.listMonitors(b.id).map(({ cursor, baseline, ...m }) => m)
                        }
                    }]))
            };
        });
    }
    private registerFile(path: string) {
        const file = resolve(path), root = resolve('.');
        if (!file.startsWith(root + '/'))
            throw new PiBotError('forbidden', 'Monitor file must be in the workspace');
        const name = 'file:' + file;
        this.detectors[name] = createFileChangeDetector(file);
        return name;
    }
    required<T>(table: string, id: string) {
        const value = this.runtime.store.get<T>(table, id);
        if (!value)
            throw new PiBotError('notFound', 'Unknown ' + table);
        return value;
    }
    page<T extends {
        id: string;
    }>(items: T[], p: any, max = 100) {
        let start = 0;
        if (p.cursor) {
            const i = items.findIndex(x => x.id === p.cursor);
            if (i < 0)
                throw new PiBotError('invalidParams', 'Invalid cursor');
            start = i + 1;
        }
        const limit = p.limit ?? max;
        const selected = items.slice(start, start + limit);
        return {
            items: selected, nextCursor: start + limit < items.length ? selected.at(-1)!.id : null
        };
    }
    async handle(c: DaemonConnection, method: string, p: any): Promise<any> {
        return handleMethod(this, c, method, p);
    }
    startTurn(p: any) {
        if ((this.live?.configuration as any)?.setupRequired)
            throw new PiBotError('setupRequired', 'Configure native Pi first');
        if (this.live?.budget && (this.live.budget.requests >= this.live.budget.maxRequests || this.live.budget.expiresAt <= Date.now()))
            throw new PiBotError('budgetExhausted', 'Model budget exhausted');
        let e: any;
        if (p.groupId) {
            const group: any = this.required('groups', p.groupId);
            if (!group.memberIds.includes(p.botId))
                throw new PiBotError('forbidden', 'Bot is not a group member');
            e = this.runtime.acceptGroupUser(p.groupId, p.text, p.key);
        }
        else {
            const bot: any = this.required('bots', p.botId);
            let route: Envelope['route'] = bot.channelId ? {
                channelId: bot.channelId, conversationId: bot.channelId, threadId: 'gui', senderId: 'user'
            } : undefined;
            if (p.threadId) {
                const thread = this.required<Thread>('threads', p.threadId);
                if (thread.botId !== p.botId)
                    throw new PiBotError('forbidden', 'Thread belongs to another bot');
                route = thread.scope.channelId ? {
                    channelId: thread.scope.channelId, conversationId: thread.scope.conversationId ?? thread.scope.channelId, threadId: thread.scope.threadId ?? '', senderId: 'user'
                } : undefined;
            }
            e = this.runtime.accept({
                to: p.botId, text: p.text, key: p.key, route
            });
        }
        const thread = this.runtime.tracker.ensure(e);
        return {
            inputId: e.id, threadId: thread.id, status: 'queued', ...(e.deliveries ? {
                inputIds: e.deliveries.map((x: any) => x.id)
            } : {})
        };
    }
    createRoutine(p: any) {
        const bot: any = this.required('bots', p.botId);
        const group: any = p.groupId ? this.required('groups', p.groupId) : undefined;
        if (group && !group.memberIds.includes(bot.id))
            throw new PiBotError('forbidden', 'Bot is not a group member');
        if (p.kind === 'schedule' && p.at <= Date.now())
            throw new PiBotError('invalidParams', 'Schedule must be in the future');
        const channel = group?.id ?? bot.channelId;
        const source: Envelope = {
            id: randomUUID(), from: 'user', to: bot.id, kind: 'user', text: redactChannelText(p.prompt), key: p.key ?? randomUUID(), taskId: randomUUID(), replyTo: null, hop: 0, state: 'processed', createdAt: Date.now(), ...(channel ? {
                route: {
                    channelId: channel, conversationId: channel, threadId: 'gui', senderId: 'user'
                }
            } : {})
        };
        return this.runtime.store.transaction(() => {
            this.runtime.store.put('inbox', source);
            const routine = p.kind === 'schedule' ? this.proactive.createSchedule(source, {
                key: source.key, prompt: source.text, at: p.at, timezone: p.timezone, intervalMs: p.intervalMs, misfire: 'coalesce', overlap: 'skip'
            }) : this.proactive.createMonitor(source, {
                key: source.key, prompt: source.text, detector: p.filePath ? this.registerFile(p.filePath) : 'file', intervalMs: p.intervalMs, deadline: p.deadline
            });
            return routineView(p.kind === 'schedule' ? 'schedules' : 'monitors', routine);
        });
    }
    async routineAction(action: string, id: string) {
        const match = id.match(/^(schedule|monitor):(.+)$/);
        if (!match)
            throw new PiBotError('invalidParams', 'Invalid routine ID');
        const [_, kind, key] = match;
        const table = kind === 'schedule' ? 'schedules' : 'monitors';
        const routine: any = this.required(table, key);
        const p: any = this.proactive;
        const names: Record<string, string> = {
            pause: 'pause', resume: 'resume', cancel: 'cancel', enable: 'enable', 'dry-run': 'dryRun'
        };
        const fn = names[action] + (kind === 'schedule' ? 'Schedule' : 'Monitor');
        if (typeof p[fn] !== 'function')
            throw new PiBotError('invalidRequest', 'Unsupported routine action');
        const result = await p[fn](routine.botId, key);
        return action === 'dry-run' ? {
            decision: result.decision, ...(result.error ? {
                error: result.error
            } : {})
        } : routineView(table, this.required(table, key));
    }
    taskRecovery(id:string){
        const e=this.required<Envelope>('inbox',id);
        if(e.state!=='uncertain')return {canRetry:false,reason:'inactive'};
        try{this.runtime.assertTaskCurrent(e);}catch{return {canRetry:false,reason:'superseded'};}
        return recoveryPlan(this.runtime.store,e);
    }
    reconcile(id: string) {
        const r = this.runtime, s = r.store;
        const e = this.required<Envelope>('inbox', id);
        if (e.state !== 'uncertain')
            throw new PiBotError('invalidRequest', 'Task does not need review');
        const delivered = s.list<Outbound>('outbox').filter(o => o.replyTo === id && o.botId === e.to && o.taskId === e.taskId && o.state === 'delivered');
        if (delivered.length) {
            r.reconcileInbox(id, {
                outcome: 'processed', evidence: delivered.map(o => o.id)
            });
            return {
                outcome: 'processed'
            };
        }
        const plan=this.taskRecovery(id);
        if(!plan.canRetry)throw new PiBotError('reviewRequired','Effects require host review; no automatic replay');
        r.assertTaskCurrent(e);
        r.reconcileInbox(id, {
            outcome: 'queued', evidence: [plan.reason+':'+id], note: 'Host verified checkpoint: '+plan.reason+'; no mutable effects or output'
        });
        return {
            outcome: 'queued'
        };
    }
    private unloading = false;
    private async unloadIdle() {
        if (this.unloading)
            return;
        this.unloading = true;
        try {
            const loaded = this.runtime.store.list<Thread>('threads').filter(t => t.status === 'loaded').sort((a, b) => a.lastActivityAt - b.lastActivityAt);
            let excess = loaded.length - (this.options.maxLoadedThreads ?? 32);
            for (const t of loaded)
                if (excess > 0 || Date.now() - t.lastActivityAt > (this.options.idleUnloadMs ?? 600000)) {
                    const result = await this.runtime.unloadThread(t.id);
                    if (result.unloaded)
                        excess--;
                }
        }
        finally {
            this.unloading = false;
        }
    }
    close(timeout = this.options.drainTimeoutMs ?? 30000) {
        return this.closePromise ??= (async () => {
            this.setStatus('draining');
            this.runtime.beginDrain();
            clearInterval(this.timer);
            await this.proactive.close();
            let deadline: ReturnType<typeof setTimeout> | undefined;
            const finished = await Promise.race([this.runtime.idle().then(() => true), new Promise<boolean>(resolve => {
                    deadline = setTimeout(() => resolve(false), timeout);
                })]);
            clearTimeout(deadline);
            if (finished)
                await this.runtime.deliver(async () => {
                });
            this.broker.close();
            this.setStatus('stopped');
            for (const c of [...this.connections.values()])
                c.close();
            if (finished)
                await this.runtime.close();
            else
                this.runtime.forceClose();
            this.trigger.close();
            this.credentials.close();
            this.piSettings?.close();
            await this.live?.dispose();
        })();
    }
}
