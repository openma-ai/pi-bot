import { createEvaluationDirectory } from './evaluation-directory.ts';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { ModelRuntime, SessionManager, type ToolDefinition, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, type Model, type Api, type TranscriptContext } from '@earendil-works/pi-ai';
import { gradeTaskChain, gradeProgressCsv, TASKCHAIN_SPEC, PROGRESS_SPEC, type WorkEvaluationReport, type CodeGrade } from './taskchain-evaluation.ts';
import { BotRuntime } from '../daemon/runtime.ts';
import { piSessionFactory, createModelSummarizer } from '../pi/session-factory.ts';
import { SimulatedChat } from './chat.ts';
import { RequestBudget, SMOKE_CAP } from './evaluation.ts';
import { hasValidToolPairs } from '../pi/context.ts';
import { redactTraceValue, inboxIds, observeEvaluationTools, type EvaluationTrace } from './evaluation-trace.ts';
import type { Bot, Envelope, Job, Outbound } from '../daemon/store.ts';
const chainText = TASKCHAIN_SPEC.split('Submit code using')[0] + `Perform this task yourself. Call codemode once with source_message_id for this task and a script awaiting tools.submit_taskchain({code:<your Python source>}); print its result with text(). The host supplies message_id. Do not wrap in start_job. The real Python test process may pause until independent task B is finished. A running cell receipt is not completion; never rerun the script to obtain output. End your turn while waiting. When completion arrives, collect the saved full final result with codemode_read; if done=false, follow next_offset. Only after all 12 tests pass and the full result is read, use send_message exactly READY TaskChain/solution.py, replying to this task. No acknowledgements, polling or delegation.`;
const reportText = PROGRESS_SPEC.split('Use start_job tool')[0] + `This is independent task B while TaskChain's Python process is running. Actually observe grade_started and its PID from the existing TaskChain receipt. If the receipt does not already contain it, call codemode_wait (yield_time_ms=1, after_seq set to the previous next_seq); never re-read the entire event history unnecessarily. Then call codemode once with this task's source_message_id, await tools.submit_progress_csv({csv:<your computed CSV>}) and print its result. After validation passes, use send_message exactly READY Reports/progress.csv for this task. Do not wait for TaskChain to finish: the host releases that process after B is validated and replied. Never restart TaskChain. No acknowledgements, polling or delegation.`;
const requiredChecks = ['empty', 'dependency-start', 'dependency-order', 'complete-before-start', 'duplicate-id', 'unknown-dependency', 'unknown-task', 'duplicate-complete', 'multiple-dependencies', 'collaboration-comments', 'notification-contract', 'reports-and-diagram'];
/** Collection evidence is independent of the file oracle: READY text never satisfies it. */
export function hasFullValidationObservation(result: {
    name: string;
    details?: unknown;
    content: unknown;
}): boolean {
    const details = result.details as any;
    if (result.name === 'codemode_read' ? !details?.done : !['codemode', 'codemode_wait'].includes(result.name) || details?.state !== 'completed')
        return false;
    const valid = (value: any): boolean => {
        if (typeof value === 'string') {
            try {
                return valid(JSON.parse(value));
            }
            catch {
                return false;
            }
        }
        if (!value || typeof value !== 'object')
            return false;
        if (value.pass === true && Array.isArray(value.passed) && requiredChecks.every(name => value.passed.includes(name)) && Array.isArray(value.failed) && value.failed.length === 0)
            return true;
        return Object.values(value).some(item => item !== null && valid(item));
    };
    return (result.content as {
        type: string;
        text?: string;
    }[]).some(block => {
        if (block.type !== 'text' || !block.text)
            return false;
        try {
            return valid(JSON.parse(block.text.startsWith('Cell observations:\n') ? block.text.slice('Cell observations:\n'.length) : block.text));
        }
        catch {
            return false;
        }
    });
}
function incoming(context: TranscriptContext): any[] {
    return context.messages.filter(m => m.role === 'user').flatMap(m => {
        try {
            const text = typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
            const e = JSON.parse(text);
            return e.type === 'inbox' ? [e] : [];
        }
        catch {
            return [];
        }
    });
}
async function collectCells(dir: string): Promise<{
    path: string;
    record: unknown;
}[]> {
    const rows: {
        path: string;
        record: unknown;
    }[] = [];
    async function walk(path: string) {
        for (const item of await readdir(path, {
            withFileTypes: true
        }).catch(() => [])) {
            const file = join(path, item.name);
            if (item.isDirectory())
                await walk(file);
            else if (item.name.endsWith('.json') || item.name.endsWith('.jsonl')) {
                const data = await readFile(file, 'utf8');
                rows.push({
                    path: file.slice(dir.length + 1), record: redactTraceValue(item.name.endsWith('.jsonl') ? data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(data))
                });
            }
        }
    }
    await walk(dir);
    return rows;
}
export async function runObservedTaskChainEvaluation(options: {
    mode?: 'real' | 'scripted';
    modelRuntime?: ModelRuntime;
    model?: Model<Api>;
    outputDir?: string;
    budget?: RequestBudget;
    backgroundSummary?: boolean;
    cancelDuringExecution?: boolean;
}): Promise<WorkEvaluationReport> {
    const mode = options.mode ?? 'real';
    if (mode === 'real' && (!options.modelRuntime || !options.model))
        throw Error('Real provider required');
    const root = await createEvaluationDirectory('pi-observed-work-');
    const releasePath = join(root, 'grade-release');
    const executionDir = join(root, 'executions');
    const budget = options.budget ?? new RequestBudget();
    const lifetime = new AbortController();
    const deadline = setTimeout(() => lifetime.abort(), SMOKE_CAP.deadlineMs);
    const trace: EvaluationTrace = {
        inbox: [], jobs: [], outbox: [], calls: [], results: [], boundaries: []
    };
    let order = 0, timeouts = 0, released = false, runtimeClosed = false;
    const processEvents: {
        event: string;
        pid: number;
        at: number;
    }[] = [];
    const artifacts = new Map<string, {
        code: string;
        grade: CodeGrade | {
            pass: boolean;
        };
        file: string;
        originId: string;
    }>();
    const submissions: {
        task: string;
        originId: string;
        sha256: string;
        pass: boolean;
    }[] = [];
    const validated = new Map<string, CodeGrade>();
    const summaries: {
        kind: string;
        botId: string;
        at: number;
        prefixInboxIds?: string[];
        characters?: number;
    }[] = [];
    let summaryInFlight = 0, foregroundOverlap = 0, lateId: string | undefined, summaryTailInjected = false;
    const compactions: unknown[] = [];
    const releaseTag = 'audit-20261013-v3';
    let runtime!: BotRuntime, chat!: SimulatedChat, flood: Promise<void> | undefined, cancelId: string | undefined;
    const models = options.modelRuntime ?? await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const faux = mode === 'scripted' ? fauxProvider({
        provider: 'observed-work-fixture', models: [{
                id: 'scripted', contextWindow: 1000000, maxTokens: 16384
            }], tokensPerSecond: 1000000
    }) : undefined;
    const observedProgress = () => trace.results.some(r => ['codemode', 'codemode_wait'].includes(r.name) && (r.content as {
        type: string;
        text?: string;
    }[]).some(block => {
        if (block.type !== 'text' || !block.text?.startsWith('Cell observations:\n'))
            return false;
        try {
            return JSON.parse(block.text.slice('Cell observations:\n'.length)).some((event: any) => event.type === 'tool_update' && event.name === 'validate_taskchain' && event.update?.details?.event === 'grade_started' && processEvents.some(p => p.event === 'grade_started' && p.pid === event.update.details.pid));
        }
        catch {
            return false;
        }
    }));
    const fullRead = () => trace.results.some(hasFullValidationObservation);
    const monitor = setInterval(() => {
        if (!released && ((observedProgress() && (!options.backgroundSummary || lateId) && runtime?.store.list<Outbound>('outbox').some(o => o.taskId === 'progress-report' && o.text === 'READY Reports/progress.csv')) || budget.refused > 0 || lifetime.signal.aborted)) {
            released = true;
            void writeFile(releasePath, 'released', {
                mode: 0o600
            });
        }
    }, 20);
    try {
        if (faux) {
            const reference = await readFile(new URL('../../fixtures/marble-taskchain/reference.py', import.meta.url), 'utf8');
            faux.setResponses(Array.from({
                length: 80
            }, () => async (context: TranscriptContext) => {
                await new Promise(r => setTimeout(r, 40));
                if (context.messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('stablePrefix')))
                    return fauxAssistantMessage('Stable TaskChain uses unblocked; preserve active task ownership and any recent release-tag correction. Pending validation is not completion. Stable source IDs: ' + inboxIds({
                        messages: context.messages
                    }).join(','));
                const latest = new Map<string, any>();
                const visibleBot = runtime.listBots().find(b => JSON.stringify(context.messages.filter(m => m.role === 'system')).includes(b.id));
                // Offline policy is a deterministic host-ledger oracle, not a model competency claim.
                const input = visibleBot ? runtime.store.list<Envelope>('inbox').filter(e => e.to === visibleBot.id).map(e => ({
                    ...e, messageId: e.id
                })) : incoming(context);
                for (const e of input)
                    if (e.kind !== 'job')
                        latest.set(e.taskId, e);
                const content = [];
                if (processEvents.length && !observedProgress()) {
                    const receipt = trace.results.find(r => r.name === 'codemode' && (r.details as any)?.cell_id && (r.details as any)?.state === 'running');
                    if (receipt)
                        content.push(fauxToolCall('codemode_wait', {
                            cell_id: (receipt.details as any).cell_id, yield_time_ms: 1
                        }));
                }
                if (options.cancelDuringExecution && processEvents.some(e => e.event === 'grade_finished') && !fullRead()) {
                    const job = runtime.store.list<Job>('jobs').find(j => j.taskId === 'taskchain');
                    const receipt = trace.results.find(r => r.id === job?.key.replace('execution:', '') && (r.details as any)?.cell_id);
                    const previous = trace.results.filter(r => r.name === 'codemode_read').at(-1);
                    if (receipt)
                        content.push(fauxToolCall('codemode_read', {
                            cell_id: (receipt.details as any).cell_id, offset: (previous?.details as any)?.next_offset ?? 0, limit: 12000
                        }));
                }
                for (const e of latest.values()) {
                    if (!['taskchain', 'progress-report'].includes(e.taskId) || e.taskControl === 'cancel')
                        continue;
                    const source = runtime.store.get<Envelope>('inbox', e.messageId);
                    if (!source)
                        continue;
                    try {
                        runtime.assertTaskCurrent(source);
                    }
                    catch {
                        continue;
                    }
                    const artifact = artifacts.get(e.taskId);
                    if (!artifact?.grade.pass) {
                        if (!runtime.store.list<Job>('jobs').some(j => j.botId === e.to && j.taskId === e.taskId && j.messageId === e.messageId)) {
                            const args = e.taskId === 'taskchain' ? {
                                code: (e.text.includes('RELEASE_TAG') ? `RELEASE_TAG='${releaseTag}'\n` : '') + reference
                            } : {
                                csv: 'owner,total,completed,completion_rate\nalice,2,1,0.5\nbob,3,2,0.666667\n'
                            };
                            content.push(fauxToolCall('codemode', {
                                source_message_id: e.messageId, code: `text(await tools.${e.taskId === 'taskchain' ? 'submit_taskchain' : 'submit_progress_csv'}(${JSON.stringify(args)}));`
                            }));
                        }
                    }
                    else if (e.taskId === 'taskchain' && !fullRead()) {
                        const job = runtime.store.list<Job>('jobs').find(j => j.taskId === 'taskchain');
                        const call = trace.calls.find(c => c.id === job?.key.replace('execution:', ''));
                        const receipt = trace.results.find(r => r.id === call?.id && (r.details as any)?.cell_id);
                        const previous = trace.results.filter(r => r.name === 'codemode_read').at(-1);
                        if (receipt)
                            content.push(fauxToolCall('codemode_read', {
                                cell_id: (receipt.details as any).cell_id, offset: (previous?.details as any)?.next_offset ?? 0, limit: 12000
                            }));
                    }
                    else if (!runtime.store.list<Outbound>('outbox').some(o => o.taskId === e.taskId))
                        content.push(fauxToolCall('send_message', {
                            text: e.taskId === 'taskchain' ? 'READY TaskChain/solution.py' : 'READY Reports/progress.csv', key: 'ready:' + e.taskId, source_message_id: e.messageId
                        }));
                }
                return content.length ? fauxAssistantMessage(content, {
                    stopReason: 'toolUse'
                }) : fauxAssistantMessage('internal');
            }));
        }
        const origin = (e: Envelope) => {
            let current = e;
            const seen = new Set<string>();
            while (['bot', 'job'].includes(current.kind) && current.replyTo && !seen.has(current.id)) {
                seen.add(current.id);
                const parent = runtime.store.get<Envelope>('inbox', current.replyTo);
                if (!parent)
                    break;
                current = parent;
            }
            return current.id;
        };
        const owned = (bot: Bot, id: string, task: string) => {
            const e = runtime.store.get<Envelope>('inbox', id);
            if (!e || e.to !== bot.id || e.taskId !== task || e.route?.channelId !== 'alpha')
                throw Error('Artifact source/task rejected');
            runtime.assertTaskCurrent(e);
            return e;
        };
        const toolsFor = (bot: Bot): ToolDefinition[] => [
            {
                name: 'validate_taskchain', label: 'Validate TaskChain', description: 'Internal executable 12-check validation invoked by submit_taskchain. Emits actual Python process progress. Does not save a deliverable.', parameters: Type.Object({
                    message_id: Type.String(), code: Type.String({
                        maxLength: 32000
                    })
                }), async execute(_id, raw, _signal, update) {
                    const p = raw as {
                        message_id: string;
                        code: string;
                    };
                    owned(bot, p.message_id, 'taskchain');
                    const source = runtime.store.get<Envelope>('inbox', p.message_id)!;
                    const grade = await gradeTaskChain(p.code, {
                        expectedRelease: source.text.includes('RELEASE_TAG') ? releaseTag : undefined, pauseUntil: processEvents.length ? undefined : releasePath, onProgress: event => {
                            processEvents.push({
                                ...event, at: Date.now()
                            });
                            update?.({
                                content: [{
                                        type: 'text', text: JSON.stringify(event)
                                    }], details: event
                            });
                            if (event.event === 'grade_started' && !flood)
                                flood = (async () => {
                                    if (options.cancelDuringExecution)
                                        cancelId = chat.send({
                                            channelId: 'alpha', senderId: 'alice', threadId: 'build', taskId: 'taskchain', key: 'cancel-running-taskchain', taskControl: 'cancel', text: 'Cancel TaskChain publication. Keep the already-started validation running; inspect its final observations, but do not start another TaskChain action or send a TaskChain reply. Independent CSV task B remains valid.'
                                        }).id;
                                    for (let i = 0; i < 8; i++)
                                        chat.send({
                                            channelId: i % 2 ? 'alpha' : 'beta', senderId: i % 2 ? 'bob' : 'eve', threadId: 'lounge', taskId: 'live-noise-' + i, key: 'live-noise-' + i, text: 'Incidental group chatter while tests run; no task or reply. Keep valid commitments.'
                                        });
                                    chat.send({
                                        channelId: 'alpha', senderId: 'bob', threadId: 'report', taskId: 'progress-report', key: 'report', text: reportText
                                    });
                                })();
                        }
                    });
                    validated.set(JSON.stringify([p.message_id, createHash('sha256').update(p.code).digest('hex')]), grade);
                    return {
                        content: [{
                                type: 'text', text: JSON.stringify(grade)
                            }], details: grade
                    };
                }
            },
            {
                name: 'save_artifact', label: 'Save validated artifact', description: 'Internal commit after independent validation. Never bypass submission tools.', parameters: Type.Object({
                    message_id: Type.String(), task: Type.Union([Type.Literal('taskchain'), Type.Literal('progress-report')]), code: Type.String({
                        maxLength: 32000
                    })
                }), async execute(_id, raw) {
                    const p = raw as {
                        message_id: string;
                        task: string;
                        code: string;
                    };
                    const e = owned(bot, p.message_id, p.task);
                    const grade = p.task === 'taskchain' ? validated.get(JSON.stringify([p.message_id, createHash('sha256').update(p.code).digest('hex')])) : {
                        pass: gradeProgressCsv(p.code)
                    };
                    if (!grade)
                        throw Error('Independent validation required before artifact commit');
                    const file = p.task === 'taskchain' ? 'TaskChain/solution.py' : 'Reports/progress.csv';
                    artifacts.set(p.task, {
                        code: p.code, grade, file, originId: origin(e)
                    });
                    return {
                        content: [{
                                type: 'text', text: JSON.stringify({
                                    file, pass: grade.pass
                                })
                            }], details: {
                            file, pass: grade.pass
                        }
                    };
                }
            },
            ...['submit_taskchain', 'submit_progress_csv'].map((name): ToolDefinition => ({
                name, label: name, description: name === 'submit_taskchain' ? 'Save generated TaskChain code after a nested real Python validation. Prints grader progress; never rerun a running script.' : 'Validate and save a computed CSV. Final completion is not user delivery.', parameters: name === 'submit_taskchain' ? Type.Object({
                    message_id: Type.String(), code: Type.String({
                        maxLength: 32000
                    })
                }) : Type.Object({
                    message_id: Type.String(), csv: Type.String({
                        maxLength: 4000
                    })
                }), async execute(_id, raw, _signal, _update, ctx) {
                    const p = raw as {
                        message_id: string;
                        code?: string;
                        csv?: string;
                    };
                    const task = name === 'submit_taskchain' ? 'taskchain' : 'progress-report';
                    const e = owned(bot, p.message_id, task);
                    if (submissions.filter(s => s.task === task).length >= 3)
                        throw Error('Bounded artifact attempts reached');
                    const code = p.code ?? p.csv!;
                    let grade: CodeGrade | {
                        pass: boolean;
                    };
                    if (name === 'submit_taskchain') {
                        const outcome = await ctx.executeTool('validate_taskchain', {
                            message_id: p.message_id, code
                        });
                        if (outcome.isError)
                            throw Error('Native validator denied or failed');
                        grade = outcome.result.details as CodeGrade;
                    }
                    else
                        grade = {
                            pass: gradeProgressCsv(code)
                        };
                    const file = name === 'submit_taskchain' ? 'TaskChain/solution.py' : 'Reports/progress.csv';
                    const rootId = origin(e);
                    submissions.push({
                        task, originId: rootId, sha256: createHash('sha256').update(code).digest('hex'), pass: grade.pass
                    });
                    const saved = await ctx.executeTool('save_artifact', {
                        message_id: p.message_id, task, code
                    });
                    const current = !saved.isError;
                    return {
                        content: [{
                                type: 'text', text: JSON.stringify({
                                    artifact: file, grade, superseded: !current
                                })
                            }], details: {
                            artifact: file, grade, superseded: !current
                        }
                    };
                }
            }))
        ];
        runtime = new BotRuntime(join(root, 'runtime.db'), async (bot, host) => piSessionFactory({
            dir: join(root, 'sessions'), modelRuntime: models, model: faux?.getModel() ?? options.model!, tools: toolsFor(bot), allowTools: ['submit_taskchain', 'submit_progress_csv', 'validate_taskchain', 'save_artifact'], jobSourceArguments: {
                submit_taskchain: 'message_id', submit_progress_csv: 'message_id', validate_taskchain: 'message_id', save_artifact: 'message_id'
            }, modelNativeTools: ['codemode', 'codemode_wait', 'codemode_read', 'send_message'], backgroundTools: {
                directory: join(executionDir, bot.id), additionalTools: [], yieldTimeMs: 1000, maxRuntimeMs: 600000, maxCellsPerSession: 16, maxConcurrentCells: 4
            }, extensions: [...(faux ? [(pi: Parameters<ExtensionFactory>[0]) => pi.registerProvider(faux.provider)] : []), observeEvaluationTools(trace, bot.id, () => ++order)], maxRequestsPerWake: 16, maxOutputTokens: 16384, thinkingLevel: mode === 'real' ? 'high' : undefined, inferenceRequestTimeoutMs: 600000, inferenceSignal: lifetime.signal, onInferenceTimeout: () => timeouts++, beforeProviderRequest: (context, max) => {
                if (budget.accounting === 'wire')
                    budget.assertRequestAllowance(max);
                else
                    budget.reserve(context, max);
                if (summaryInFlight)
                    foregroundOverlap++;
                trace.boundaries.push({
                    order: ++order, botId: bot.id, inboxIds: inboxIds(context)
                });
            }, context: {
                backgroundEnabled: !!options.backgroundSummary && bot.channelId === 'alpha', maxContextTokens: 256000, outputReserveTokens: 16384, thresholdTokens: 12000, recentMessages: 2, canSummarize: () => summaries.every(e => e.kind !== 'started') && processEvents.some(e => e.event === 'grade_started') && !processEvents.some(e => e.event === 'grade_finished'), summaryTimeoutMs: 600000, summaryMaxAttempts: 1, summarize: async (snapshot) => {
                    const prefixInboxIds = inboxIds({
                        messages: snapshot.messages
                    });
                    summaryInFlight++;
                    summaries.push({
                        kind: 'started', botId: bot.id, at: Date.now(), prefixInboxIds
                    });
                    if (!lateId && processEvents.some(p => p.event === 'grade_started') && !processEvents.some(p => p.event === 'grade_finished'))
                        lateId = chat.send({
                            channelId: 'alpha', senderId: 'alice', threadId: 'build', taskId: 'taskchain', key: 'taskchain-v3', taskControl: 'replace', text: `Late correction: keep the complete API and add module constant RELEASE_TAG='${releaseTag}'. Previous version must not be published. ` + chainText
                        }).id;
                    try {
                        const summarize = createModelSummarizer(models, faux?.getModel() ?? options.model!, {
                            maxTokens: 8192, beforeRequest: (ctx, max) => {
                                if (budget.accounting === 'wire')
                                    budget.assertRequestAllowance(max);
                                else
                                    budget.reserve(ctx, max);
                            }
                        });
                        const text = await summarize({
                            ...snapshot, signal: AbortSignal.any([snapshot.signal, lifetime.signal])
                        });
                        summaries.push({
                            kind: 'completed', botId: bot.id, at: Date.now(), characters: text.length
                        });
                        if (!summaryTailInjected) {
                            summaryTailInjected = true;
                            setTimeout(() => {
                                chat.send({
                                    channelId: 'alpha', senderId: 'bob', threadId: 'lounge', taskId: 'summary-tail-noise', key: 'summary-tail', text: 'Late incidental chatter after background work; no reply. Keep valid commitments.'
                                });
                            }, 0);
                        }
                        return text;
                    }
                    catch {
                        summaries.push({
                            kind: 'failed', botId: bot.id, at: Date.now()
                        });
                        throw Error('Bounded background summary failed');
                    }
                    finally {
                        summaryInFlight--;
                    }
                }
            }
        })(bot, host));
        chat = new SimulatedChat(runtime);
        chat.channel('alpha', ['alice', 'bob']);
        chat.channel('beta', ['eve']);
        const initial = {
            channelId: 'alpha', senderId: 'alice', threadId: 'build', taskId: 'taskchain', key: 'taskchain-v1', text: chainText.replaceAll('unblocked', 'ready')
        };
        chat.send(initial);
        chat.send({
            channelId: 'alpha', senderId: 'alice', threadId: 'export', taskId: 'cancelled-export', key: 'export-prepare', text: 'Prepare only an export plan; no tool or reply. Wait for my choice.'
        });
        await new Promise(r => setTimeout(r, 25));
        const corrected = {
            ...initial, key: 'taskchain-v2', taskControl: 'replace' as const, text: 'Correction: use unblocked, never the obsolete ready notification. ' + chainText
        };
        chat.send(corrected);
        chat.send({
            channelId: 'alpha', senderId: 'alice', threadId: 'export', taskId: 'cancelled-export', key: 'export-cancel', taskControl: 'cancel', text: 'Cancel this export. No tool, delegation or reply.'
        });
        chat.send(corrected);
        await runtime.idle();
        await flood;
        // Only the evaluation host waits for independent background work; the agent never waits for summarization.
        while (summaryInFlight && !lifetime.signal.aborted)
            await new Promise(r => setTimeout(r, 20));
        await new Promise(r => setTimeout(r, 5));
        await runtime.idle();
        for (const b of runtime.listBots().filter(b => b.sessionFile))
            compactions.push(...SessionManager.open(b.sessionFile!).getBranch().filter(e => e.type === 'compaction').map(e => ({
                botId: b.id, entry: redactTraceValue(e)
            })));
        await chat.deliver();
        trace.inbox = runtime.store.list<Envelope>('inbox');
        trace.jobs = runtime.store.list<Job>('jobs');
        trace.outbox = runtime.store.list<Outbound>('outbox');
        const paired = runtime.listBots().filter(b => b.sessionFile).every(b => hasValidToolPairs(SessionManager.open(b.sessionFile!).buildSessionProjection().messages));
        const expected = [{
                task: 'taskchain', thread: 'build', sender: 'alice', text: 'READY TaskChain/solution.py'
            }, {
                task: 'progress-report', thread: 'report', sender: 'bob', text: 'READY Reports/progress.csv'
            }].filter(d => !options.cancelDuringExecution || d.task !== 'taskchain');
        const active = lateId ?? trace.inbox.find(e => e.key === 'taskchain-v2')?.id;
        const completed = expected.filter(d => artifacts.get(d.task)?.grade.pass && (d.task !== 'taskchain' || artifacts.get(d.task)!.originId === active) && trace.outbox.filter(o => o.taskId === d.task && o.state === 'delivered' && o.text === d.text && o.route?.channelId === 'alpha' && o.route.threadId === d.thread && o.route.senderId === d.sender).length === 1).length;
        const duplicates = expected.reduce((n, d) => n + Math.max(0, trace.outbox.filter(o => o.taskId === d.task).length - 1), 0) + submissions.length - new Set(submissions.map(s => JSON.stringify([s.task, s.originId, s.sha256]))).size;
        const score = {
            completedTasks: completed, expectedTasks: expected.length, missedTasks: expected.length - completed, noiseReplies: trace.outbox.filter(o => o.taskId.includes('noise')).length, cancelledActions: trace.jobs.filter(j => j.taskId === 'cancelled-export').length + trace.outbox.filter(o => o.taskId === 'cancelled-export' || options.cancelDuringExecution && o.taskId === 'taskchain').length + (options.cancelDuringExecution && artifacts.has('taskchain') ? 1 : 0), wrongRecipients: trace.outbox.filter(o => !expected.some(d => d.task === o.taskId && o.route?.channelId === 'alpha' && o.route.threadId === d.thread && o.route.senderId === d.sender) && !o.taskId.includes('noise') && o.taskId !== 'cancelled-export' && !(options.cancelDuringExecution && o.taskId === 'taskchain')).length, duplicateActions: duplicates, obsoleteFinalArtifacts: artifacts.get('taskchain') && artifacts.get('taskchain')!.originId !== active ? 1 : 0
        };
        const pending = trace.inbox.filter(e => e.state !== 'processed').length;
        await runtime.close();
        runtimeClosed = true;
        const cells = await collectCells(executionDir);
        // Pi's permission-block branch does not emit tool_result hooks; the native cell trace still records its actual outcome.
        for (const file of cells.filter(c => c.path.endsWith('.trace.jsonl')))
            for (const event of file.record as any[]) {
                if (event.type === 'tool_finished' && event.toolCallId && !trace.results.some(r => r.id === event.toolCallId))
                    trace.results.push(redactTraceValue({
                        order: ++order, botId: file.path.split('/')[0]!, id: event.toolCallId, parentId: event.parentToolCallId, name: event.name, isError: !!event.isError, content: event.result?.content ?? [], details: event.result?.details, capture: 'native-cell-reconciliation', at: event.at
                    }));
            }
        const first = processEvents.find(e => e.event === 'grade_started');
        const sameProcess = !!first && processEvents.filter(e => e.event === 'grade_started' && e.pid === first.pid).length === 1 && processEvents.filter(e => e.event === 'grade_finished' && e.pid === first.pid).length === 1;
        if (options.outputDir)
            for (const a of artifacts.values()) {
                const file = join(options.outputDir, a.file);
                await mkdir(join(file, '..'), {
                    recursive: true
                });
                await writeFile(file, a.code, {
                    mode: 0o600
                });
            }
        const compaction = {
            started: summaries.filter(e => e.kind === 'started').length, completed: summaries.filter(e => e.kind === 'completed').length, adopted: compactions.length, foregroundOverlap, lateCorrectionExcluded: !!lateId && summaries.some(e => e.kind === 'started' && !e.prefixInboxIds?.includes(lateId!)), blockedStaleActions: trace.results.filter(e => e.name === 'save_artifact' && e.isError && JSON.stringify(e.content).includes('superseded')).length, lateCorrectionId: lateId, summaries, entries: compactions
        };
        const compressionPass = !options.backgroundSummary || compaction.started > 0 && compaction.completed > 0 && compaction.adopted > 0 && foregroundOverlap > 0 && compaction.lateCorrectionExcluded && compaction.blockedStaleActions > 0;
        return {
            mode, backgroundExecution: true, compaction, provenance: {
                benchmark: 'MARBLE TaskChain adapted subset plus computed CSV companion', upstreamCommit: '8d60fa17b5596b44458a52d4296061b9fc13d6f2', taskId: 46, adaptations: ['one active Pi bot handles two independent member tasks', 'native codemode -> submit_taskchain -> executable validator', 'controlled validation pause for observable overlapping input', 'not the original MARBLE orchestration or score']
            }, score, submissions, grades: Object.fromEntries([...artifacts].map(([task, a]) => [task, a.grade])), trace: redactTraceValue(trace), background: {
                observedProgress: observedProgress(), fullResultRead: fullRead(), cells, processStarts: processEvents.filter(e => e.event === 'grade_started').length, processEnds: processEvents.filter(e => e.event === 'grade_finished').length, sameProcess, processEvents, blockedStaleActions: compaction.blockedStaleActions, cancelId
            }, pendingEvents: pending, runtimeErrors: runtime.errors.length, nativeToolErrors: trace.results.filter(r => r.isError).length, transcriptPairsValid: paired, timeouts: {
                roundReached: lifetime.signal.aborted, providerRequests: timeouts
            }, budget: {
                requests: budget.requests, inputReserved: budget.inputReserved, outputReserved: budget.outputReserved, refused: budget.refused
            }, pass: compressionPass && (!options.cancelDuringExecution || compaction.blockedStaleActions > 0) && completed === expected.length && duplicates === 0 && score.noiseReplies === 0 && score.cancelledActions === 0 && score.wrongRecipients === 0 && score.obsoleteFinalArtifacts === 0 && pending === 0 && runtime.errors.length === 0 && paired && sameProcess && observedProgress() && (options.cancelDuringExecution || fullRead()) && !lifetime.signal.aborted && timeouts === 0 && budget.refused === 0
        };
    }
    finally {
        clearInterval(monitor);
        clearTimeout(deadline);
        lifetime.abort();
        await writeFile(releasePath, 'released', {
            mode: 0o600
        }).catch(() => {
        });
        if (runtime && !runtimeClosed)
            await runtime.close();
        await rm(root, {
            recursive: true, force: true
        });
    }
}
