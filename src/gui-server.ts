import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotRuntime, type SessionFactory } from './runtime.ts';
import { projectChannelMessage, redactChannelText } from './channel-messages.ts';
import { ProactiveService, type Monitor } from './proactive.ts';
import { createFileChangeDetector } from './proactive-detectors.ts';
import { OpenMatterTrigger } from './openmatter-trigger.ts';
import { guiPiFactory } from './gui-live.ts';
import type { Envelope, Outbound, Job } from './store.ts';
function modelUsage(directory: string, modelId?: string) {
    const usage = {
        responses: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, totalTokens: 0, estimatedUsd: 0
    };
    const files = (root: string): string[] => readdirSync(root, {
        withFileTypes: true
    }).flatMap(item => item.isDirectory() ? files(join(root, item.name)) : item.name.endsWith('.jsonl') ? [join(root, item.name)] : []);
    try {
        for (const file of files(join(directory, 'sessions')))
            for (const line of readFileSync(file, 'utf8').split('\n')) {
                try {
                    const v = JSON.parse(line);
                    const u = v.message?.role === 'assistant' ? v.message.usage : undefined;
                    if (!u || (modelId && v.message.model !== modelId) || !(Number(u.totalTokens) > 0))
                        continue;
                    usage.responses++;
                    for (const key of ['input', 'output', 'cacheRead', 'reasoning', 'totalTokens'] as const)
                        usage[key] += Number(u[key] ?? 0);
                    usage.estimatedUsd += Number(u.cost?.total ?? 0);
                }
                catch {
                }
            }
    }
    catch {
    }
    return usage;
}
export function validateGuiMessage(value: unknown, bots: string[]) {
    const v = value as {
        to?: unknown;
        text?: unknown;
    };
    if (!v || typeof v.to !== 'string' || !bots.includes(v.to) || typeof v.text !== 'string' || !v.text.trim() || v.text.length > 20000)
        throw Error('请选择 bot 并输入 1–20000 字的消息');
    return {
        to: v.to, text: v.text.trim()
    };
}
export async function startGui(options: {
    factory?: SessionFactory;
} = {}) {
    const dir = resolve(process.env.PI_BOT_DIR ?? 'work/gui/demo');
    mkdirSync(dir, {
        recursive: true
    });
    const detectors: Record<string, ReturnType<typeof createFileChangeDetector>> = {
        file: createFileChangeDetector(resolve(process.env.PI_BOT_WATCH_FILE ?? 'README.md'))
    };
    let proactive: ProactiveService;
    const live = options.factory ? undefined : await guiPiFactory(dir, host => proactive);
    const trigger = new OpenMatterTrigger(join(dir, 'triggers.db'));
    const runtime = new BotRuntime(join(dir, 'runtime.db'), options.factory ?? live!.factory, {
        isolateConversations: true, activation: trigger
    });
    trigger.bind(id => runtime.activateInbox(id));
    const registerFile = (path: string) => {
        const file = resolve(path);
        const root = resolve('.');
        if (!file.startsWith(root + '/'))
            throw Error('监控文件须位于当前仓库');
        const name = 'file:' + file;
        detectors[name] = createFileChangeDetector(file);
        return name;
    };
    for (const m of runtime.store.list<Monitor>('monitors'))
        if (m.detector.startsWith('file:'))
            registerFile(m.detector.slice(5));
    proactive = new ProactiveService(runtime, {
        detectors
    });
    if (!runtime.listBots().length)
        runtime.createBot('助手', '处理任务与消息');
    runtime.start();
    proactive.start();
    const token = randomUUID();
    const timer = setInterval(() => {
        if (!runtime.store.db.isTransaction)
            trigger.flush();
        void runtime.deliver(async () => {
        });
    }, 100);
    const server = createServer(async (req, res) => {
        const json = (data: unknown, status = 200) => {
            res.writeHead(status, {
                'Content-Type': 'application/json', 'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify(data));
        };
        try {
            const url = new URL(req.url!, 'http://localhost');
            if (url.pathname.startsWith('/api/')) {
                if (req.headers.host !== `127.0.0.1:${(server.address() as {
                    port: number;
                }).port}`)
                    return json({
                        error: 'Invalid host'
                    }, 403);
                if (req.method === 'GET' && url.pathname === '/api/state')
                    return json({
                        mode: live ? `真实 Pi · ${live.model}` : '测试 runtime', configuration: live?.configuration, budget: live?.budget, usage: modelUsage(dir, live?.model), watchFile: resolve(process.env.PI_BOT_WATCH_FILE ?? 'README.md'), token, bots: runtime.listBots(), trigger: {
                            implementation: 'OpenMatter SQLite DurableInbox', halted: trigger.halted, queued: trigger.inspect().filter(r => r.state !== 'completed').length
                        }, groups: runtime.listGroups(), groupMessages: runtime.store.list('group_messages'), messages: [...runtime.store.list<Envelope>('inbox').map(e => projectChannelMessage('inbox', e)), ...runtime.store.list<Outbound>('outbox').filter(e => e.state === 'delivered').map(e => projectChannelMessage('outbox', e))].sort((a, b) => a.receivedAt - b.receivedAt), errors: runtime.errors.map(() => 'Pi 执行未完成，请检查任务状态；不会自动重放'), jobs: runtime.store.list<Job>('jobs').map(j => ({
                            id: j.id, botId: j.botId, tool: j.tool, state: j.state, error: j.error ? redactChannelText(j.error) : undefined
                        })), states: Object.fromEntries(runtime.listBots().map(b => [b.id, {
                                ...runtime.store.state(b.id), proactive: {
                                    schedules: proactive.listSchedules(b.id), monitors: proactive.listMonitors(b.id).map(({ cursor, baseline, ...m }) => m)
                                }
                            }]))
                    });
                if (req.method !== 'POST' || req.headers['x-gui-token'] !== token || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`))
                    return json({
                        error: 'Forbidden'
                    }, 403);
                let body = '';
                for await (const chunk of req) {
                    body += chunk;
                    if (body.length > 100000)
                        throw Error('Request too large');
                }
                const data = JSON.parse(body);
                if (url.pathname === '/api/message') {
                    if (live?.configuration && 'setupRequired' in live.configuration && live.configuration.setupRequired)
                        return json({
                            error: live.configuration.message
                        }, 409);
                    if (live?.budget && (Date.now() >= live.budget.expiresAt || live.budget.requests >= live.budget.maxRequests || live.budget.inputReserved >= live.budget.maxInput))
                        throw Error('本轮请求或时间额度已用完；任务不会被自动重放');
                    const input = validateGuiMessage(data, runtime.listBots().map(b => b.id));
                    const bot = runtime.listBots().find(b => b.id === input.to)!;
                    const group = data.groupId ? runtime.listGroups().find(g => g.id === data.groupId) : undefined;
                    if (data.groupId && (!group || !group.memberIds.includes(bot.id)))
                        throw Error('Bot 不属于该群');
                    if (group)
                        return json(runtime.acceptGroupUser(group.id, input.text, typeof data.key === 'string' ? data.key : randomUUID()));
                    const channel = bot.channelId;
                    return json(runtime.accept({
                        ...input, key: typeof data.key === 'string' ? data.key : randomUUID(), ...(channel ? {
                            route: {
                                channelId: channel, conversationId: channel, threadId: 'gui', senderId: 'user'
                            }
                        } : {})
                    }));
                }
                if (url.pathname === '/api/group') {
                    if (typeof data.name !== 'string' || !Array.isArray(data.memberIds) || data.memberIds.some((id: unknown) => typeof id !== 'string'))
                        throw Error('Invalid group');
                    return json(runtime.createGroup(data.name, data.memberIds));
                }
                if (url.pathname === '/api/bot') {
                    if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 60)
                        throw Error('请输入 bot 名称');
                    return json(runtime.createBot(data.name.trim()));
                }
                if (url.pathname === '/api/routine/create') {
                    const input = validateGuiMessage({
                        to: data.botId, text: data.prompt
                    }, runtime.listBots().map(b => b.id));
                    if (data.kind !== 'schedule' && data.kind !== 'monitor')
                        throw Error('Invalid routine kind');
                    if (data.kind === 'schedule' && (!Number.isSafeInteger(data.at) || data.at <= Date.now()))
                        throw Error('请选择未来时间');
                    const bot = runtime.listBots().find(b => b.id === input.to)!;
                    const group = data.groupId ? runtime.listGroups().find(g => g.id === data.groupId) : undefined;
                    if (data.groupId && (!group || !group.memberIds.includes(bot.id)))
                        throw Error('Bot 不属于该群');
                    const channel = group?.id ?? bot.channelId;
                    // A GUI definition is an explicit host action, not a request to invoke the model now.
                    const source: Envelope = {
                        id: randomUUID(), from: 'user', to: bot.id, kind: 'user', text: redactChannelText(input.text), key: randomUUID(), taskId: randomUUID(), replyTo: null, hop: 0, state: 'processed', createdAt: Date.now(), ...(channel ? {
                            route: {
                                channelId: channel, conversationId: channel, threadId: 'gui', senderId: 'user'
                            }
                        } : {})
                    };
                    const result = runtime.store.transaction(() => {
                        runtime.store.put('inbox', source);
                        return data.kind === 'schedule' ? proactive.createSchedule(source, {
                            key: source.key, prompt: source.text, at: data.at, timezone: data.timezone ?? 'Asia/Shanghai', intervalMs: data.intervalMs, misfire: 'coalesce', overlap: 'skip'
                        }) : proactive.createMonitor(source, {
                            key: source.key, prompt: source.text, detector: data.filePath ? registerFile(data.filePath) : 'file', intervalMs: data.intervalMs, deadline: data.deadline
                        });
                    });
                    return json(result);
                }
                if (url.pathname === '/api/routine/action') {
                    if (data.kind === 'schedule') {
                        if (data.action === 'pause')
                            proactive.pauseSchedule(data.botId, data.id);
                        else if (data.action === 'resume')
                            proactive.resumeSchedule(data.botId, data.id);
                        else if (data.action === 'cancel')
                            proactive.cancelSchedule(data.botId, data.id);
                        else
                            throw Error('Invalid schedule action');
                    }
                    else if (data.kind === 'monitor') {
                        if (data.action === 'dry-run')
                            return json(await proactive.dryRunMonitor(data.botId, data.id));
                        else if (data.action === 'enable')
                            proactive.enableMonitor(data.botId, data.id);
                        else if (data.action === 'pause')
                            proactive.pauseMonitor(data.botId, data.id);
                        else if (data.action === 'cancel')
                            proactive.cancelMonitor(data.botId, data.id);
                        else
                            throw Error('Invalid monitor action');
                    }
                    else
                        throw Error('Invalid routine kind');
                    return json({
                        ok: true
                    });
                }
                if (url.pathname === '/api/job') {
                    const r = runtime.jobResult(data.botId, data.id, data.offset ?? 0, 4096);
                    return json({
                        ...r, text: r.text ? redactChannelText(r.text) : r.text, error: r.error ? redactChannelText(r.error) : r.error
                    });
                }
                if (url.pathname === '/api/reconcile') {
                    const e = runtime.store.get<Envelope>('inbox', data.id);
                    if (!e || e.state !== 'uncertain')
                        throw Error('Task does not need review');
                    const delivered = runtime.store.list<Outbound>('outbox').filter(o => o.replyTo === e.id && o.botId === e.to && o.taskId === e.taskId && o.state === 'delivered');
                    if (delivered.length) {
                        runtime.reconcileInbox(e.id, {
                            outcome: 'processed', evidence: delivered.map(o => o.id)
                        });
                        return json({
                            outcome: 'processed'
                        });
                    }
                    if (e.consumedAt || e.resolvedAt || e.error !== 'Error: Provider request refused or failed before streaming' || runtime.store.list<Job>('jobs').some(j => j.taskId === e.taskId) || runtime.store.list<Outbound>('outbox').some(o => o.taskId === e.taskId))
                        throw Error('已有执行痕迹，需单独核查；不会自动重放');
                    runtime.assertTaskCurrent(e);
                    runtime.reconcileInbox(e.id, {
                        outcome: 'queued', evidence: ['prestream-refusal:' + e.id], note: 'Host verified no native consumption, job or outbox effects. User requested recovery; reuse the original task.'
                    });
                    return json({
                        outcome: 'queued'
                    });
                }
                if (url.pathname === '/api/answer')
                    return json(runtime.answer(data.id, data.text, randomUUID()));
                if (url.pathname === '/api/cancel') {
                    if (data.kind === 'schedule')
                        proactive.cancelSchedule(data.botId, data.id);
                    else if (data.kind === 'monitor')
                        proactive.cancelMonitor(data.botId, data.id);
                    else
                        throw Error('Unknown routine');
                    return json({
                        ok: true
                    });
                }
                return json({
                    error: 'Not found'
                }, 404);
            }
            const root = resolve('gui/dist');
            const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
            if (!file.startsWith(root + '/'))
                return json({
                    error: 'Not found'
                }, 404);
            const types: Record<string, string> = {
                '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'
            };
            res.writeHead(200, {
                'Content-Type': types[extname(file)] ?? 'application/octet-stream'
            });
            res.end(readFileSync(file));
        }
        catch (error) {
            if (!res.headersSent)
                json({
                    error: error instanceof Error ? error.message : 'Request failed'
                }, 400);
            else
                res.end();
        }
    });
    await new Promise<void>(r => server.listen(Number(process.env.PI_BOT_GUI_PORT ?? 4317), '127.0.0.1', r));
    console.log(`Pi Bot GUI: http://127.0.0.1:${(server.address() as {
        port: number;
    }).port} (${live ? 'Pi' : 'test'})`);
    const close = async () => {
        clearInterval(timer);
        await proactive.close();
        server.close();
        await runtime.idle();
        await runtime.deliver(async () => {
        });
        await runtime.close();
        await live?.dispose();
        trigger.close();
    };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
    return {
        server, runtime, proactive, trigger, close
    };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    await startGui();
