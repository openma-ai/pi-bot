import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Type } from 'typebox';
import { ModelRuntime, type ExtensionFactory, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep } from '@earendil-works/pi-ai';
import { BotRuntime } from '../src/runtime.ts';
import { piSessionFactory, type PiOptions } from '../src/pi.ts';
import type { Envelope, Job, Outbound, Question } from '../src/store.ts';
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => resolve = r);
    return {
        promise, resolve
    };
};
const until = async (f: () => boolean) => {
    const end = Date.now() + 5000;
    while (!f()) {
        if (Date.now() > end)
            throw Error('timed out');
        await new Promise(r => setTimeout(r, 5));
    }
};
async function setup(steps: FauxResponseStep[], tools: ToolDefinition[] = [], extensions: ExtensionFactory[] = [], maxRequestsPerWake = 16, context?: PiOptions['context'], preemptInference = false, extra: Partial<PiOptions> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'pi-real-audit-'));
    const faux = fauxProvider({
        provider: `audit-${Math.random().toString(36).slice(2)}`, models: [{
                id: 'mock', contextWindow: 128000, maxTokens: 4096
            }], tokensPerSecond: 1000000
    });
    faux.setResponses(steps);
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false
    });
    const runtime = new BotRuntime(join(dir, 'bot.db'), piSessionFactory({
        dir: join(dir, 'sessions'), modelRuntime, model: faux.getModel(), tools, extensions: [pi => pi.registerProvider(faux.provider), ...extensions], allowTools: tools.map(t => t.name), maxRequestsPerWake, context, preemptInference, ...extra
    }));
    return {
        runtime, faux, dir, modelRuntime, async close() {
            await runtime.close();
            await rm(dir, {
                recursive: true, force: true
            });
        }
    };
}
test('audit Pi: sender is runtime-bound and bot/user/ask channels stay distinct', async () => {
    let target = '';
    const h = await setup([(ctx) => fauxAssistantMessage([
            fauxToolCall('send_to_bot', {
                bot_id: target, text: 'teammate data', key: 'bot-send', from: 'user', kind: 'user'
            }, {
                id: 'bot'
            }),
            fauxToolCall('send_message', {
                text: 'owner update', key: 'user-send', botId: 'spoof'
            }, {
                id: 'owner'
            }),
            fauxToolCall('ask_user', {
                question: 'Which option?', key: 'ask', botId: 'spoof'
            }, {
                id: 'ask'
            })
        ], {
            stopReason: 'toolUse'
        }), ...Array.from({
            length: 8
        }, () => fauxAssistantMessage('done'))]);
    try {
        const a = h.runtime.createBot('a'), b = h.runtime.createBot('b');
        target = b.id;
        h.runtime.accept({
            to: a.id, text: 'start', key: 'root'
        });
        await h.runtime.idle();
        const botMail = h.runtime.store.list<Envelope>('inbox').find(e => e.key === 'bot-send');
        assert.ok(botMail);
        assert.equal(botMail.from, a.id);
        assert.equal(botMail.to, b.id);
        assert.equal(botMail.kind, 'bot');
        const outbox = h.runtime.store.list<Outbound>('outbox');
        assert.equal(outbox.length, 2);
        assert.ok(outbox.every(o => o.botId === a.id && o.state === 'pending'));
        const questions = h.runtime.store.list<Question>('questions');
        assert.equal(questions.length, 1);
        assert.equal(questions[0]?.botId, a.id);
        assert.equal(questions[0]?.state, 'pending');
        assert.equal(h.runtime.errors.length, 0);
        assert.ok(h.runtime.listBots().every(b => b.sessionFile));
    }
    finally {
        await h.close();
    }
});
test('audit Pi: detached tools traverse native deny hooks with parent correlation', async () => {
    let effects = 0;
    let parent: string | undefined;
    const tool: ToolDefinition = {
        name: 'denied', label: 'Denied', description: 'Denied', parameters: Type.Object({}), async execute() {
            effects++;
            return {
                content: [{
                        type: 'text', text: 'bad'
                    }], details: {}
            };
        }
    };
    const h = await setup([fauxAssistantMessage(fauxToolCall('start_job', {
            tool: 'denied', args: {}, key: 'once'
        }, {
            id: 'dispatch'
        }), {
            stopReason: 'toolUse'
        }), ...Array.from({
            length: 6
        }, () => fauxAssistantMessage('done'))], [tool], [pi => {
            pi.on('tool_call', e => {
                if (e.toolName === 'denied') {
                    parent = e.parentToolCallId;
                    return {
                        block: true, reason: 'audit refusal'
                    };
                }
            });
        }]);
    try {
        const b = h.runtime.createBot('bot');
        h.runtime.accept({
            to: b.id, text: 'run', key: 'root'
        });
        await h.runtime.idle();
        assert.equal(effects, 0);
        assert.equal(parent, 'dispatch');
        const jobs = h.runtime.store.list<Job>('jobs');
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.state, 'failed');
        assert.match(h.runtime.jobResult(b.id, jobs[0]!.id).text ?? '', /audit refusal/);
    }
    finally {
        await h.close();
    }
});
test('audit Pi: new user message enters next model boundary without aborting active request', async () => {
    const started = deferred(), release = deferred();
    let signal: AbortSignal | undefined;
    let nextContext = '';
    const h = await setup([async (_ctx, options) => {
            signal = options?.signal;
            started.resolve();
            await release.promise;
            return fauxAssistantMessage(fauxToolCall('list_bots', {}, {
                id: 'list'
            }), {
                stopReason: 'toolUse'
            });
        }, ctx => {
            nextContext = JSON.stringify(ctx);
            return fauxAssistantMessage('both handled');
        }, ...Array.from({
            length: 4
        }, () => fauxAssistantMessage('done'))]);
    try {
        const b = h.runtime.createBot('bot');
        const first = h.runtime.accept({
            to: b.id, text: 'first turn', key: 'first'
        });
        await started.promise;
        const second = h.runtime.accept({
            to: b.id, text: 'SECOND_BOUNDARY_MESSAGE', key: 'second'
        });
        assert.equal(signal?.aborted, false);
        assert.equal(h.faux.state.callCount, 1);
        release.resolve();
        await h.runtime.idle();
        assert.equal(signal?.aborted, false);
        assert.match(nextContext, /SECOND_BOUNDARY_MESSAGE/);
        assert.equal(h.runtime.store.get<Envelope>('inbox', first.id)?.state, 'processed');
        assert.equal(h.runtime.store.get<Envelope>('inbox', second.id)?.state, 'processed');
    }
    finally {
        release.resolve();
        await h.close();
    }
});
test('audit Pi: per-wake model request cap actually fails closed', async () => {
    const looping = () => fauxAssistantMessage(fauxToolCall('list_bots', {}, {
        id: `list-${Math.random()}`
    }), {
        stopReason: 'toolUse'
    });
    const h = await setup([...Array.from({
            length: 12
        }, looping), fauxAssistantMessage('done')], [], [], 2);
    try {
        const b = h.runtime.createBot('bot');
        h.runtime.accept({
            to: b.id, text: 'bounded loop', key: 'bounded'
        });
        await h.runtime.idle();
        assert.ok(h.faux.state.callCount <= 2, `made ${h.faux.state.callCount} provider requests after cap 2`);
        assert.ok(h.runtime.errors.length > 0);
    }
    finally {
        await h.close();
    }
});
test('audit Pi: oversized context never reaches provider and receipt is not processed', async () => {
    const h = await setup([fauxAssistantMessage('must not run')], [], [], 16, {
        maxContextTokens: 32000
    });
    try {
        const b = h.runtime.createBot('bot');
        const e = h.runtime.accept({
            to: b.id, text: 'H'.repeat(50000), key: 'oversized'
        });
        await h.runtime.idle();
        assert.equal(h.faux.state.callCount, 0);
        assert.equal(h.runtime.store.get<Envelope>('inbox', e.id)?.state, 'uncertain');
    }
    finally {
        await h.close();
    }
});
test('audit Pi: provider failure is not falsely recorded as processed input', async () => {
    const h = await setup([fauxAssistantMessage('', {
            stopReason: 'error', errorMessage: 'audit provider failure'
        })]);
    try {
        const b = h.runtime.createBot('bot');
        const e = h.runtime.accept({
            to: b.id, text: 'run', key: 'provider-error'
        });
        await h.runtime.idle();
        assert.equal(h.runtime.store.get<Envelope>('inbox', e.id)?.state, 'uncertain');
    }
    finally {
        await h.close();
    }
});
test('audit Pi: restart resumes same native session and restores transcript context', async () => {
    let resumed = '';
    const h = await setup([fauxAssistantMessage('FIRST_RESPONSE'), ctx => {
            resumed = JSON.stringify(ctx);
            return fauxAssistantMessage('resumed');
        }]);
    let replacement: BotRuntime | undefined;
    try {
        const b = h.runtime.createBot('bot');
        h.runtime.accept({
            to: b.id, text: 'FIRST_REQUEST_RETAINED', key: 'one'
        });
        await h.runtime.idle();
        const sessionFile = h.runtime.listBots()[0]!.sessionFile;
        await h.runtime.close();
        replacement = new BotRuntime(join(h.dir, 'bot.db'), piSessionFactory({
            dir: join(h.dir, 'sessions'), modelRuntime: h.modelRuntime, model: h.faux.getModel(), extensions: [pi => pi.registerProvider(h.faux.provider)]
        }));
        replacement.accept({
            to: b.id, text: 'second request', key: 'two'
        });
        await replacement.idle();
        assert.equal(replacement.listBots()[0]!.sessionFile, sessionFile);
        assert.match(resumed, /FIRST_REQUEST_RETAINED/);
        assert.match(resumed, /FIRST_RESPONSE/);
    }
    finally {
        await replacement?.close();
        await h.close();
    }
});
test('audit Pi: detached slow tool does not hold provider turn and completion later wakes same bot', async () => {
    const gate = deferred();
    let started = false;
    const tool: ToolDefinition = {
        name: 'slow', label: 'Slow', description: 'Slow', parameters: Type.Object({}), async execute() {
            started = true;
            await gate.promise;
            return {
                content: [{
                        type: 'text', text: 'LATE_RESULT'
                    }], details: {
                    proof: 7
                }
            };
        }
    };
    const h = await setup([fauxAssistantMessage(fauxToolCall('start_job', {
            tool: 'slow', args: {}, key: 'slow'
        }, {
            id: 'slow-dispatch'
        }), {
            stopReason: 'toolUse'
        }), fauxAssistantMessage('receipt handled'), fauxAssistantMessage('completed')], [tool]);
    try {
        const b = h.runtime.createBot('bot');
        const e = h.runtime.accept({
            to: b.id, text: 'start slow', key: 'root'
        });
        await until(() => started && h.runtime.store.get<Envelope>('inbox', e.id)?.state === 'processed');
        assert.equal(h.faux.state.callCount, 2);
        assert.equal(h.runtime.store.list<Job>('jobs')[0]?.state, 'running');
        gate.resolve();
        await h.runtime.idle();
        assert.equal(h.faux.state.callCount, 3);
        assert.match(h.runtime.jobResult(b.id, h.runtime.store.list<Job>('jobs')[0]!.id).text ?? '', /LATE_RESULT/);
        assert.equal(h.runtime.store.list<Job>('jobs')[0]?.state, 'completed');
    }
    finally {
        gate.resolve();
        await h.close();
    }
});
test('audit Pi: arrival at agent-end does not acknowledge still-running input', async () => {
    const held = deferred(), release = deferred();
    let incoming: Envelope | undefined;
    let acceptAtEnd: (() => void) | undefined;
    const h = await setup([fauxAssistantMessage('first done'), async () => {
            held.resolve();
            await release.promise;
            return fauxAssistantMessage('second done');
        }], [], [pi => {
            pi.on('agent_end', () => {
                const fn = acceptAtEnd;
                acceptAtEnd = undefined;
                fn?.();
            });
        }]);
    try {
        const b = h.runtime.createBot('bot');
        acceptAtEnd = () => {
            incoming = h.runtime.accept({
                to: b.id, text: 'arrived at end', key: 'at-end'
            });
        };
        h.runtime.accept({
            to: b.id, text: 'first', key: 'first'
        });
        await held.promise;
        await new Promise(r => setTimeout(r, 10));
        assert.equal(h.runtime.store.get<Envelope>('inbox', incoming!.id)?.state, 'processing');
        release.resolve();
        await h.runtime.idle();
        assert.equal(h.runtime.store.get<Envelope>('inbox', incoming!.id)?.state, 'processed');
    }
    finally {
        release.resolve();
        await h.close();
    }
});
test('audit Pi: failed native outcomes preserve structured details and usage in durable pages', async () => {
    const usage = {
        input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0
        }
    };
    const tool: ToolDefinition = {
        name: 'failure', label: 'Failure', description: 'Structured error', parameters: Type.Object({}), outputSchema: Type.Object({
            code: Type.String()
        }), async execute() {
            return {
                isError: true, content: [{
                        type: 'text', text: 'failed but billed'
                    }], structuredContent: {
                    code: 'E_AUDIT'
                }, details: {
                    retryable: false
                }, usage
            };
        }
    };
    const h = await setup([fauxAssistantMessage(fauxToolCall('start_job', {
            tool: 'failure', args: {}, key: 'failure'
        }, {
            id: 'failure'
        }), {
            stopReason: 'toolUse'
        }), ...Array.from({
            length: 5
        }, () => fauxAssistantMessage('done'))], [tool]);
    try {
        const b = h.runtime.createBot('bot');
        h.runtime.accept({
            to: b.id, text: 'run', key: 'root'
        });
        await h.runtime.idle();
        const job = h.runtime.store.list<Job>('jobs')[0]!;
        assert.equal(job.state, 'failed');
        const archived = JSON.parse(h.runtime.jobResult(b.id, job.id, 0, 8000).text!);
        assert.equal(archived.isError, true);
        assert.deepEqual(archived.result.structuredContent, {
            code: 'E_AUDIT'
        });
        assert.deepEqual(archived.result.details, {
            retryable: false
        });
        assert.deepEqual(archived.result.usage, usage);
    }
    finally {
        await h.close();
    }
});
test('behavior fixture: user correction preempts inference; flood stays native and silence is scored', async () => {
    const started = deferred();
    let providerSignal: AbortSignal | undefined;
    let transcript = '';
    const h = await setup([async (_ctx, options) => {
            providerSignal = options?.signal;
            started.resolve();
            await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), {
                once: true
            }));
            return fauxAssistantMessage([], {
                stopReason: 'aborted'
            });
        }, ctx => {
            transcript = JSON.stringify(ctx);
            return fauxAssistantMessage(fauxToolCall('send_message', {
                text: 'Corrected: blue', key: 'corrected'
            }, {
                id: 'corrected'
            }), {
                stopReason: 'toolUse'
            });
        }, ...Array.from({
            length: 30
        }, () => fauxAssistantMessage('internal silence'))], [], [], 32, undefined, true);
    try {
        const bot = h.runtime.createBot('coordinator');
        const original = h.runtime.accept({
            to: bot.id, text: 'Prepare red draft', key: 'original', taskId: 'draft'
        });
        await started.promise;
        for (let i = 0; i < 12; i++)
            h.runtime.accept({
                from: 'group:design', kind: 'bot', to: bot.id, text: `irrelevant chatter ${i}`, key: `chatter-${i}`, taskId: `noise-${i}`
            });
        assert.equal(providerSignal?.aborted, false, 'untrusted chatter cannot preempt');
        const corrected = h.runtime.accept({
            to: bot.id, text: 'Cancel red. Use blue.', key: 'correction', taskId: 'draft', replyTo: original.id
        });
        await until(() => providerSignal?.aborted === true);
        await h.runtime.idle();
        const out = h.runtime.store.list<Outbound>('outbox');
        // Custom scripted fixture: measures routing/ledger behavior, NOT model judgment.
        const score = {
            validTaskCompletion: out.filter(o => o.text === 'Corrected: blue' && o.taskId === 'draft').length,
            missedCommitments: out.some(o => o.text === 'Corrected: blue') ? 0 : 1,
            duplicateActions: Math.max(0, out.length - 1),
            wrongRecipients: out.filter(o => o.botId !== bot.id || o.replyTo !== corrected.id).length,
            obsoleteActions: out.filter(o => /red/i.test(o.text)).length,
            appropriateSilence: out.every(o => o.taskId === 'draft')
        };
        assert.deepEqual(score, {
            validTaskCompletion: 1, missedCommitments: 0, duplicateActions: 0, wrongRecipients: 0, obsoleteActions: 0, appropriateSilence: true
        });
        assert.match(transcript, /Cancel red/);
        assert.match(transcript, /irrelevant chatter 11/);
        assert.equal(h.runtime.store.list<Envelope>('inbox').filter(e => e.state === 'processed').length, 14);
        assert.equal(h.runtime.errors.length, 0);
    }
    finally {
        await h.close();
    }
});
test('behavior fixture: correction aborts provider while started native job survives', async () => {
    const gate = deferred(), inferenceStarted = deferred();
    let toolSignal: AbortSignal | undefined;
    let effects = 0;
    const tool: ToolDefinition = {
        name: 'held_job', label: 'Held job', description: 'Synthetic isolated job', parameters: Type.Object({}),
        async execute(_id, _args, signal) {
            toolSignal = signal;
            await gate.promise;
            effects++;
            return {
                content: [{
                        type: 'text', text: 'SYNTHETIC_COMPLETE'
                    }], details: {}
            };
        }
    };
    const h = await setup([
        fauxAssistantMessage(fauxToolCall('start_job', {
            tool: 'held_job', args: {}, key: 'one-job'
        }, {
            id: 'dispatch-held'
        }), {
            stopReason: 'toolUse'
        }),
        async (_ctx, options) => {
            inferenceStarted.resolve();
            await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), {
                once: true
            }));
            return fauxAssistantMessage([], {
                stopReason: 'aborted'
            });
        }, fauxAssistantMessage('cancelled future plan; already started job remains'), fauxAssistantMessage('job completion observed')
    ], [tool], [], 16, undefined, true);
    try {
        const bot = h.runtime.createBot('worker');
        h.runtime.accept({
            to: bot.id, text: 'start isolated job then plan followup', key: 'start', taskId: 'task'
        });
        await inferenceStarted.promise;
        h.runtime.accept({
            to: bot.id, text: 'Cancel only future followup.', key: 'cancel', taskId: 'task'
        });
        await until(() => h.faux.state.callCount === 3);
        assert.equal(toolSignal?.aborted, false);
        assert.equal(h.runtime.store.list<Job>('jobs')[0]?.state, 'running');
        gate.resolve();
        await h.runtime.idle();
        assert.equal(toolSignal?.aborted, false);
        assert.equal(effects, 1);
        assert.equal(h.runtime.store.list<Job>('jobs')[0]?.state, 'completed');
        assert.equal(h.runtime.errors.length, 0);
    }
    finally {
        gate.resolve();
        await h.close();
    }
});
test('behavior fixture: interleaved tasks and teammate handoff retain explicit source correlation', async () => {
    const started = deferred(), release = deferred();
    let first: Envelope, second: Envelope;
    let teammate = '';
    const h = await setup([
        async () => {
            started.resolve();
            await release.promise;
            return fauxAssistantMessage('internal');
        },
        () => fauxAssistantMessage([
            fauxToolCall('send_to_bot', {
                bot_id: teammate, text: 'finish task A', key: 'handoff-a', source_message_id: first.id
            }, {
                id: 'handoff'
            }),
            fauxToolCall('send_message', {
                text: 'task B finished', key: 'finish-b', source_message_id: second.id
            }, {
                id: 'finish-b'
            })
        ], {
            stopReason: 'toolUse'
        }),
        ...Array.from({
            length: 8
        }, () => fauxAssistantMessage('internal silence'))
    ]);
    try {
        const a = h.runtime.createBot('coordinator'), b = h.runtime.createBot('teammate');
        teammate = b.id;
        first = h.runtime.accept({
            from: 'conversation:A', to: a.id, text: 'task A', key: 'a', taskId: 'task-a'
        });
        await started.promise;
        second = h.runtime.accept({
            from: 'conversation:B', to: a.id, text: 'task B', key: 'b', taskId: 'task-b'
        });
        release.resolve();
        await h.runtime.idle();
        const handoff = h.runtime.store.list<Envelope>('inbox').find(e => e.key === 'handoff-a');
        assert.equal(handoff?.taskId, first.taskId);
        assert.equal(handoff?.replyTo, first.id);
        assert.equal(handoff?.to, b.id);
        assert.equal(handoff?.state, 'processed');
        const out = h.runtime.store.list<Outbound>('outbox');
        assert.equal(out.length, 1);
        assert.equal(out[0]?.taskId, second.taskId);
        assert.equal(out[0]?.replyTo, second.id);
        assert.equal(h.runtime.errors.length, 0);
    }
    finally {
        release.resolve();
        await h.close();
    }
});
test('native ordinary tool batch: input during dispatched hook preserves batch signal and matching results', async () => {
    const started = deferred(), release = deferred();
    let requestSignal: AbortSignal | undefined;
    let calls = 0;
    let context = '';
    const h = await setup([
        (_ctx, options) => {
            requestSignal = options?.signal;
            return fauxAssistantMessage([
                fauxToolCall('list_bots', {}, {
                    id: 'ordinary-one'
                }),
                fauxToolCall('list_bots', {}, {
                    id: 'ordinary-two'
                })
            ], {
                stopReason: 'toolUse'
            });
        },
        ctx => {
            context = JSON.stringify(ctx);
            return fauxAssistantMessage('internal');
        }
    ], [], [pi => {
            pi.on('tool_call', async (event) => {
                if (event.toolName === 'list_bots') {
                    calls++;
                    if (calls === 1) {
                        started.resolve();
                        await release.promise;
                    }
                }
            });
        }], 16, undefined, true);
    try {
        const b = h.runtime.createBot('native-batch');
        h.runtime.accept({
            to: b.id, text: 'start ordinary batch', key: 'batch'
        });
        await started.promise;
        h.runtime.accept({
            to: b.id, text: 'new task during ordinary tool', key: 'during-tool'
        });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(requestSignal?.aborted, false, 'provider is settled; root tool signal remains intact');
        release.resolve();
        await h.runtime.idle();
        assert.equal(calls, 2);
        assert.match(context, /ordinary-one/);
        assert.match(context, /ordinary-two/);
        assert.match(context, /new task during ordinary tool/);
        assert.equal(h.runtime.errors.length, 0);
    }
    finally {
        release.resolve();
        await h.close();
    }
});
test('sustained input: bounded preemptions allow inference progress and consume all late events', async () => {
    let calls = 0;
    let interrupted = 0;
    const requestStarted = async (n: number) => until(() => calls >= n);
    const h = await setup(Array.from({
        length: 12
    }, () => async (_ctx, options) => {
        calls++;
        await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 60);
            options?.signal?.addEventListener('abort', () => {
                interrupted++;
                clearTimeout(timer);
                resolve();
            }, {
                once: true
            });
        });
        return options?.signal?.aborted ? fauxAssistantMessage([], {
            stopReason: 'aborted'
        }) : fauxAssistantMessage('progress');
    }), [], [], 16, undefined, true);
    try {
        const b = h.runtime.createBot('fairness');
        h.runtime.accept({
            to: b.id, text: 'initial', key: 'first'
        });
        for (let n = 1; n <= 4; n++) {
            await requestStarted(n);
            for (let i = 0; i < 5; i++)
                h.runtime.accept({
                    to: b.id, text: `sustained-${n}-${i}`, key: `f-${n}-${i}`
                });
        }
        await h.runtime.idle();
        assert.equal(interrupted, 3, 'default cap prevents indefinite inference cancellation');
        assert.equal(h.runtime.store.list<Envelope>('inbox').filter(e => e.state === 'processed').length, 21);
        assert.equal(h.runtime.errors.length, 0);
    }
    finally {
        await h.close();
    }
});
test('provider errors: synthetic secret diagnostic is absent from inbox errors and native transcript', async () => {
    const diagnostic = 'SYNTHETIC-SECRET-DIAGNOSTIC-NOT-A-REAL-KEY';
    const h = await setup([fauxAssistantMessage(diagnostic, {
            stopReason: 'error', errorMessage: diagnostic
        })]);
    try {
        const bot = h.runtime.createBot('redaction');
        h.runtime.accept({
            to: bot.id, text: 'safe input', key: 'safe'
        });
        await h.runtime.idle();
        assert.ok(h.runtime.errors.length > 0);
        assert.doesNotMatch(JSON.stringify(h.runtime.store.list<Envelope>('inbox')), /SYNTHETIC-SECRET/);
        assert.doesNotMatch(h.runtime.errors.map(String).join('\n'), /SYNTHETIC-SECRET/);
        const { readFile } = await import('node:fs/promises');
        assert.doesNotMatch(await readFile(h.runtime.listBots()[0]!.sessionFile!, 'utf8'), /SYNTHETIC-SECRET/);
    }
    finally {
        await h.close();
    }
});
test('compaction under flood: prefix summary survives inference preempt and preserves late correction', async () => {
    const first = deferred(), releaseFirst = deferred(), second = deferred(), releaseSecond = deferred();
    let finishSummary!: (value: string) => void;
    const summary = new Promise<string>(r => finishSummary = r);
    let snapshot: import('../src/context.ts').SummarySnapshot | undefined;
    let finalContext = '';
    const h = await setup([
        async () => {
            first.resolve();
            await releaseFirst.promise;
            return fauxAssistantMessage(fauxToolCall('list_bots', {}, {
                id: 'flood-boundary'
            }), {
                stopReason: 'toolUse'
            });
        },
        async () => {
            second.resolve();
            await releaseSecond.promise;
            return fauxAssistantMessage('interrupted');
        },
        ctx => {
            finalContext = JSON.stringify(ctx);
            return fauxAssistantMessage('internal');
        }
    ], [], [], 16, {
        maxContextTokens: 100000, outputReserveTokens: 4096, thresholdTokens: 1000, recentMessages: 2, summarize: async (s) => {
            snapshot = s;
            return summary;
        }
    }, true);
    try {
        const b = h.runtime.createBot('compaction-flood');
        h.runtime.accept({
            to: b.id, text: 'KEEP ORIGINAL COMMITMENT', key: 'original'
        });
        await first.promise;
        for (let i = 0; i < 8; i++)
            h.runtime.accept({
                from: 'ambient', kind: 'bot', to: b.id, text: `FLOOD PREFIX ${i}`, key: `prefix-${i}`
            });
        releaseFirst.resolve();
        await second.promise;
        await until(() => !!snapshot);
        const correction = h.runtime.accept({
            to: b.id, text: 'LATE_CORRECTION_KEEP_BLUE', key: 'late'
        });
        assert.equal(snapshot!.signal.aborted, false, 'new input does not cancel background summary');
        assert.doesNotMatch(JSON.stringify(snapshot!.messages), /LATE_CORRECTION/);
        finishSummary('PRESERVED_PREFIX_COMMITMENT');
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        releaseSecond.resolve();
        await h.runtime.idle();
        assert.match(finalContext, /LATE_CORRECTION_KEEP_BLUE/);
        assert.match(finalContext, /PRESERVED_PREFIX_COMMITMENT/);
        assert.equal(h.runtime.store.get<Envelope>('inbox', correction.id)?.state, 'processed');
        assert.equal(h.runtime.errors.length, 0);
        const { readFile } = await import('node:fs/promises');
        assert.match(await readFile(h.runtime.listBots()[0]!.sessionFile!, 'utf8'), /"type":"compaction"/);
    }
    finally {
        finishSummary('PRESERVED_PREFIX_COMMITMENT');
        releaseFirst.resolve();
        releaseSecond.resolve();
        await h.close();
    }
});
test('provider deadline: reports timeout without retry or cancelling native tool lifetime', async () => {
    let timedOut = 0;
    const h = await setup([async (_ctx, options) => {
            await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), {
                once: true
            }));
            return fauxAssistantMessage([], {
                stopReason: 'aborted'
            });
        }], [], [], 16, undefined, true, {
        inferenceRequestTimeoutMs: 20, onInferenceTimeout: () => {
            timedOut++;
        }
    });
    try {
        const bot = h.runtime.createBot('deadline');
        const event = h.runtime.accept({
            to: bot.id, text: 'held synthetic request', key: 'deadline'
        });
        await h.runtime.idle();
        assert.equal(timedOut, 1);
        assert.equal(h.faux.state.callCount, 1);
        assert.equal(h.runtime.store.get<Envelope>('inbox', event.id)?.state, 'uncertain');
        assert.ok(h.runtime.errors.length > 0);
    }
    finally {
        await h.close();
    }
});
