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
async function setup(steps: FauxResponseStep[], tools: ToolDefinition[] = [], extensions: ExtensionFactory[] = [], maxRequestsPerWake = 16, context?: PiOptions['context']) {
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
        dir: join(dir, 'sessions'), modelRuntime, model: faux.getModel(), tools, extensions: [pi => pi.registerProvider(faux.provider), ...extensions], allowTools: tools.map(t => t.name), maxRequestsPerWake, context
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
    const h = await setup([fauxAssistantMessage('must not run')], [], [], 16, { maxContextTokens: 32000 });
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
