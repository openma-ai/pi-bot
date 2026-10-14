import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import { ModelRuntime, type ToolDefinition, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { piSessionFactory } from '../src/pi/session-factory.ts';
import type { Envelope, Job, Outbound } from '../src/daemon/runtime/store.ts';
import { RequestBroker } from '../src/daemon/requests/request-broker.ts';
for (const variant of ['reply', 'nested', 'cancel', 'peer', 'approval'])
    test(`background cell uses durable bot jobs/inbox: ${variant}`, {
        timeout: 15000
    }, async () => {
        const cancel = variant === 'cancel', nestedReply = variant === 'nested';
        const base = resolve('work/background-bot-tests');
        await mkdir(base, {
            recursive: true
        });
        const dir = await mkdtemp(join(base, 'case-'));
        let release!: () => void;
        const held = new Promise<void>(r => release = r);
        let started = 0, echoed = 0;
        let signal: AbortSignal | undefined;
        let source = '';
        const contexts: string[] = [];
        const gate: ToolDefinition = {
            name: 'gate', label: 'Gate', description: 'Hold', parameters: Type.Object({}), async execute(_id, _p, s) {
                started++;
                signal = s;
                await held;
                return {
                    content: [{
                            type: 'text', text: 'VALUE'
                        }], details: {}
                };
            }
        };
        const echo: ToolDefinition = {
            name: 'echo', label: 'Echo', description: 'Echo', parameters: Type.Object({}), async execute(_id, _p, _s, _u, ctx) {
                echoed++;
                if (nestedReply)
                    return (await ctx.executeTool('send_message', {
                        text: 'FINISHED', key: 'nested-final'
                    })).result;
                return {
                    content: [{
                            type: 'text', text: 'FINISHED'
                        }], details: {}
                };
            }
        };
        const faux = fauxProvider({
            provider: `bg-bot-${cancel}`, models: [{
                    id: 'test', contextWindow: 128000, maxTokens: 4096
                }], tokensPerSecond: 1000000
        });
        faux.setResponses([() => fauxAssistantMessage(fauxToolCall('codemode', {
                code: `// @source: ${source}\nawait tools.gate({});text(await tools.echo({}));`
            }, {
                id: 'code'
            }), {
                stopReason: 'toolUse'
            }), ...Array.from({
                length: 20
            }, () => (ctx: any) => {
                contexts.push(JSON.stringify(ctx.messages));
                if (!cancel && !nestedReply && !runtime.store.list<Outbound>('outbox').length && runtime.store.list<Job>('jobs').some(j => j.state === 'completed') && JSON.stringify(ctx.messages).includes('job:'))
                    return fauxAssistantMessage(fauxToolCall('send_message', {
                        text: 'FINISHED', key: 'final', source_message_id: source
                    }, {
                        id: 'final'
                    }), {
                        stopReason: 'toolUse'
                    });
                return fauxAssistantMessage('internal');
            })]);
        const models = await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
        });
        const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
            dir, modelRuntime: models, model: faux.getModel(), tools: [gate, echo], allowTools: ['gate', 'echo'], extensions: [(pi: ExtensionAPI) => pi.registerProvider(faux.provider)], preemptInference: false, backgroundTools: {
                directory: join(dir, 'executions'), yieldTimeMs: 10000
            }
        }));
        const broker = variant === 'approval' ? new RequestBroker(runtime, new Map()) : undefined;
        if (broker) runtime.approvals = { request: input => broker.approval(input) };
        let approving: ReturnType<typeof setInterval> | undefined;
        const until = async (f: () => boolean) => {
            const end = Date.now() + 3000;
            while (!f()) {
                if (Date.now() > end)
                    return false;
                await new Promise(r => setTimeout(r, 5));
            }
            return true;
        };
        try {
            const bot = runtime.createBot('bg', 'Handle tasks', 'alpha');
            const route = {
                channelId: 'alpha', threadId: 'work', senderId: 'alice'
            };
            const parent: Envelope = {
                id: 'peer-parent', to: bot.id, from: 'alice', kind: 'user', taskId: 'work', route, text: 'complete work', key: 'parent', state: 'processed', replyTo: null, hop: 0, createdAt: Date.now()
            };
            if (variant === 'peer')
                runtime.store.put('inbox', parent);
            source = runtime.accept({
                to: bot.id, from: variant === 'peer' ? 'schedule:host' : 'alice', kind: variant === 'peer' ? 'schedule' : 'user', taskId: 'work', route, text: 'complete work', key: 'work', ...(variant === 'peer' ? {
                    replyTo: parent.id
                } : {})
            }).id;
            assert.equal(await until(() => broker ? broker.list().some(r => r.status === 'pending') : started === 1), true, 'execution must reach its scoped wait');
            if (variant === 'peer')
                runtime.sendToBot(parent, bot.id, 'Priority observation only; no reply', 'late', {
                    priority: true
                });
            else
                runtime.accept({
                    to: bot.id, from: cancel ? 'alice' : 'bob', kind: 'user', taskId: cancel ? 'work' : 'noise', route: cancel ? route : {
                        channelId: 'alpha', threadId: 'lounge', senderId: 'bob'
                    }, taskControl: cancel ? 'cancel' : undefined, text: cancel ? 'cancel work' : 'Incidental chatter, no reply', key: 'late'
                });
            assert.equal(await until(() => contexts.some(s => s.includes('Script running with cell ID'))), true);
            if (broker) {
                assert.equal(await until(() => contexts.some(s => s.includes('Incidental chatter, no reply'))), true, 'same bot must consume B while A is awaiting approval');
                assert.equal(started, 0, 'approval must gate native effects');
                approving = setInterval(() => {
                    for (const request of broker.list()) if (request.status === 'pending')
                        broker.resolve(request.id, { decision: 'approve' }, 'isolated-test');
                }, 5);
                assert.equal(await until(() => started === 1), true);
            }
            assert.equal(signal?.aborted, false);
            assert.equal(runtime.store.list<Job>('jobs').length, 1);
            assert.equal(runtime.store.list<Job>('jobs')[0].state, 'running');
            release();
            await runtime.idle();
            assert.equal(started, 1);
            assert.equal(echoed, cancel ? 0 : 1);
            assert.equal(runtime.store.list<Envelope>('inbox').filter(e => e.kind === 'job').length, 1);
            assert.equal(runtime.store.list<Job>('jobs')[0].state, cancel ? 'failed' : 'completed');
            assert.equal(runtime.errors.length, 0);
            const out = runtime.store.list<Outbound>('outbox');
            assert.equal(out.length, cancel ? 0 : 1);
            if (!cancel)
                assert.deepEqual(out[0].route, route);
        }
        finally {
            if (approving) clearInterval(approving);
            broker?.close();
            release();
            await runtime.close();
            await rm(dir, {
                recursive: true, force: true
            });
        }
    });
