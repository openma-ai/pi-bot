import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureSmokeProvider, SMOKE_PROVIDER } from '../src/evals/smoke-provider.ts';
test('official Flash wire: fixed endpoint, explicit thinking mode and bounded output; fetch is mocked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-smoke-wire-'));
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    try {
        const model = configureSmokeProvider(runtime, 'deepseek-v4-flash');
        await runtime.setRuntimeApiKey(SMOKE_PROVIDER, 'SYNTHETIC-NOT-A-REAL-KEY');
        let url = '';
        let payload: any;
        let requests = 0;
        const reply = await runtime.completeSimple(model, {
            messages: [{
                    role: 'user', content: 'synthetic fixture', timestamp: 0
                }]
        }, {
            maxTokens: 16384, maxRetries: 0, fetch: async (input, init) => {
                requests++;
                url = String(input);
                payload = JSON.parse(String(init?.body));
                const chunk = {
                    id: 'fixture', object: 'chat.completion.chunk', created: 0, model: model.id, choices: [{
                            index: 0, delta: {
                                role: 'assistant', content: 'fixture complete'
                            }, finish_reason: 'stop'
                        }]
                };
                return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                    headers: {
                        'content-type': 'text/event-stream'
                    }
                });
            }
        });
        assert.equal(reply.stopReason, 'stop');
        assert.equal(requests, 1);
        assert.equal(url, 'https://api.deepseek.com/chat/completions');
        assert.equal(payload.model, 'deepseek-v4-flash');
        assert.equal(payload.reasoning_effort, 'high');
        assert.deepEqual(payload.thinking, {
            type: 'enabled'
        });
        assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 16384);
        assert.throws(() => configureSmokeProvider(runtime, 'deepseek-v4-pro'), /Only reviewed/);
    }
    finally {
        await runtime.removeRuntimeApiKey(SMOKE_PROVIDER);
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('thinking wire: streamed reasoning survives two sequential tool calls and later user turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-thinking-replay-'));
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    try {
        const model = configureSmokeProvider(runtime, 'deepseek-v4-flash');
        await runtime.setRuntimeApiKey(SMOKE_PROVIDER, 'SYNTHETIC-NOT-A-REAL-KEY');
        const messages: any[] = [{
                role: 'user', content: 'Synthetic two-step task', timestamp: 0
            }];
        const tools = [{
                name: 'fixture', description: 'Synthetic fixture', parameters: {
                    type: 'object', properties: {}, required: []
                }
            }];
        const payloads: any[] = [];
        const fetch: typeof globalThis.fetch = async (_input, init) => {
            const payload = JSON.parse(String(init?.body));
            payloads.push(payload);
            const index = payloads.length;
            const delta = index <= 2 ? {
                role: 'assistant', reasoning_content: `SYNTHETIC_REASON_${index}`, content: '', tool_calls: [{
                        index: 0, id: `call-${index}`, type: 'function', function: {
                            name: 'fixture', arguments: '{}'
                        }
                    }]
            } : {
                role: 'assistant', reasoning_content: `SYNTHETIC_REASON_${index}`, content: 'Synthetic final'
            };
            const chunk = {
                id: `fixture-${index}`, object: 'chat.completion.chunk', created: 0, model: model.id, choices: [{
                        index: 0, delta, finish_reason: index <= 2 ? 'tool_calls' : 'stop'
                    }]
            };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                headers: {
                    'content-type': 'text/event-stream'
                }
            });
        };
        for (let step = 1; step <= 3; step++) {
            const reply = await runtime.completeSimple(model, {
                messages, tools
            }, {
                maxTokens: 16384, reasoning: 'high', maxRetries: 0, fetch
            });
            assert.equal(reply.content.find(part => part.type === 'thinking')?.thinking, `SYNTHETIC_REASON_${step}`);
            messages.push(reply);
            if (step <= 2)
                messages.push({
                    role: 'toolResult', toolCallId: `call-${step}`, toolName: 'fixture', content: [{
                            type: 'text', text: 'Synthetic result'
                        }], isError: false, timestamp: step
                });
        }
        messages.push({
            role: 'user', content: 'New synthetic user turn', timestamp: 4
        });
        await runtime.completeSimple(model, {
            messages, tools
        }, {
            maxTokens: 16384, reasoning: 'high', maxRetries: 0, fetch
        });
        const final = payloads[3];
        const assistant = final.messages.filter((m: any) => m.role === 'assistant');
        assert.deepEqual(assistant.map((m: any) => m.reasoning_content), ['SYNTHETIC_REASON_1', 'SYNTHETIC_REASON_2', 'SYNTHETIC_REASON_3']);
        assert.deepEqual(final.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id), ['call-1', 'call-2']);
        assert.ok(payloads.every(p => p.max_tokens === 16384 && p.thinking.type === 'enabled' && p.reasoning_effort === 'high'));
        assert.equal(final.tools[0].function.name, 'fixture');
    }
    finally {
        await runtime.removeRuntimeApiKey(SMOKE_PROVIDER);
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('native Pi thinking: paired ordinary tools, send_message and next-user replay retain all reasoning', async () => {
    const { BotRuntime } = await import('../src/daemon/runtime.ts');
    const { piSessionFactory } = await import('../src/pi/session-factory.ts');
    const { RequestBudget } = await import('../src/evals/evaluation.ts');
    const { hasValidToolPairs } = await import('../src/pi/context.ts');
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const dir = await mkdtemp(join(tmpdir(), 'pi-native-thinking-'));
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const model = configureSmokeProvider(models, 'deepseek-v4-flash');
    await models.setRuntimeApiKey(SMOKE_PROVIDER, 'SYNTHETIC-NOT-A-REAL-KEY');
    const original = models.streamSimple.bind(models);
    const payloads: any[] = [];
    const budget = new RequestBudget();
    models.streamSimple = (m, ctx, opts) => original(m, ctx, {
        ...opts, fetch: async (_input, init) => {
            const payload = JSON.parse(String(init?.body));
            payloads.push(payload);
            const n = payloads.length;
            const tool = n <= 2 ? {
                index: 0, id: `native-${n}`, type: 'function', function: {
                    name: 'list_bots', arguments: '{}'
                }
            } : n === 3 ? {
                index: 0, id: 'native-send', type: 'function', function: {
                    name: 'send_message', arguments: JSON.stringify({
                        text: 'SYNTHETIC DONE', key: 'thinking-done'
                    })
                }
            } : undefined;
            const chunk = {
                id: `native-${n}`, object: 'chat.completion.chunk', created: 0, model: model.id, choices: [{
                        index: 0, delta: {
                            role: 'assistant', reasoning_content: `NATIVE_REASON_${n}`, content: tool ? '' : 'internal', ...(tool ? {
                                tool_calls: [tool]
                            } : {})
                        }, finish_reason: tool ? 'tool_calls' : 'stop'
                    }]
            };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                headers: {
                    'content-type': 'text/event-stream'
                }
            });
        }
    });
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
        dir: join(dir, 'sessions'), modelRuntime: models, model, thinkingLevel: 'high', maxOutputTokens: 16384, beforeProviderRequest: (ctx, max) => budget.reserve(ctx, max), context: {
            backgroundEnabled: false, maxContextTokens: 256000, outputReserveTokens: 16384
        }
    }));
    try {
        const bot = runtime.createBot('thinking-fixture');
        runtime.accept({
            to: bot.id, text: 'Synthetic tool sequence', key: 'first'
        });
        await runtime.idle();
        runtime.accept({
            to: bot.id, text: 'Synthetic next user turn', key: 'second'
        });
        await runtime.idle();
        assert.equal(payloads.length, 5);
        assert.equal(budget.requests, 5);
        assert.equal(budget.outputReserved, 5 * 16384);
        assert.deepEqual(payloads[4].messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.reasoning_content), ['NATIVE_REASON_1', 'NATIVE_REASON_2', 'NATIVE_REASON_3', 'NATIVE_REASON_4']);
        assert.ok(payloads.every(p => p.max_tokens === 16384 && p.thinking.type === 'enabled' && p.reasoning_effort === 'high'));
        assert.equal(runtime.store.list<any>('outbox')[0]?.text, 'SYNTHETIC DONE');
        assert.equal(runtime.errors.length, 0);
        const manager = SessionManager.open(runtime.listBots()[0]!.sessionFile!, dir);
        assert.equal(hasValidToolPairs(manager.buildSessionProjection().messages), true);
    }
    finally {
        await runtime.close();
        await models.removeRuntimeApiKey(SMOKE_PROVIDER);
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
