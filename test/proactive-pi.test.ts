import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from '../src/runtime.ts';
import { piSessionFactory } from '../src/pi.ts';
import { ProactiveService } from '../src/proactive.ts';
import type { Envelope, Outbound } from '../src/store.ts';
test('native Pi creates a durable schedule and responds through send_message on fire', {
    timeout: 15000
}, async () => {
    await mkdir(resolve('work/proactive-tests'), {
        recursive: true
    });
    const dir = await mkdtemp(resolve('work/proactive-tests/pi-'));
    const faux = fauxProvider({
        provider: 'proactive-pi', models: [{
                id: 'test', contextWindow: 128000, maxTokens: 4096
            }], tokensPerSecond: 1000000
    });
    let stage = 0;
    let source = '';
    let now = 1000;
    let service!: ProactiveService;
    faux.setResponses(Array.from({
        length: 8
    }, () => (ctx: any) => {
        if (stage++ === 0)
            return fauxAssistantMessage(fauxToolCall('schedule_create', {
                key: 'reminder', prompt: 'send REMINDER', at: 2000, timezone: 'Asia/Shanghai', source_message_id: source
            }, {
                id: 'schedule-call'
            }), {
                stopReason: 'toolUse'
            });
        const fire = service?.listFires(bot.id)[0];
        if (fire && !runtime.store.list<Outbound>('outbox').length)
            return fauxAssistantMessage(fauxToolCall('send_message', {
                text: 'REMINDER', key: 'reminder-result', source_message_id: fire.inboxId
            }, {
                id: 'reply'
            }), {
                stopReason: 'toolUse'
            });
        return fauxAssistantMessage('internal');
    }));
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
        dir, modelRuntime: models, model: faux.getModel(), extensions: [pi => pi.registerProvider(faux.provider)], proactive: r => service ??= new ProactiveService(r, {
            now: () => now
        }), preemptInference: false
    }));
    const bot = runtime.createBot('main', '', 'alpha');
    try {
        const e = runtime.accept({
            to: bot.id, key: 'start', text: 'Schedule a reminder', route: {
                channelId: 'alpha', threadId: 'thread', senderId: 'alice'
            }
        });
        source = e.id;
        await runtime.idle();
        assert.equal(service.listSchedules(bot.id).length, 1);
        assert.equal(runtime.store.get<Envelope>('inbox', e.id)?.consumedAt !== undefined, true);
        now = 2000;
        await service.tick();
        await runtime.idle();
        const outputs: Outbound[] = [];
        await runtime.deliver(async (o) => {
            outputs.push(o);
        });
        assert.equal(outputs.length, 1);
        assert.equal(outputs[0].text, 'REMINDER');
        assert.deepEqual(outputs[0].route, e.route);
        assert.equal(runtime.errors.length, 0);
    }
    finally {
        await service?.close();
        await runtime.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