test('fast bot codemode returns its final result despite its own job completion inbox event', async () => {
    const base = resolve('work/background-bot-tests');
    await mkdir(base, {
        recursive: true
    });
    const dir = await mkdtemp(join(base, 'fast-'));
    const faux = fauxProvider({
        provider: 'bg-bot-fast', models: [{
                id: 'test', contextWindow: 128000, maxTokens: 4096
            }], tokensPerSecond: 1000000
    });
    let source = '';
    const toolResults: any[] = [];
    faux.setResponses([() => fauxAssistantMessage(fauxToolCall('codemode', {
            code: 'text("FAST_FINAL");', source_message_id: source
        }, {
            id: 'fast-code'
        }), {
            stopReason: 'toolUse'
        }), ...Array.from({
            length: 10
        }, () => fauxAssistantMessage('internal'))]);
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
        dir, modelRuntime: models, model: faux.getModel(), extensions: [pi => {
                pi.registerProvider(faux.provider);
                pi.on('tool_result', e => {
                    toolResults.push(e);
                });
            }], backgroundTools: {
            additionalTools: [], yieldTimeMs: 10000
        }
    }));
    try {
        const bot = runtime.createBot('fast');
        source = runtime.accept({
            to: bot.id, text: 'fast', key: 'fast'
        }).id;
        await runtime.idle();
        const output = toolResults.find(e => e.toolCallId === 'fast-code');
        assert.ok(JSON.stringify(output.content).includes('Script completed'), JSON.stringify(output.content));
        assert.equal(output.details.state, 'completed');
    }
    finally {
        await runtime.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
