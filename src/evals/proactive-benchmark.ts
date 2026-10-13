import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { ModelRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from '../daemon/runtime.ts';
import { piSessionFactory } from '../pi/session-factory.ts';
import { ProactiveService } from '../daemon/proactive.ts';
import { scoreResponseBenchmark, type ResponseExpectation } from './response-benchmark.ts';
import { observeEvaluationTools, redactTraceValue, type EvaluationTrace } from './evaluation-trace.ts';
import type { Envelope, Job, Outbound } from '../daemon/store.ts';
/** Calibrates host scheduling with actual Pi/tools/file effects and scripted decisions.
 * This is explicitly not a real-model speed or intelligence benchmark. */
export async function runProactiveBenchmark(directory: string) {
    await mkdir(join(directory, 'artifacts'), {
        recursive: true
    });
    const lifetime = new AbortController();
    const timeout = setTimeout(() => lifetime.abort(), 10000);
    const trace: EvaluationTrace = {
        inbox: [], jobs: [], outbox: [], calls: [], results: [], boundaries: []
    };
    const expected: ResponseExpectation[] = [];
    const specifications = new Map<string, number[]>();
    let order = 0, requests = 0, refusedRequests = 0, detectorChanged = false;
    let runtime!: BotRuntime;
    let service!: ProactiveService;
    const reads = new Set<string>();
    const peerPlans = new Map<string, {
        sourceId: string;
        targetId: string;
        next: number;
    }>();
    const sumTool: ToolDefinition = {
        name: 'calculate_sum', label: 'Calculate sum', description: 'Compute and save local arithmetic result.',
        parameters: Type.Object({
            values: Type.Array(Type.Number()), message_id: Type.String()
        }),
        async execute(_id, p: any) {
            await new Promise(r => setImmediate(r));
            const sum = p.values.reduce((a: number, b: number) => a + b, 0);
            await writeFile(join(directory, 'artifacts', `${p.message_id}.json`), JSON.stringify({
                sum
            }));
            return {
                content: [{
                        type: 'text', text: JSON.stringify({
                            sum
                        })
                    }], details: {
                    sum
                }
            };
        }
    };
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(directory, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    // Independent faux providers avoid sharing response cursors across group sessions.
    runtime = new BotRuntime(join(directory, 'runtime.db'), async (bot, host) => {
        const faux = fauxProvider({
            provider: `benchmark-${bot.id}`, models: [{
                    id: 'test', contextWindow: 512000, maxTokens: 4096
                }], tokensPerSecond: 1000000
        });
        faux.setResponses(Array.from({
            length: 128
        }, () => (ctx: any) => {
            const visible = JSON.stringify(ctx.messages);
            const plan = peerPlans.get(bot.id);
            if (plan && plan.next < 4) {
                const index = plan.next++;
                return fauxAssistantMessage(fauxToolCall('send_to_bot', {
                    bot_id: plan.targetId, source_message_id: plan.sourceId, key: `peer:${index}`, priority: Boolean(index % 2), text: 'Peer observation only; no reply.'
                }, {
                    id: `peer:${index}`
                }), {
                    stopReason: 'toolUse'
                });
            }
            const e = host.store.list<Envelope>('inbox').find(e => e.to === bot.id && ['processing', 'processed'].includes(e.state) && visible.includes(e.id) && specifications.has(e.id) && !host.store.list<Outbound>('outbox').some(o => o.replyTo === e.id));
            if (!e)
                return fauxAssistantMessage('internal');
            const job = host.store.list<Job>('jobs').find(j => j.messageId === e.id);
            if (!job)
                return fauxAssistantMessage(fauxToolCall('start_job', {
                    tool: 'calculate_sum', args: {
                        values: specifications.get(e.id)!
                    }, key: `sum:${e.id}`, source_message_id: e.id
                }, {
                    id: `start:${e.id}`
                }), {
                    stopReason: 'toolUse'
                });
            if (job.state !== 'completed')
                return fauxAssistantMessage('internal');
            if (!reads.has(job.id)) {
                reads.add(job.id);
                return fauxAssistantMessage(fauxToolCall('job_result', {
                    job_id: job.id, limit: 8000
                }, {
                    id: `read:${job.id}`
                }), {
                    stopReason: 'toolUse'
                });
            }
            const saved = host.store.get<Job>('jobs', job.id)!;
            const sum = JSON.parse(saved.result!).result.details.sum;
            return fauxAssistantMessage(fauxToolCall('send_message', {
                text: `SUM ${sum}`, key: `final:${e.id}`, source_message_id: e.id
            }, {
                id: `reply:${e.id}`
            }), {
                stopReason: 'toolUse'
            });
        }));
        return piSessionFactory({
            dir: join(directory, 'sessions'), modelRuntime: models, model: faux.getModel(), tools: [sumTool], allowTools: ['calculate_sum'], jobSourceArguments: {
                calculate_sum: 'message_id'
            }, modelNativeTools: ['start_job', 'job_result', 'send_message', 'send_to_bot'], extensions: [pi => pi.registerProvider(faux.provider), observeEvaluationTools(trace, bot.id, () => ++order)], proactive: () => service, inferenceSignal: lifetime.signal, maxRequestsPerWake: 128, maxOutputTokens: 4096, beforeProviderRequest() {
                if (requests >= 128) {
                    refusedRequests++;
                    throw Error('Benchmark request bound reached');
                }
                requests++;
            }, preemptInference: false
        })(bot, host);
    }, {
        maxJobs: 8, maxPending: 100
    });
    service = new ProactiveService(runtime, {
        detectors: {
            build: async () => detectorChanged ? {
                decision: 'wake', dedupKey: 'build-complete', payload: 'local build complete'
            } : {
                decision: 'silent', cursor: 'pending'
            }
        }
    });
    const bots = [runtime.createBot('alpha', '', 'alpha'), runtime.createBot('beta', '', 'beta')];
    const coordinators = [runtime.createBot('alpha-coordinator', '', 'alpha'), runtime.createBot('beta-coordinator', '', 'beta')];
    const routes = bots.map((b, i) => ({
        channelId: b.channelId!, threadId: 'tasks', senderId: i ? 'bob' : 'alice'
    }));
    const delivery = setInterval(() => {
        void runtime.deliver(async () => {
        }).catch(error => runtime.errors.push(error));
    }, 100);
    const add = (e: Envelope, values?: number[]) => {
        if (values) {
            specifications.set(e.id, values);
            expected.push({
                inboxId: e.id, finalText: `SUM ${values.reduce((a, b) => a + b, 0)}`
            });
        }
        else
            expected.push({
                inboxId: e.id, silent: true
            });
    };
    try {
        const roots = bots.map((bot, i) => runtime.accept({
            to: bot.id, route: routes[i], text: 'Perform local sum tasks and watch build; no acknowledgement for this setup.', key: `root:${i}`
        }));
        roots.forEach(e => add(e));
        coordinators.forEach((bot, i) => {
            const source = runtime.accept({
                to: bot.id, route: routes[i], text: 'Send four observation-only teammate messages to the worker; no user reply.', key: `coordinator:${i}`
            });
            add(source);
            peerPlans.set(bot.id, {
                sourceId: source.id, targetId: bots[i].id, next: 0
            });
        });
        // Enqueue a finite flood before first model boundary, preserving individual envelopes.
        for (let i = 0; i < 16; i++) {
            const b = i % 2;
            add(runtime.accept({
                to: bots[b].id, route: routes[b], text: `Compute ${i}+2+3 using calculate_sum`, key: `task:${i}`
            }), [i, 2, 3]);
            add(runtime.accept({
                to: bots[b].id, route: {
                    ...routes[b], threadId: 'lounge'
                }, text: 'Incidental chatter; no task or reply.', key: `noise:${i}`
            }));
        }
        for (let i = 0; i < 4; i++)
            service.createSchedule(roots[i % 2], {
                key: `scheduled:${i}`, prompt: 'Compute scheduled sum', at: Date.now(), timezone: 'Asia/Shanghai', overlap: 'queue'
            });
        for (let i = 0; i < 4; i++) {
            const m = service.createMonitor(roots[i % 2], {
                key: `monitor:${i}`, detector: 'build', prompt: 'Compute sum when local build changes', intervalMs: 1000, deadline: Date.now() + 60000
            });
            await service.dryRunMonitor(m.botId, m.id);
            service.enableMonitor(m.botId, m.id);
        }
        await service.tick();
        for (const e of runtime.store.list<Envelope>('inbox').filter(e => e.kind === 'schedule'))
            add(e, [10, 20]);
        detectorChanged = true;
        // Move each monitor to its next check without a sleeping poll or repeated model calls.
        for (const m of runtime.store.list<any>('monitors'))
            runtime.store.put('monitors', {
                ...m, nextCheck: Date.now()
            });
        await service.tick();
        for (const e of runtime.store.list<Envelope>('inbox').filter(e => e.kind === 'monitor'))
            add(e, [20, 30]);
        await runtime.idle();
        await runtime.deliver(async () => {
        });
        trace.inbox = runtime.store.list<Envelope>('inbox');
        trace.jobs = runtime.store.list<Job>('jobs');
        trace.outbox = runtime.store.list<Outbound>('outbox');
        trace.inbox.filter(e => e.kind === 'bot').forEach(e => add(e));
        const fires = service.listFires(bots[0].id).concat(service.listFires(bots[1].id));
        const score = scoreResponseBenchmark(trace.inbox, trace.outbox, expected, trace.jobs, fires);
        const artifactFailures: string[] = [];
        for (const [id, values] of specifications) {
            try {
                if (JSON.parse(await readFile(join(directory, 'artifacts', `${id}.json`), 'utf8')).sum !== values.reduce((a, b) => a + b, 0))
                    artifactFailures.push(id);
            }
            catch {
                artifactFailures.push(id);
            }
        }
        const nativeToolErrors = trace.results.filter(r => r.isError).length;
        return {
            mode: 'scripted-native-pi' as const, paidRequests: 0, providerRequests: requests, refusedRequests, fixture: {
                groups: 2, bots: 4, directTasks: 16, chatter: 16, peerEvents: 8, scheduleFires: 4, monitorFires: 4
            }, score, artifactFailures, nativeToolErrors, runtimeErrors: runtime.errors.length, pending: trace.inbox.filter(e => ['queued', 'processing', 'uncertain'].includes(e.state)).length, trace: redactTraceValue(trace), expected, fires, notes: ['Actual native Pi inbox/tool/job/send_message paths and independently graded local file effects; provider decisions are scripted.', 'Host timing calibration only; no real API response-speed claim.']
        };
    }
    finally {
        clearTimeout(timeout);
        clearInterval(delivery);
        await service.close();
        await runtime.close();
    }
}
