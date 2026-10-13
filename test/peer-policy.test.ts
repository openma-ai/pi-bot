import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from '../src/daemon/runtime.ts';
import { piSessionFactory } from '../src/pi/session-factory.ts';
import type { Envelope } from '../src/daemon/store.ts';
for (const variant of ['ordinary-background', 'priority-background', 'priority-user', 'priority-group'] as const)
    test(`Pi peer queue/steer policy: ${variant}`, {
        timeout: 10000
    }, async () => {
        await mkdir(resolve('work/proactive-tests'), {
            recursive: true
        });
        const dir = await mkdtemp(resolve('work/proactive-tests/peer-'));
        let release!: () => void, started!: () => void;
        const gate = new Promise<void>(r => release = r);
        const running = new Promise<void>(r => started = r);
        const contexts: string[] = [];
        const faux = fauxProvider({
            provider: `peer-${variant}`, models: [{
                    id: 'test', contextWindow: 128000, maxTokens: 4096
                }], tokensPerSecond: 1000000
        });
        faux.setResponses([async () => {
                started();
                await gate;
                return fauxAssistantMessage('OLD_SAMPLING');
            }, ...Array.from({
                length: 10
            }, () => (ctx: any) => {
                contexts.push(JSON.stringify(ctx.messages));
                return fauxAssistantMessage('SAFE_CONTINUATION');
            })]);
        const models = await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
        });
        const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
            dir, modelRuntime: models, model: faux.getModel(), extensions: [pi => pi.registerProvider(faux.provider)]
        }));
        try {
            const recipient = runtime.createBot('recipient', '', 'alpha'), sender = runtime.createBot('sender', '', 'alpha');
            const origin: Envelope = {
                id: randomUUID(), from: 'alice', to: sender.id, kind: 'user', text: 'Authorized same-group task', taskId: 'scope', replyTo: null, hop: 0, key: 'origin', state: 'processed', createdAt: Date.now(), route: {
                    channelId: 'alpha', threadId: 'thread-a', senderId: 'alice'
                }
            };
            runtime.store.put('inbox', origin);
            const working = runtime.accept({
                to: recipient.id, from: variant === 'priority-user' ? 'alice' : 'schedule:host', kind: variant === 'priority-user' ? 'user' : 'schedule', taskId: origin.taskId, replyTo: origin.id, route: origin.route, text: 'active work', key: 'working'
            });
            await running;
            const priority = variant !== 'ordinary-background';
            const peer = variant === 'priority-group' ? runtime.sendToGroup(origin, 'PEER_UPDATE', 'peer', true).find(e => e.to === recipient.id)! : runtime.sendToBot(origin, recipient.id, 'PEER_UPDATE', 'peer', {
                priority
            });
            await new Promise(r => setImmediate(r));
            assert.equal(runtime.store.get<Envelope>('inbox', peer.id)?.state, variant === 'priority-background' ? 'processing' : 'queued');
            assert.equal(peer.deliveryTarget, variant === 'priority-group' ? 'group' : 'direct');
            release();
            await runtime.idle();
            assert.ok(contexts.some(c => c.includes('PEER_UPDATE')));
            const transcript = await readFile(runtime.listBots().find(b => b.id === recipient.id)!.sessionFile!, 'utf8');
            assert.equal(transcript.includes('"stopReason":"aborted"'), false, 'priority peer never preempts sampling');
            assert.equal(runtime.errors.length, 0);
            assert.equal(runtime.store.get<Envelope>('inbox', working.id)?.state, 'processed');
        }
        finally {
            release();
            await runtime.close();
            await rm(dir, {
                recursive: true, force: true
            });
        }
    });
test('priority steer during an ordinary tool batch preserves both call/result pairs', {
    timeout: 10000
}, async () => {
    await mkdir(resolve('work/proactive-tests'), {
        recursive: true
    });
    const dir = await mkdtemp(resolve('work/proactive-tests/peer-tools-'));
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => release = r), running = new Promise<void>(r => started = r);
    let workingId = '', foregroundSignal: AbortSignal | undefined, nextContext = '';
    const faux = fauxProvider({
        provider: 'peer-tools', models: [{
                id: 'test', contextWindow: 128000, maxTokens: 4096
            }], tokensPerSecond: 1000000
    });
    faux.setResponses([(_ctx, options) => {
            foregroundSignal = options?.signal;
            return fauxAssistantMessage([fauxToolCall('send_message', {
                    text: 'ONE', key: 'one', source_message_id: workingId
                }, {
                    id: 'one'
                }), fauxToolCall('send_message', {
                    text: 'TWO', key: 'two', source_message_id: workingId
                }, {
                    id: 'two'
                })], {
                stopReason: 'toolUse'
            });
        }, (ctx: any) => {
            nextContext = JSON.stringify(ctx.messages);
            return fauxAssistantMessage('internal');
        }]);
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
        dir, modelRuntime: models, model: faux.getModel(), extensions: [pi => pi.registerProvider(faux.provider), pi => {
                pi.on('tool_call', async (event) => {
                    if (event.toolCallId === 'one') {
                        started();
                        await gate;
                    }
                });
            }]
    }));
    try {
        const bot = runtime.createBot('worker', '', 'alpha'), sender = runtime.createBot('sender', '', 'alpha');
        const origin: Envelope = {
            id: randomUUID(), to: sender.id, from: 'alice', kind: 'user', text: 'Send two results', key: 'root', taskId: 'task', hop: 0, replyTo: null, state: 'processed', createdAt: Date.now(), route: {
                channelId: 'alpha', threadId: 'thread', senderId: 'alice'
            }
        };
        runtime.store.put('inbox', origin);
        workingId = runtime.accept({
            to: bot.id, from: 'schedule:host', kind: 'schedule', text: 'Execute original delivery', key: 'work', taskId: origin.taskId, replyTo: origin.id, route: origin.route
        }).id;
        await running;
        runtime.sendToBot(origin, bot.id, 'PRIORITY_OBSERVATION', 'priority', {
            priority: true
        });
        await new Promise(r => setImmediate(r));
        assert.equal(foregroundSignal?.aborted, false);
        release();
        await runtime.idle();
        assert.match(nextContext, /PRIORITY_OBSERVATION/);
        assert.equal(runtime.store.list('outbox').length, 2);
        assert.equal(runtime.errors.length, 0);
        const file = runtime.listBots().find(b => b.id === bot.id)!.sessionFile!;
        const entries = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(entries.filter(e => e.message?.role === 'toolResult').map(e => e.message.toolCallId).sort(), ['one', 'two']);
    }
    finally {
        release();
        await runtime.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
