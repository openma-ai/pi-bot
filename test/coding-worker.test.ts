import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runCodingWorker } from '../src/coding-worker.ts';
test('isolated native coding worker executes write/read and shares request budget', async () => {
    mkdirSync('work/worker-tests', {
        recursive: true
    });
    const dir = mkdtempSync(resolve('work/worker-tests/case-'));
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false
    });
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage(fauxToolCall('write', {
            path: 'result.txt', content: '73'
        })), fauxAssistantMessage(fauxToolCall('read', {
            path: 'result.txt'
        })), fauxAssistantMessage('Verified 73')]);
    models.registerNativeProvider(faux.provider);
    let requests = 0, checks = 0;
    const result = await runCodingWorker({
        dir, modelRuntime: models, model: faux.getModel(), beforeProviderRequest() {
            requests++;
        }, assertCurrent() {
            checks++;
        }
    }, 'Write and verify result', {
        taskId: 't', text: 'write result'
    });
    assert.equal(readFileSync(join(dir, 'result.txt'), 'utf8'), '73');
    assert.equal(result.text, 'Verified 73');
    assert.equal(requests, 3);
    assert.ok(checks >= 2);
    assert.ok(result.sessionFile?.startsWith(dir));
});
test('coding worker refuses tools after task invalidation', async () => {
    const dir = mkdtempSync(resolve('work/worker-tests/case-'));
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false
    });
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage(fauxToolCall('write', {
            path: 'stale.txt', content: 'stale'
        })), fauxAssistantMessage('failed')]);
    models.registerNativeProvider(faux.provider);
    let valid = true;
    await assert.rejects(runCodingWorker({
        dir, modelRuntime: models, model: faux.getModel(), beforeProviderRequest() {
            valid = false;
        }, assertCurrent() {
            if (!valid)
                throw Error('Task obsolete');
        }
    }, 'write stale', {
        taskId: 't'
    }), /obsolete/);
    assert.equal(existsSync(join(dir, 'stale.txt')), false);
});
import { BotRuntime } from '../src/runtime.ts';
import { piSessionFactory } from '../src/pi.ts';
import type { Job } from '../src/store.ts';
test('bot subagent returns durable receipt, completes isolated coding job and deduplicates dispatch', async () => {
    const dir = mkdtempSync(resolve('work/worker-tests/case-'));
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false
    });
    const faux = fauxProvider();
    const response = (context: any) => {
        if (JSON.stringify(context).includes('isolated Pi coding worker'))
            return context.messages.some((m: any) => m.role === 'toolResult') ? fauxAssistantMessage('Written 73') : fauxAssistantMessage(fauxToolCall('write', {
                path: 'heavy.txt', content: '73'
            }), {
                stopReason: 'toolUse'
            });
        if (context.messages.some((m: any) => m.role === 'toolResult'))
            return fauxAssistantMessage('Waiting for worker');
        return fauxAssistantMessage([fauxToolCall('subagent', {
                task: 'Write heavy.txt with 73', key: 'heavy-once'
            }, {
                id: 'dispatch1'
            }), fauxToolCall('subagent', {
                task: 'Write heavy.txt with 73', key: 'heavy-once'
            }, {
                id: 'dispatch2'
            })], {
            stopReason: 'toolUse'
        });
    };
    faux.setResponses(Array(20).fill(response));
    models.registerNativeProvider(faux.provider);
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
        dir: join(dir, 'sessions'), modelRuntime: models, model: faux.getModel(), codingWorkers: true
    }));
    try {
        const bot = runtime.createBot('owner', 'Handle tasks');
        runtime.accept({
            to: bot.id, from: 'user', kind: 'user', text: 'Write heavy.txt with 73', key: 'request'
        });
        await runtime.idle();
        const jobs = runtime.store.list<Job>('jobs').filter(j => j.tool === 'pi-coding-agent');
        assert.equal(jobs.length, 1, JSON.stringify(runtime.errors.map(e => String(e))));
        assert.equal(jobs[0].state, 'completed');
        assert.ok(runtime.jobResult(bot.id, jobs[0].id)?.text?.includes('Written 73'));
        assert.equal(runtime.errors.length, 0);
    }
    finally {
        await runtime.close();
    }
});
test('parent bot answers a new user while its independent worker is still running', {
    timeout: 10000
}, async () => {
    const dir = mkdtempSync(resolve('work/worker-tests/case-'));
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false
    });
    const faux = fauxProvider();
    let release!: () => void, started!: () => void, answered!: () => void;
    const held = new Promise<void>(r => release = r), running = new Promise<void>(r => started = r), pong = new Promise<void>(r => answered = r);
    let dispatched = false, ping = false, pingId = "";
    const response = async (context: any) => {
        const text = JSON.stringify(context);
        if (text.includes('isolated Pi coding worker')) {
            started();
            await held;
            return fauxAssistantMessage('Heavy result');
        }
        if (text.includes('PING-NOW') && !ping) {
            ping = true;
            return fauxAssistantMessage(fauxToolCall('send_message', {
                text: 'PONG-NOW', key: 'pong', source_message_id: pingId
            }), {
                stopReason: 'toolUse'
            });
        }
        if (ping) {
            answered();
            return fauxAssistantMessage('internal');
        }
        if (!dispatched) {
            dispatched = true;
            return fauxAssistantMessage(fauxToolCall('subagent', {
                task: 'Heavy work', key: 'heavy'
            }), {
                stopReason: 'toolUse'
            });
        }
        return fauxAssistantMessage('Waiting');
    };
    faux.setResponses(Array(20).fill(response));
    models.registerNativeProvider(faux.provider);
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
        dir: join(dir, 'sessions'), modelRuntime: models, model: faux.getModel(), codingWorkers: true
    }));
    try {
        const bot = runtime.createBot('owner', 'Handle tasks');
        runtime.accept({
            to: bot.id, from: 'user', kind: 'user', text: 'Heavy work', key: 'heavy-request'
        });
        await running;
        pingId = runtime.accept({
            to: bot.id, from: 'user', kind: 'user', text: 'PING-NOW', key: 'ping-request'
        }).id;
        await pong;
        assert.equal(runtime.store.list<Job>('jobs')[0].state, 'running');
        assert.ok(runtime.store.list<any>('outbox').some(o => o.text === 'PONG-NOW'));
        release();
        await runtime.idle();
        assert.equal(runtime.store.list<Job>('jobs')[0].state, 'completed');
    }
    finally {
        release();
        await runtime.close();
    }
});
