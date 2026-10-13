import { createEvaluationDirectory } from './evaluation-directory.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execute = promisify(execFile);
export interface CodeGrade {
    pass: boolean;
    passed: string[];
    failed: string[];
    failureReasons?: Record<string, string>;
}
/** Independent executable oracle, isolated from the inference host and its credentials. */
export async function gradeTaskChain(code: string, options: {
    pauseUntil?: string;
    expectedRelease?: string;
    onProgress?: (event: {
        event: string;
        pid: number;
    }) => void;
} = {}): Promise<CodeGrade> {
    const temporary = await createEvaluationDirectory('pi-taskchain-grade-');
    const dir = await realpath(temporary);
    try {
        if (Buffer.byteLength(code) > 32000)
            return {
                pass: false, passed: [], failed: ['artifact-size']
            };
        await writeFile(join(dir, 'solution.py'), code, {
            mode: 0o600
        });
        await writeFile(join(dir, 'grade.py'), await readFile(new URL('../../fixtures/marble-taskchain/grade.py', import.meta.url)), {
            mode: 0o600
        });
        const profile = `(version 1)(deny default)(allow process*)(allow sysctl-read)(allow mach-lookup)(allow file-read*)(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/Library/Keychains"))(allow file-read* (subpath ${JSON.stringify(dir)}))(allow file-write* (subpath ${JSON.stringify(dir)}))${options.pauseUntil ? `(allow file-read* (literal ${JSON.stringify(options.pauseUntil)}))` : ""}`;
        const stdout = await new Promise<string>((resolve, reject) => {
            const child = execFile('/usr/bin/sandbox-exec', ['-p', profile, '/Applications/Xcode.app/Contents/Developer/usr/bin/python3', '-I', '-S', '-B', 'grade.py', options.pauseUntil ?? '', options.expectedRelease ?? ''], {
                cwd: dir, env: {}, timeout: options.pauseUntil ? 600000 : 15000, maxBuffer: 65536
            }, (error, out) => error ? reject(Error('Oracle process failed')) : resolve(out));
            let pending = '';
            child.stdout?.on('data', (chunk: string | Buffer) => {
                pending += chunk.toString();
                const lines = pending.split('\n');
                pending = lines.pop()!;
                for (const line of lines)
                    try {
                        const event = JSON.parse(line);
                        if (['grade_started', 'grade_finished'].includes(event.event) && Number.isSafeInteger(event.pid))
                            options.onProgress?.({
                                event: event.event, pid: event.pid
                            });
                    }
                    catch { /* Non-progress output is handled by the final oracle parser. */
                    }
            });
        });
        const result = stdout.trim().split('\n').map(line => JSON.parse(line)).find(value => typeof value.pass === 'boolean');
        if (typeof result.pass !== 'boolean' || !Array.isArray(result.passed) || !Array.isArray(result.failed))
            throw Error('Invalid oracle response');
        return result;
    }
    catch {
        return {
            pass: false, passed: [], failed: ['oracle-process-failed']
        };
    }
    finally {
        await rm(dir, {
            recursive: true, force: true
        });
    }
}
export function gradeProgressCsv(csv: string): boolean {
    const rows = csv.trim().split(/\r?\n/).map(line => line.split(',').map(cell => cell.trim()));
    if (rows.length !== 3 || rows[0]?.join(',') !== 'owner,total,completed,completion_rate')
        return false;
    const expected = new Map([['alice', [2, 1, 0.5]], ['bob', [3, 2, 2 / 3]]]);
    const seen = new Set<string>();
    return rows.slice(1).every(row => {
        const [owner, ...cells] = row;
        const value = expected.get(owner!);
        if (!value || seen.has(owner!) || cells.length !== 3)
            return false;
        seen.add(owner!);
        return cells.every((cell, i) => Number.isFinite(Number(cell)) && Math.abs(Number(cell) - value[i]!) < 0.000001);
    });
}
import { Type } from 'typebox';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { ModelRuntime, SessionManager, type ToolDefinition, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, type Model, type Api, type TranscriptContext } from '@earendil-works/pi-ai';
import { BotRuntime } from '../daemon/runtime/runtime.ts';
import { piSessionFactory } from '../pi/session-factory.ts';
import { SimulatedChat } from './chat.ts';
import { RequestBudget, SMOKE_CAP } from './evaluation.ts';
import { hasValidToolPairs } from '../pi/context.ts';
import { redactTraceValue, inboxIds, observeEvaluationTools, type EvaluationTrace } from './evaluation-trace.ts';
import type { Bot, Envelope, Job, Outbound } from '../daemon/runtime/store.ts';
export const TASKCHAIN_SPEC = `Implement a runnable headless TaskChain prototype in Python (adapted from MARBLE coding task 46). No imports, network, filesystem access or main block. Define class TaskChain with:
add_task(task_id, dependencies=None): unique IDs; dependencies must already exist; initially pending. Invalid IDs/dependencies raise ValueError/KeyError without mutation.
start(task_id): pending -> in_progress only when all dependencies completed; otherwise ValueError/KeyError.
complete(task_id): in_progress -> completed only; repeated/invalid transitions raise ValueError/KeyError without mutation or duplicate notifications.
add_comment(task_id, author, text): append {author,text} in order for collaborative notes.
snapshot(): dict keyed by ID, each value {status,dependencies,comments}.
notifications(): list of {kind,task_id}. Completion emits kind=completed; when completion makes a pending dependent runnable, emit kind=unblocked exactly once. For dependencies [A,C], no unblocked event before both complete.
report(): dict with sorted ID lists keyed pending,in_progress,completed.
diagram(): Mermaid string containing graph TD or flowchart TD and lines like A --> B for dependencies.
Do not implement a web frontend or claim a full upstream benchmark pass. Submit code using start_job tool submit_taskchain with args {code}; host binds message_id. Use source_message_id for this task. Delegate to same-channel worker, who performs the submission and sends exactly READY TaskChain/solution.py only after the native job reports all checks passed. No acknowledgements or progress replies; no polling. End turn while waiting for native job completion.`;
export const PROGRESS_SPEC = `Produce a real CSV progress report from this dataset:
task,owner,status
A,alice,completed
B,alice,pending
C,bob,completed
D,bob,completed
E,bob,in_progress
Compute each owner's total, completed and completion_rate (completed/total; six decimal places allowed). CSV header owner,total,completed,completion_rate; sorted owners, no prose. Use start_job tool submit_progress_csv with args {csv}; host binds message_id. Delegate to same-channel worker, who submits and sends exactly READY Reports/progress.csv only after native job validation passes. Use source_message_id for the intended task. No acknowledgements, progress replies or polling.`;
const desired = [
    {
        task: 'taskchain', channel: 'alpha', thread: 'build', sender: 'alice', text: 'READY TaskChain/solution.py', file: 'TaskChain/solution.py'
    },
    {
        task: 'progress-report', channel: 'beta', thread: 'report', sender: 'eve', text: 'READY Reports/progress.csv', file: 'Reports/progress.csv'
    }
];
function envelopes(context: TranscriptContext): any[] {
    return context.messages.filter(m => m.role === 'user').flatMap(m => {
        const text = typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
        try {
            const e = JSON.parse(text);
            return e.type === 'inbox' ? [e] : [];
        }
        catch {
            return [];
        }
    });
}
export interface WorkEvaluationReport {
    mode: 'real' | 'scripted';
    pass: boolean;
    score: {
        completedTasks: number;
        expectedTasks: number;
        [key: string]: number;
    };
    trace: EvaluationTrace;
    budget: {
        requests: number;
        inputReserved: number;
        outputReserved: number;
        refused: number;
    };
    backgroundExecution?: boolean;
    background?: {
        observedProgress: boolean;
        cells: {
            path: string;
            record: unknown;
        }[];
        processStarts: number;
        processEnds: number;
        sameProcess: boolean;
        [key: string]: unknown;
    };
    compaction?: {
        started: number;
        completed: number;
        adopted: number;
        foregroundOverlap: number;
        lateCorrectionExcluded: boolean;
        blockedStaleActions: number;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
export async function runTaskChainEvaluation(options: {
    mode?: 'real' | 'scripted';
    modelRuntime?: ModelRuntime;
    model?: Model<Api>;
    outputDir?: string;
    budget?: RequestBudget;
    backgroundExecution?: boolean;
    backgroundSummary?: boolean;
    cancelDuringExecution?: boolean;
} = {}): Promise<WorkEvaluationReport> {
    if (options.backgroundExecution)
        return (await import('./observed-taskchain-evaluation.ts')).runObservedTaskChainEvaluation(options);
    const mode = options.mode ?? 'real';
    if (mode === 'real' && (!options.modelRuntime || !options.model))
        throw Error('Real provider required');
    const root = await createEvaluationDirectory('pi-real-work-');
    const budget = options.budget ?? new RequestBudget();
    const lifetime = new AbortController();
    const deadline = setTimeout(() => lifetime.abort(), SMOKE_CAP.deadlineMs);
    const trace: EvaluationTrace = {
        inbox: [], jobs: [], outbox: [], calls: [], results: [], boundaries: []
    };
    let order = 0, timeouts = 0;
    const artifacts = new Map<string, {
        code: string;
        file: string;
        grade: CodeGrade | {
            pass: boolean;
        };
        originId: string;
    }>();
    const submissions: {
        task: string;
        originId: string;
        sha256: string;
        pass: boolean;
    }[] = [];
    let runtime!: BotRuntime;
    let chat!: SimulatedChat;
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const faux = mode === 'scripted' ? fauxProvider({
        provider: 'real-work-offline', models: [{
                id: 'scripted', contextWindow: 1000000, maxTokens: 16384
            }], tokensPerSecond: 1000000
    }) : undefined;
    try {
        if (faux) {
            const reference = await readFile(new URL('../../fixtures/marble-taskchain/reference.py', import.meta.url), 'utf8');
            const policy = async (context: TranscriptContext) => {
                await new Promise(r => setTimeout(r, 40));
                const latest = new Map<string, any>();
                for (const e of envelopes(context))
                    if (e.kind !== 'job')
                        latest.set(e.taskId, e);
                const content = [];
                for (const e of latest.values()) {
                    if (!desired.some(d => d.task === e.taskId) || e.taskControl === 'cancel')
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
                    const bot = runtime.store.get<Bot>('bots', e.to)!;
                    if (bot.name.endsWith(':coordinator')) {
                        if (!runtime.store.list<Envelope>('inbox').some(x => x.kind === 'bot' && x.replyTo === e.messageId))
                            content.push(fauxToolCall('send_to_bot', {
                                bot_id: chat.channels.get(e.route.channelId)!.worker.id, text: e.text, key: 'delegate:' + e.taskId, source_message_id: e.messageId
                            }));
                    }
                    else if (!artifacts.get(e.taskId)?.grade.pass) {
                        if (!runtime.store.list<Job>('jobs').some(j => j.botId === e.to && j.taskId === e.taskId))
                            content.push(fauxToolCall('start_job', {
                                tool: e.taskId === 'taskchain' ? 'submit_taskchain' : 'submit_progress_csv', args: e.taskId === 'taskchain' ? {
                                    code: reference
                                } : {
                                    csv: 'owner,total,completed,completion_rate\nalice,2,1,0.5\nbob,3,2,0.666667\n'
                                }, key: 'submit:' + e.taskId, source_message_id: e.messageId
                            }));
                    }
                    else if (!runtime.store.list<Outbound>('outbox').some(o => o.taskId === e.taskId))
                        content.push(fauxToolCall('send_message', {
                            text: desired.find(d => d.task === e.taskId)!.text, key: 'done:' + e.taskId, source_message_id: e.messageId
                        }));
                }
                return content.length ? fauxAssistantMessage(content, {
                    stopReason: 'toolUse'
                }) : fauxAssistantMessage('internal');
            };
            faux.setResponses(Array.from({
                length: 80
            }, () => policy));
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
        const toolsFor = (bot: Bot): ToolDefinition[] => ['submit_taskchain', 'submit_progress_csv'].map(name => ({
            name, label: name, description: name === 'submit_taskchain' ? 'Save generated TaskChain Python code and execute 12 independent behavioral tests. Result pass means tested code, not user delivery.' : 'Save a computed CSV report and independently validate its data. Result pass means validated CSV, not user delivery.', parameters: name === 'submit_taskchain' ? Type.Object({
                message_id: Type.String(), code: Type.String({
                    maxLength: 32000
                })
            }) : Type.Object({
                message_id: Type.String(), csv: Type.String({
                    maxLength: 4000
                })
            }), async execute(_id, raw) {
                const p = raw as {
                    message_id: string;
                    code?: string;
                    csv?: string;
                };
                const e = runtime.store.get<Envelope>('inbox', p.message_id);
                const expected = desired.find(d => d.task === e?.taskId && d.channel === bot.channelId);
                if (!e || e.to !== bot.id || !expected || (name === 'submit_taskchain') !== (e.taskId === 'taskchain'))
                    throw Error('Artifact task/source rejected');
                runtime.assertTaskCurrent(e);
                const code = p.code ?? p.csv!;
                const grade = name === 'submit_taskchain' ? await gradeTaskChain(code) : {
                    pass: gradeProgressCsv(code)
                };
                const artifact = {
                    code, file: expected.file, grade, originId: origin(e)
                };
                artifacts.set(e.taskId, artifact);
                submissions.push({
                    task: e.taskId, originId: artifact.originId, sha256: createHash('sha256').update(code).digest('hex'), pass: grade.pass
                });
                return {
                    content: [{
                            type: 'text', text: JSON.stringify({
                                artifact: artifact.file, grade
                            })
                        }], details: {
                        artifact: artifact.file, grade
                    }
                };
            }
        }));
        runtime = new BotRuntime(join(root, 'runtime.db'), async (bot, host) => piSessionFactory({
            dir: join(root, 'sessions'), modelRuntime, model: faux?.getModel() ?? options.model!, tools: toolsFor(bot), allowTools: ['submit_taskchain', 'submit_progress_csv'], jobSourceArguments: {
                submit_taskchain: 'message_id', submit_progress_csv: 'message_id'
            }, modelNativeTools: ['send_message', 'send_to_bot', 'list_bots', 'start_job', 'job_result'], extensions: [...(faux ? [(pi: Parameters<ExtensionFactory>[0]) => pi.registerProvider(faux.provider)] : []), observeEvaluationTools(trace, bot.id, () => ++order)], maxRequestsPerWake: 16, maxOutputTokens: 16384, thinkingLevel: mode === 'real' ? 'high' : undefined, inferenceSignal: lifetime.signal, inferenceRequestTimeoutMs: SMOKE_CAP.requestTimeoutMs, onInferenceTimeout: () => timeouts++, beforeProviderRequest: (context, max) => {
                if (budget.accounting === 'wire')
                    budget.assertRequestAllowance(max);
                else
                    budget.reserve(context, max);
                trace.boundaries.push({
                    order: ++order, botId: bot.id, inboxIds: inboxIds(context)
                });
            }, context: {
                backgroundEnabled: false, maxContextTokens: 256000, outputReserveTokens: 16384
            }
        })(bot, host));
        chat = new SimulatedChat(runtime);
        chat.channel('alpha', ['alice', 'bob']);
        chat.channel('beta', ['eve', 'alice']);
        const initial = {
            channelId: 'alpha', senderId: 'alice', threadId: 'build', taskId: 'taskchain', key: 'taskchain-v1', text: TASKCHAIN_SPEC.replaceAll('unblocked', 'ready')
        };
        chat.send(initial);
        await new Promise(r => setTimeout(r, 5));
        chat.send({
            channelId: 'beta', senderId: 'eve', threadId: 'report', taskId: 'progress-report', key: 'report-v1', text: PROGRESS_SPEC
        });
        chat.send({
            channelId: 'alpha', senderId: 'alice', threadId: 'export', taskId: 'cancelled-export', key: 'export-v1', text: 'Prepare only an export plan; do not run a tool or reply. Wait for my choice.'
        });
        await new Promise(r => setTimeout(r, 20));
        const corrected = {
            ...initial, key: 'taskchain-v2', taskControl: 'replace' as const, text: 'Correction: notification kind ready is obsolete; use unblocked instead. ' + TASKCHAIN_SPEC
        };
        chat.send(corrected);
        chat.send({
            channelId: 'alpha', senderId: 'alice', threadId: 'export', taskId: 'cancelled-export', key: 'export-cancel', taskControl: 'cancel', text: 'Cancel this export. No tool, delegation or reply.'
        });
        for (let i = 0; i < 14; i++) {
            await new Promise(r => setTimeout(r, 5));
            chat.send({
                channelId: i % 2 ? 'alpha' : 'beta', senderId: i % 2 ? 'bob' : 'alice', threadId: 'lounge', taskId: 'noise-' + i, key: 'noise-' + i, text: 'Incidental group chatter about lunch. No task; no reply needed.'
            });
        }
        chat.send(corrected); // Transport duplicate: same sender/key, not a second instruction.
        await runtime.idle();
        await chat.deliver();
        trace.inbox = runtime.store.list<Envelope>('inbox');
        trace.jobs = runtime.store.list<Job>('jobs');
        trace.outbox = runtime.store.list<Outbound>('outbox');
        const pairValidity = runtime.listBots().filter(b => b.sessionFile).every(b => hasValidToolPairs(SessionManager.open(b.sessionFile!).buildSessionProjection().messages));
        const activeOrigin = trace.inbox.find(e => e.key.includes('taskchain-v2'))?.id;
        const completedTasks = desired.filter(d => {
            const a = artifacts.get(d.task);
            const replies = chat.deliveries.filter(o => o.taskId === d.task && o.text === d.text && o.route?.channelId === d.channel && o.route.threadId === d.thread && o.route.senderId === d.sender);
            return a?.grade.pass && (d.task !== 'taskchain' || a.originId === activeOrigin) && replies.length === 1;
        }).length;
        const duplicateReplies = desired.reduce((sum, d) => sum + Math.max(0, chat.deliveries.filter(o => o.taskId === d.task).length - 1), 0);
        const repeated = new Set<string>();
        let duplicateArtifacts = 0;
        for (const s of submissions) {
            const key = JSON.stringify([s.task, s.originId, s.sha256]);
            if (repeated.has(key))
                duplicateArtifacts++;
            repeated.add(key);
        }
        const score = {
            completedTasks, expectedTasks: 2, missedTasks: 2 - completedTasks, noiseReplies: chat.deliveries.filter(o => o.taskId.startsWith('noise-')).length, cancelledActions: submissions.filter(s => s.task === 'cancelled-export').length + trace.calls.filter(c => c.name === 'send_to_bot' && trace.inbox.find(e => e.id === (c.args as any)?.source_message_id)?.taskId === 'cancelled-export').length + chat.deliveries.filter(o => o.taskId === 'cancelled-export').length, wrongRecipients: chat.deliveries.filter(o => !desired.some(d => d.task === o.taskId && o.route?.channelId === d.channel && o.route.threadId === d.thread && o.route.senderId === d.sender) && !o.taskId.startsWith('noise-') && o.taskId !== 'cancelled-export').length, duplicateActions: duplicateReplies + duplicateArtifacts, obsoleteFinalArtifacts: artifacts.get('taskchain') && artifacts.get('taskchain')!.originId !== activeOrigin ? 1 : 0
        };
        const pendingEvents = trace.inbox.filter(e => e.state !== 'processed').length;
        if (options.outputDir)
            for (const artifact of artifacts.values()) {
                const file = join(options.outputDir, artifact.file);
                await mkdir(join(file, '..'), {
                    recursive: true
                });
                await writeFile(file, artifact.code, {
                    mode: 0o600
                });
            }
        return {
            mode, provenance: {
                benchmark: 'MARBLE / MultiAgentBench adapted subset', upstreamCommit: '8d60fa17b5596b44458a52d4296061b9fc13d6f2', taskId: 46, adaptations: ['headless deterministic TaskChain API', 'computed CSV companion task', 'scheduled chatter, explicit correction/cancel and duplicate delivery', 'two Pi bots per channel; original MARBLE orchestration not used']
            }, score, submissions, grades: Object.fromEntries([...artifacts].map(([task, a]) => [task, a.grade])), trace: redactTraceValue(trace), pendingEvents, runtimeErrors: runtime.errors.length, nativeToolErrors: trace.results.filter(r => r.isError).length, transcriptPairsValid: pairValidity, timeouts: {
                roundReached: lifetime.signal.aborted, providerRequests: timeouts
            }, budget: {
                requests: budget.requests, inputReserved: budget.inputReserved, outputReserved: budget.outputReserved, refused: budget.refused
            }, pass: completedTasks === 2 && score.noiseReplies === 0 && score.cancelledActions === 0 && score.wrongRecipients === 0 && score.duplicateActions === 0 && score.obsoleteFinalArtifacts === 0 && pendingEvents === 0 && runtime.errors.length === 0 && pairValidity && !lifetime.signal.aborted && timeouts === 0 && budget.refused === 0
        };
    }
    finally {
        clearTimeout(deadline);
        lifetime.abort();
        if (runtime)
            await runtime.close();
        await rm(root, {
            recursive: true, force: true
        });
    }
}
