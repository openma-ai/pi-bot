import {createEvaluationDirectory} from './evaluation-directory.ts';
import { Type } from 'typebox';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime, type ToolDefinition, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, type Model, type Api, type TranscriptContext, type FauxResponseFactory } from '@earendil-works/pi-ai';
import { BotRuntime } from '../daemon/runtime.ts';
import { piSessionFactory } from '../pi/session-factory.ts';
import { SimulatedChat } from './chat.ts';
import type { Envelope, Job, Outbound, Bot } from '../daemon/store.ts';
import { redactTraceValue, inboxIds, type EvaluationTrace } from './evaluation-trace.ts';
export const SMOKE_CAP = {
    requests: 32, inputTokenReservations: 384000, outputTokensPerRequest: 16384, estimatedUsd: 0.7443456, approvedUsdNeeded: 0.80, deadlineMs: 3600000, requestTimeoutMs: 600000
};
export class RequestBudget {
    requests = 0;
    inputReserved = 0;
    outputReserved = 0;
    refused = 0;
    readonly limits: typeof SMOKE_CAP;
    readonly accounting: 'context'|'wire';
    constructor(limits = SMOKE_CAP, accounting: 'context'|'wire' = 'context') {
        this.accounting = accounting;
        if (![limits.requests, limits.inputTokenReservations, limits.outputTokensPerRequest, limits.deadlineMs, limits.requestTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0))
            throw Error('Invalid evaluation budget');
        this.limits = Object.freeze({
            ...limits
        });
    }
    assertRequestAllowance(maxTokens: number) {
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > this.limits.outputTokensPerRequest || this.requests >= this.limits.requests) {
            this.refused++;throw Error('Evaluation request budget reached');
        }
    }
    /** Runs before fetch: account for the exact serialized provider body, not SDK diagnostics never sent on the wire. */
    reserveWire(body: {max_tokens?:number;max_completion_tokens?:number;[key:string]:unknown}) {
        const output=body.max_tokens??body.max_completion_tokens;
        if(!Number.isSafeInteger(output)) {this.refused++;throw Error('Evaluation request budget reached');}
        this.reserve(body,output!);
    }
    reserve(context: unknown, maxTokens: number) {
        // Conservative byte reservation plus 1024 tokens for framing overhead.
        // This is a reservation, not a provider tokenizer or bill measurement.
        const input = Buffer.byteLength(JSON.stringify(context), 'utf8') + 1024;
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || this.requests >= this.limits.requests || this.inputReserved + input > this.limits.inputTokenReservations || maxTokens > this.limits.outputTokensPerRequest) {
            this.refused++;
            throw Error('Evaluation request budget reached');
        }
        this.requests++;
        this.inputReserved += input;
        this.outputReserved += maxTokens;
    }
}
export interface Effect {
    channel: string;
    task: string;
    messageId: string;
    item: string;
    value: string;
    dispatchOrder: number;
}
export interface ScenarioResult {
    id: string;
    mode: 'scripted' | 'real';
    score: {
        validTaskCompletion: number;
        expectedTasks: number;
        missedCommitments: number;
        duplicateActions: number;
        wrongRecipients: number;
        obsoleteActions: number;
        appropriateSilence: boolean;
        malformedOutputs: number;
    };
    effects: Effect[];
    routes: {
        channel: string;
        task: string;
        thread: string;
        sender: string;
    }[];
    pendingEvents: number;
    runtimeErrors: number;
    transcriptPairsValid: boolean;
    trace?: EvaluationTrace;
}
interface Incoming {
    atMs: number;
    channel: string;
    sender: string;
    thread: string;
    task: string;
    key: string;
    text: string;
    control?: Envelope['taskControl'];
}
interface Expected {
    channel: string;
    task: string;
    item: string;
    value: string;
    thread: string;
    sender: string;
}
interface Scenario {
    id: string;
    events: Incoming[];
    expected: Expected[];
    cancelled: string[];
    noise: string[];
}
const taskText = (item: string, value: string, delegate = false) => `Task: record ${item}=${value} using commit_record via start_job (the host supplies args message_id from source_message_id; item and value must match). ${delegate ? 'Delegate to your same-channel worker with send_to_bot first; the worker performs the record and final reply. ' : ''}Wait for native job completion; then use send_message exactly DONE ${item}=${value}, with source_message_id for this task. No receipt/acknowledgement message; no extra actions.`;
export const scenarios: Scenario[] = [
    {
        id: 'overlap-isolation', events: [
            {
                atMs: 0, channel: 'alpha', sender: 'alice', thread: 'brief', task: 'a-brief', key: 'a1', text: taskText('brief', 'ALPHA')
            },
            {
                atMs: 5, channel: 'beta', sender: 'alice', thread: 'brief', task: 'b-brief', key: 'b1', text: taskText('brief', 'BETA')
            },
            {
                atMs: 10, channel: 'alpha', sender: 'bob', thread: 'count', task: 'a-count', key: 'a2', text: taskText('count', '2')
            },
            ...Array.from({
                length: 8
            }, (_, i) => ({
                atMs: 15 + i * 5, channel: i % 2 ? 'alpha' : 'beta', sender: i % 2 ? 'bob' : 'eve', thread: 'lounge', task: `noise-${i}`, key: `n-${i}`, text: 'Incidental group chatter: nice weather; no task and no reply needed.'
            }))
        ], expected: [
            {
                channel: 'alpha', task: 'a-brief', item: 'brief', value: 'ALPHA', thread: 'brief', sender: 'alice'
            },
            {
                channel: 'beta', task: 'b-brief', item: 'brief', value: 'BETA', thread: 'brief', sender: 'alice'
            },
            {
                channel: 'alpha', task: 'a-count', item: 'count', value: '2', thread: 'count', sender: 'bob'
            }
        ], cancelled: [], noise: Array.from({
            length: 8
        }, (_, i) => `noise-${i}`)
    },
    {
        id: 'replace-cancel', events: [
            {
                atMs: 0, channel: 'alpha', sender: 'alice', thread: 'draft', task: 'draft', key: 'red', text: 'Prepare only a RED draft; do not commit yet. Wait for my explicit choice. No acknowledgement needed.'
            },
            {
                atMs: 10, channel: 'beta', sender: 'alice', thread: 'drop', task: 'drop', key: 'drop', text: 'Prepare only a doomed draft; do not commit yet. Wait for approval. No acknowledgement needed.'
            },
            {
                atMs: 20, channel: 'alpha', sender: 'alice', thread: 'draft', task: 'draft', key: 'blue', control: 'replace', text: `Correction: RED is obsolete. ${taskText('draft', 'BLUE')}`
            },
            {
                atMs: 25, channel: 'beta', sender: 'alice', thread: 'drop', task: 'drop', key: 'cancel', control: 'cancel', text: 'Cancel this task. No commit, delegation, question or reply needed.'
            },
            ...Array.from({
                length: 6
            }, (_, i) => ({
                atMs: 30 + i * 5, channel: 'alpha', sender: 'bob', thread: 'lounge', task: `cancel-noise-${i}`, key: `cn-${i}`, text: 'Unrelated chat; no request, remain silent.'
            }))
        ], expected: [{
                channel: 'alpha', task: 'draft', item: 'draft', value: 'BLUE', thread: 'draft', sender: 'alice'
            }], cancelled: ['drop'], noise: Array.from({
            length: 6
        }, (_, i) => `cancel-noise-${i}`)
    },
    {
        id: 'handoff', events: [
            {
                atMs: 0, channel: 'alpha', sender: 'alice', thread: 'handoff', task: 'delegated', key: 'handoff', text: taskText('handoff', 'FINISHED', true)
            },
            {
                atMs: 5, channel: 'beta', sender: 'eve', thread: 'lounge', task: 'handoff-noise', key: 'hn', text: 'Ambient chatter: the other group is busy. No task, do not reply.'
            }
        ], expected: [{
                channel: 'alpha', task: 'delegated', item: 'handoff', value: 'FINISHED', thread: 'handoff', sender: 'alice'
            }], cancelled: [], noise: ['handoff-noise']
    }
];
function incomingContext(context: TranscriptContext): any[] {
    const events: any[] = [];
    for (const message of context.messages) {
        if (message.role !== 'user')
            continue;
        const text = typeof message.content === 'string' ? message.content : message.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
        try {
            const item = JSON.parse(text);
            if (item.type === 'inbox')
                events.push(item);
        }
        catch {
        }
    }
    return events;
}
export function gradeScenario(scenario: Scenario, effects: Effect[], output: Outbound[]): ScenarioResult['score'] {
    const valid = scenario.expected.filter(expected => {
        const matches = effects.filter(effect => effect.channel === expected.channel && effect.task === expected.task && effect.item === expected.item && effect.value === expected.value);
        const replies = output.filter(out => out.taskId === expected.task && out.route?.channelId === expected.channel && out.route.threadId === expected.thread && out.route.senderId === expected.sender && out.text === `DONE ${expected.item}=${expected.value}`);
        return matches.length === 1 && replies.length === 1;
    }).length;
    const keys = new Map<string, number>();
    for (const effect of effects) {
        const key = JSON.stringify([effect.channel, effect.task, effect.item]);
        keys.set(key, (keys.get(key) ?? 0) + 1);
    }
    const outputKeys = new Map<string, number>();
    for (const out of output) {
        const key = JSON.stringify([out.route?.channelId, out.taskId]);
        outputKeys.set(key, (outputKeys.get(key) ?? 0) + 1);
    }
    const wrong = output.filter(out => !scenario.expected.some(e => e.task === out.taskId && e.channel === out.route?.channelId && e.thread === out.route?.threadId && e.sender === out.route?.senderId) && !scenario.noise.includes(out.taskId) && !scenario.cancelled.includes(out.taskId)).length;
    const obsolete = effects.filter(effect => !scenario.expected.some(e => e.channel === effect.channel && e.task === effect.task && e.item === effect.item && e.value === effect.value)).length + output.filter(o => scenario.cancelled.includes(o.taskId) || /RED|doomed/.test(o.text)).length;
    return {
        validTaskCompletion: valid, expectedTasks: scenario.expected.length, missedCommitments: scenario.expected.length - valid,
        duplicateActions: [...keys.values(), ...outputKeys.values()].reduce((n, c) => n + Math.max(0, c - 1), 0), wrongRecipients: wrong, obsoleteActions: obsolete,
        appropriateSilence: output.every(o => !scenario.noise.includes(o.taskId) && !scenario.cancelled.includes(o.taskId)),
        malformedOutputs: output.filter(o => !scenario.expected.some(e => o.taskId === e.task && o.text === `DONE ${e.item}=${e.value}`)).length
    };
}
export async function runEvaluation(options: {
    mode?: 'scripted' | 'real';
    modelRuntime?: ModelRuntime;
    model?: Model<Api>;
    budget?: RequestBudget;
    deadlineMs?: number;
    scenarioIds?: string[];
    trace?: boolean;
} = {}) {
    const mode = options.mode ?? 'scripted';
    const selected = options.scenarioIds ? scenarios.filter(s => options.scenarioIds!.includes(s.id)) : scenarios;
    if (!selected.length || options.scenarioIds?.some(id => !scenarios.some(s => s.id === id))) throw Error('Unknown evaluation scenario');
    if (mode === 'real' && (!options.modelRuntime || !options.model))
        throw Error('Real provider configuration required');
    const root = await createEvaluationDirectory('pi-bot-evaluation-');
    const budget = options.budget ?? new RequestBudget();
    const results: ScenarioResult[] = [];
    let requestTimeouts = 0;
    const lifetime = new AbortController();
    const deadline = setTimeout(() => lifetime.abort(), options.deadlineMs ?? SMOKE_CAP.deadlineMs);
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    try {
        for (const scenario of selected) {
            const trace: EvaluationTrace = { inbox: [], jobs: [], outbox: [], calls: [], results: [], boundaries: [] };
            let traceOrder = 0;
            const effects: Effect[] = [];
            let runtime!: BotRuntime;
            let chat!: SimulatedChat;
            let dispatchOrder = 0;
            const faux = mode === 'scripted' ? fauxProvider({
                provider: `evaluation-${scenario.id}`, models: [{
                        id: 'scripted', contextWindow: 1000000, maxTokens: SMOKE_CAP.outputTokensPerRequest
                    }], tokensPerSecond: 1000000
            }) : undefined;
            const policy: FauxResponseFactory = async (context) => {
                // Deliberately scripted policy for validating runner + oracle wiring.
                // Real mode uses the selected provider and never this policy.
                await new Promise(resolve => setTimeout(resolve, 12));
                const envelopes = incomingContext(context);
                const latest = new Map<string, any>();
                for (const e of envelopes)
                    if (e.kind !== 'job')
                        latest.set(e.taskId, e);
                const content = [];
                for (const e of latest.values()) {
                    if (e.taskControl === 'cancel' || /no task|no request|Ambient chatter|Incidental group|Unrelated chat|Prepare only/i.test(e.text))
                        continue;
                    const match = e.text.match(/record ([a-z]+)=([A-Z0-9]+)/);
                    if (!match)
                        continue;
                    const existing = runtime.store.list<Job>('jobs').filter(j => j.botId === e.to && j.taskId === e.taskId);
                    const isDelegation = /Delegate to your same-channel worker/.test(e.text) && e.kind !== 'bot';
                    if (isDelegation) {
                        const already = runtime.store.list<Envelope>('inbox').some(item => item.kind === 'bot' && item.replyTo === e.messageId);
                        if (!already)
                            content.push(fauxToolCall('send_to_bot', {
                                bot_id: chat.channels.get(e.route.channelId)!.worker.id, text: e.text, key: `delegate:${e.taskId}`, source_message_id: e.messageId
                            }, {
                                id: `delegate:${e.messageId}`
                            }));
                    }
                    else if (!existing.length) {
                        content.push(fauxToolCall('start_job', {
                            tool: 'commit_record', args: {
                                message_id: e.messageId, item: match[1], value: match[2]
                            }, key: `commit:${e.taskId}`, source_message_id: e.messageId
                        }, {
                            id: `commit:${e.messageId}`
                        }));
                    }
                    else if (existing.some(j => j.state === 'completed') && !runtime.store.list<Outbound>('outbox').some(o => o.taskId === e.taskId)) {
                        content.push(fauxToolCall('send_message', {
                            text: `DONE ${match[1]}=${match[2]}`, key: `done:${e.taskId}`, source_message_id: e.messageId
                        }, {
                            id: `done:${e.messageId}`
                        }));
                    }
                }
                return content.length ? fauxAssistantMessage(content, {
                    stopReason: 'toolUse'
                }) : fauxAssistantMessage('internal');
            };
            faux?.setResponses(Array.from({
                length: 80
            }, () => policy));
            const toolsFor = (bot: Bot): ToolDefinition[] => [{
                    name: 'commit_record', label: 'Commit record', description: 'Write one isolated synthetic channel record; only args message_id for a current own inbox task is admitted. Result is completion, not an external delivery.', parameters: Type.Object({
                        message_id: Type.String(), item: Type.String({
                            pattern: '^[a-z]+$'
                        }), value: Type.String({
                            pattern: '^[A-Z0-9]+$'
                        })
                    }),
                    async execute(_id, raw) {
                        const p = raw as {
                            message_id: string;
                            item: string;
                            value: string;
                        };
                        const source = runtime.store.get<Envelope>('inbox', p.message_id);
                        if (!source || source.to !== bot.id || source.route?.channelId !== bot.channelId)
                            throw Error('Record source route rejected');
                        runtime.assertTaskCurrent(source);
                        const order = ++dispatchOrder;
                        // Started tools deliberately survive input preemption.
                        await new Promise(resolve => setTimeout(resolve, 20));
                        effects.push({
                            channel: bot.channelId!, task: source.taskId, messageId: source.id, item: p.item, value: p.value, dispatchOrder: order
                        });
                        return {
                            content: [{
                                    type: 'text', text: 'record completed'
                                }], details: {
                                completed: true, item: p.item, value: p.value
                            }
                        };
                    }
                }];
            runtime = new BotRuntime(join(root, `${scenario.id}.db`), async (bot, host) => piSessionFactory({
                dir: join(root, scenario.id), modelRuntime, model: faux?.getModel() ?? options.model!, tools: toolsFor(bot), allowTools: ['commit_record'], jobSourceArguments: { commit_record: 'message_id' }, modelNativeTools: ['send_message','send_to_bot','list_bots','start_job','job_result'], extensions: [...(faux ? [(pi: Parameters<ExtensionFactory>[0]) => pi.registerProvider(faux.provider)] : []), ...(options.trace ? [((pi: any) => {
                    pi.on('tool_call', (event: any) => { trace.calls.push(redactTraceValue({ order: ++traceOrder, botId: bot.id, id: event.toolCallId, parentId: event.parentToolCallId, name: event.toolName, args: event.input })); });
                    pi.on('tool_result', (event: any) => { trace.results.push(redactTraceValue({ order: ++traceOrder, botId: bot.id, id: event.toolCallId, parentId: event.parentToolCallId, name: event.toolName, isError: event.isError, content: event.content, details: event.details })); });
                })] : [])], maxRequestsPerWake: 16, maxOutputTokens: SMOKE_CAP.outputTokensPerRequest, thinkingLevel: mode === 'real' ? 'high' : undefined, inferenceRequestTimeoutMs: SMOKE_CAP.requestTimeoutMs, onInferenceTimeout: () => {
                    requestTimeouts++;
                }, inferenceSignal: lifetime.signal, beforeProviderRequest: (ctx, max) => { if(budget.accounting==='wire')budget.assertRequestAllowance(max);else budget.reserve(ctx, max); if (options.trace) trace.boundaries.push({ order: ++traceOrder, botId: bot.id, inboxIds: inboxIds(ctx) }); }, context: {
                    backgroundEnabled: false, maxContextTokens: 256000, outputReserveTokens: SMOKE_CAP.outputTokensPerRequest
                }
            })(bot, host));
            chat = new SimulatedChat(runtime);
            chat.channel('alpha', ['alice', 'bob']);
            chat.channel('beta', ['alice', 'eve']);
            try {
                const start = Date.now();
                for (const event of scenario.events) {
                    const wait = Math.max(0, start + event.atMs - Date.now());
                    if (wait)
                        await new Promise(resolve => setTimeout(resolve, wait));
                    if (lifetime.signal.aborted)
                        break;
                    chat.send({
                        channelId: event.channel, senderId: event.sender, threadId: event.thread, taskId: event.task, key: event.key, text: event.text, taskControl: event.control
                    });
                }
                await runtime.idle();
                await chat.deliver();
                const inbox = runtime.store.list<Envelope>('inbox');
                // Pair validity from native JSONL is checked without exposing text.
                const { SessionManager } = await import('@earendil-works/pi-coding-agent');
                const { hasValidToolPairs } = await import('../pi/context.ts');
                const pairValidity = runtime.listBots().filter(b => b.sessionFile).every(b => hasValidToolPairs(SessionManager.open(b.sessionFile!, join(root, scenario.id)).buildSessionProjection().messages));
                results.push({
                    id: scenario.id, mode, ...(options.trace ? { trace: redactTraceValue({ ...trace, inbox: runtime.store.list<Envelope>('inbox'), jobs: runtime.store.list<Job>('jobs'), outbox: runtime.store.list<Outbound>('outbox') }) } : {}), score: gradeScenario(scenario, effects, chat.deliveries), effects, routes: chat.deliveries.map(o => ({
                        channel: o.route!.channelId, thread: o.route!.threadId, sender: o.route!.senderId, task: o.taskId
                    })), pendingEvents: inbox.filter(e => e.state !== 'processed').length, runtimeErrors: runtime.errors.length, transcriptPairsValid: pairValidity
                });
            }
            finally {
                await runtime.close();
            }
        }
        return {
            mode, scenarios: results, timeouts: {
                roundReached: lifetime.signal.aborted, providerRequests: requestTimeouts
            }, budget: {
                requests: budget.requests, inputReserved: budget.inputReserved, outputReserved: budget.outputReserved, refused: budget.refused
            }, pass: !lifetime.signal.aborted && requestTimeouts === 0 && results.every(r => r.score.missedCommitments === 0 && r.score.duplicateActions === 0 && r.score.wrongRecipients === 0 && r.score.obsoleteActions === 0 && r.score.appropriateSilence && r.score.malformedOutputs === 0 && r.runtimeErrors === 0 && r.pendingEvents === 0 && r.transcriptPairsValid), note: mode === 'scripted' ? 'Scripted local runner validation; no model competence claim.' : 'Real provider behavioral smoke; small custom fixtures, not Gaia2.'
        };
    }
    finally {
        clearTimeout(deadline);
        lifetime.abort();
        await rm(root, {
            recursive: true, force: true
        });
    }
}
