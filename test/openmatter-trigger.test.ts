import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { OpenMatterTrigger } from '../src/daemon/runtime/openmatter-trigger.ts';
import type { Envelope } from '../src/daemon/runtime/store.ts';
test('real OpenMatter SQLite leases dedupe handoff and retain a failed activation', async () => {
    await mkdir(resolve('work/trigger-tests'), {
        recursive: true
    });
    const dir = await mkdtemp(resolve('work/trigger-tests/case-'));
    let driver = new OpenMatterTrigger(join(dir, 'triggers.db'));
    const e: Envelope = {
        id: 'e', to: 'a', from: 'user', text: 'task', key: 'k', taskId: 't', kind: 'user', replyTo: null, hop: 0, state: 'queued', createdAt: Date.now()
    };
    let seen = 0;
    try {
        driver.bind(id => {
            assert.equal(id, 'e');
            seen++;
        });
        driver.publish(e);
        driver.publish(e);
        assert.equal(seen, 0);
        driver.flush();
        assert.equal(seen, 1);
        assert.equal(driver.inspect()[0].state, 'completed');
        driver.close();
        driver = new OpenMatterTrigger(join(dir, 'triggers.db'));
        driver.bind(() => seen++);
        driver.publish(e);
        driver.flush();
        assert.equal(seen, 1);
        driver.bind(() => {
            throw Error('native gap');
        });
        driver.publish({
            ...e, id: 'missing', key: 'missing'
        });
        driver.flush();
        assert.equal(driver.halted, true);
        assert.equal(driver.inspect().find(r => r.item.id === 'missing')?.state, 'pending');
        driver.flush();
        assert.equal(driver.inspect().find(r => r.item.id === 'missing')?.item.eventType, 'pi.user');
    }
    finally {
        driver.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
import { Store } from '../src/daemon/runtime/store.ts';
test('host group mentions rank above ordinary group messages without changing bot-peer priority', async () => {
    const dir = await mkdtemp(resolve('work/trigger-tests/priority-'));
    const store = new Store(join(dir, 'runtime.db'));
    const base: Envelope = {
        id: 'ordinary', from: 'user', to: 'a', text: 'group', key: 'k', taskId: 't', kind: 'user', replyTo: null, hop: 0, state: 'queued', createdAt: Date.now(), groupMessageId: 'g1', groupAttention: 'normal', mentions: []
    };
    try {
        store.put('inbox', base);
        store.put('inbox', {
            ...base, id: 'mentioned', key: 'mentioned', groupMessageId: 'g2', groupAttention: 'mention', mentions: ['a']
        });
        assert.equal(store.pending('a')?.id, 'mentioned');
    }
    finally {
        store.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
import { BotRuntime, InferenceYieldError } from '../src/daemon/runtime/runtime.ts';
test('foreign user scope yields inference and resumes group work without replaying its job', async () => {
    const dir = await mkdtemp(resolve('work/trigger-tests/yield-'));
    let interrupt: (e: Error) => void = () => {
    };
    let ready: () => void = () => {
    };
    const started = new Promise<void>(r => ready = r);
    const seen: string[] = [];
    let runs = 0, jobs = 0, finishJob: () => void = () => {
    };
    const runtime = new BotRuntime(join(dir, 'runtime.db'), async (bot, rt) => ({
        async run(e) {
            if (bot.name !== 'A')
                return;
            if (e.route) {
                seen.push('group');
                runs++;
                if (runs === 1) {
                    rt.startJob(e, 'test', {}, 'once', () => new Promise<void>(r => {
                        jobs++;
                        finishJob = r;
                    }));
                    ready();
                    await new Promise<void>((_r, reject) => interrupt = reject);
                }
            }
            else
                seen.push('private');
        }, async enqueue() {
        }, yieldForUser() {
            interrupt(new InferenceYieldError());
        }, async close() {
        }
    }), {
        isolateConversations: true
    });
    try {
        const a = runtime.createBot('A'), b = runtime.createBot('B');
        const group = runtime.createGroup('group', [a.id, b.id]);
        runtime.acceptGroupUser(group.id, 'group task', 'first');
        await started;
        runtime.accept({
            to: a.id, text: 'private task', key: 'second'
        });
        finishJob();
        await runtime.idle();
        assert.deepEqual(seen.slice(0, 3), ['group', 'private', 'group']);
        assert.equal(jobs, 1);
        assert.equal(runtime.errors.length, 0);
    }
    finally {
        await runtime.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage as msg, fauxToolCall as call, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { piSessionFactory } from '../src/pi/session-factory.ts';
test('native Pi aborts only foreign-scope inference, keeps transcripts private, then resumes', {
    timeout: 10000
}, async () => {
    const dir = await mkdtemp(resolve('work/trigger-tests/native-'));
    let start: () => void = () => {
    }, release: () => void = () => {
    };
    const begun = new Promise<void>(r => start = r);
    let signal: AbortSignal | undefined, privateId = '', groupId = '';
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const faux = fauxProvider({
        provider: 'scope-yield', models: [{
                id: 'test', contextWindow: 128000, maxTokens: 2048
            }], tokensPerSecond: 1000000
    });
    faux.setResponses([async (_ctx, opts) => {
            signal = opts?.signal;
            start();
            await new Promise<void>(r => {
                release = r;
                signal?.addEventListener('abort', () => r(), {
                    once: true
                });
            });
            return msg([], {
                stopReason: 'aborted'
            });
        }, ctx => {
            const text = JSON.stringify(ctx);
            assert.ok(text.includes('PRIVATE_ONLY_SENTINEL'));
            assert.ok(!text.includes('GROUP_SHARED_SENTINEL'));
            return msg(call('send_message', {
                text: 'private result', key: 'private', source_message_id: privateId
            }), {
                stopReason: 'toolUse'
            });
        }, msg('done'), ctx => {
            const text = JSON.stringify(ctx);
            assert.ok(text.includes('GROUP_SHARED_SENTINEL'));
            assert.ok(!text.includes('PRIVATE_ONLY_SENTINEL'));
            return msg(call('send_message', {
                text: 'group result', key: 'group', source_message_id: groupId
            }), {
                stopReason: 'toolUse'
            });
        }, msg('done')]);
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
        dir: join(dir, 'sessions'), modelRuntime: models, model: faux.getModel(), extensions: [pi => pi.registerProvider(faux.provider)]
    }), {
        isolateConversations: true
    });
    try {
        const a = runtime.createBot('A'), b = runtime.createBot('B'), group = runtime.createGroup('group', [a.id, b.id]);
        groupId = runtime.accept({
            to: a.id, text: 'GROUP_SHARED_SENTINEL', key: 'group', route: {
                channelId: group.id, threadId: 'gui', senderId: 'user'
            }
        }).id;
        await begun;
        privateId = runtime.accept({
            to: a.id, text: 'PRIVATE_ONLY_SENTINEL', key: 'private'
        }).id;
        await runtime.idle();
        assert.equal(signal?.aborted, true);
        assert.equal(runtime.errors.length, 0);
        const out = runtime.store.list<import('../src/daemon/runtime/store.ts').Outbound>('outbox');
        assert.deepEqual(out.map(o => o.text), ['private result', 'group result']);
        assert.equal(runtime.store.get<Envelope>('inbox', groupId)?.state, 'processed');
    }
    finally {
        release();
        await runtime.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
