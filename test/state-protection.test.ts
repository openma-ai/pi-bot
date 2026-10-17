import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { ProactiveService } from '../src/daemon/runtime/proactive.ts';
import { piSessionFactory } from '../src/pi/session-factory.ts';
import { conversationResource, ReadEvidence, scheduleResource } from '../src/pi/state-protection.ts';
import type { Envelope, Outbound } from '../src/daemon/runtime/store.ts';
import type { Schedule } from '../src/pi/types.ts';
const route = {
    channelId: 'alpha', threadId: 'main', senderId: 'alice'
};
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bot-state-'));
    const path = join(dir, 'bot.db');
    const factory = async () => ({
        async run() {
        }, async close() {
        }
    });
    let runtime = new BotRuntime(path, factory);
    const bot = runtime.createBot('main', '', 'alpha');
    const input = (text: string, key: string, kind: Envelope['kind'] = 'user', inputRoute = route) => runtime.accept({
        to: bot.id, text, key, kind, route: inputRoute
    });
    const first = input('What is the status?', 'first');
    await runtime.idle();
    return {
        bot, first, input, get runtime() {
            return runtime;
        },
        outbox: () => runtime.store.list<Outbound>('outbox'),
        async restart() {
            await runtime.close();
            runtime = new BotRuntime(path, factory);
        },
        async close() {
            await runtime.close();
            await rm(dir, {
                recursive: true, force: true
            });
        }
    };
}
test('message commits against the read conversation revision and replays its saved result', async () => {
    const h = await fixture();
    try {
        const sent = h.runtime.commitMessage(h.first, 'All green.', 'reply', {
            observedConversation: h.first.id
        });
        assert.equal(sent.status, 'committed');
        assert.equal(h.outbox().length, 1);
        // The agent's own append does not move the conversation frontier for a second reply.
        assert.equal(h.runtime.commitMessage(h.first, 'Details follow.', 'details', {
            observedConversation: h.first.id
        }).status, 'committed');
        const replay = h.runtime.commitMessage(h.first, 'All green.', 'reply', {
            observedConversation: h.first.id
        });
        assert.equal(replay.status === 'committed' && sent.status === 'committed' && replay.value.id === sent.value.id, true);
        assert.equal(h.outbox().length, 2);
        // Peer messages, job receipts and other conversations are unrelated to this reply.
        h.input('peer note', 'peer', 'bot');
        h.input('job settled', 'job', 'job');
        h.input('another thread', 'other', 'user', {
            ...route, threadId: 'side'
        });
        await h.runtime.idle();
        assert.equal(h.runtime.commitMessage(h.first, 'Still green.', 'unrelated', {
            observedConversation: h.first.id
        }).status, 'committed');
    }
    finally {
        await h.close();
    }
});
test('message conflict after new user input has zero side effects and needs a new decision', async () => {
    const h = await fixture();
    try {
        const correction = h.input('Actually, only report failures.', 'correction');
        await h.runtime.idle();
        const stale = h.runtime.commitMessage(h.first, 'Everything passed: a, b, c.', 'stale', {
            observedConversation: h.first.id
        });
        assert.deepEqual(stale.status === 'conflict' && {
            effect: stale.effect, conflicts: stale.conflicts
        }, {
            effect: 'not-applied', conflicts: [{
                    resourceId: conversationResource(route), expectedRevision: h.first.id, actualRevision: correction.id
                }]
        });
        assert.equal(h.outbox().length, 0);
        // No automatic rebase: the same operation replays its saved conflict.
        assert.equal(h.runtime.commitMessage(h.first, 'Everything passed: a, b, c.', 'stale', {
            observedConversation: h.first.id
        }).status, 'conflict');
        assert.throws(() => h.runtime.commitMessage(h.first, 'No failures.', 'stale', {
            observedConversation: correction.id
        }), /Idempotency key conflict/);
        // A decision without having read the conversation is not a fresh read either.
        assert.equal(h.runtime.commitMessage(h.first, 'No failures.', 'unread', {
            observedConversation: null
        }).status, 'conflict');
        const rewritten = h.runtime.commitMessage(correction, 'No failures.', 'rewritten', {
            observedConversation: correction.id
        });
        assert.equal(rewritten.status, 'committed');
        assert.deepEqual(h.outbox().map(o => o.text), ['No failures.']);
    }
    finally {
        await h.close();
    }
});
test('committed message survives restart: same-key replay is not a conflict with its own write', async () => {
    const h = await fixture();
    try {
        const sent = h.runtime.commitMessage(h.first, 'Done.', 'done', {
            observedConversation: h.first.id
        });
        await h.restart();
        const replay = h.runtime.commitMessage(h.first, 'Done.', 'done', {
            observedConversation: h.first.id
        });
        assert.equal(replay.status, 'committed');
        assert.equal(replay.status === 'committed' && sent.status === 'committed' && replay.value.id === sent.value.id, true);
        assert.equal(h.outbox().length, 1);
    }
    finally {
        await h.close();
    }
});
test('competing trigger decisions on one revision: only the first commits, the loser has no effect', async () => {
    const h = await fixture();
    try {
        const service = new ProactiveService(h.runtime, {
            now: () => 1000
        });
        const s = service.createSchedule(h.first, {
            key: 'daily', prompt: 'report', at: 5000, timezone: 'Asia/Shanghai', intervalMs: 60000
        });
        const read = String(s.revision);
        const winner = service.cancelSchedule(h.bot.id, s.id, {
            operationId: 'tool:a', observed: read
        });
        assert.equal(winner.status, 'committed');
        const loser = service.cancelSchedule(h.bot.id, s.id, {
            operationId: 'tool:b', observed: read
        });
        assert.deepEqual(loser.status === 'conflict' && loser.conflicts, [{
                resourceId: scheduleResource(s.id), expectedRevision: '1', actualRevision: '2'
            }]);
        assert.match(loser.status === 'conflict' ? loser.reread : '', /schedule_list/);
        // Replaying the winner returns its receipt even though it advanced the revision itself.
        assert.equal(service.cancelSchedule(h.bot.id, s.id, {
            operationId: 'tool:a', observed: read
        }).status, 'committed');
        assert.equal(h.runtime.store.get<Schedule>('schedules', s.id)!.revision, 2);
    }
    finally {
        await h.close();
    }
});
test('trigger changed by the host after the agent read conflicts; bookkeeping and foreign owners do not leak', async () => {
    const h = await fixture();
    try {
        let now = 1000;
        const service = new ProactiveService(h.runtime, {
            now: () => now
        });
        const s = service.createSchedule(h.first, {
            key: 'hourly', prompt: 'report', at: 2000, timezone: 'Asia/Shanghai', intervalMs: 3600000
        });
        // Firing advances nextFire only; that is bookkeeping, not a business revision.
        now = 2000;
        await service.tick();
        const fired = h.runtime.store.get<Schedule>('schedules', s.id)!;
        assert.equal(fired.revision, 1);
        assert.notEqual(fired.nextFire, s.nextFire);
        service.pauseSchedule(h.bot.id, s.id);
        const stale = service.cancelSchedule(h.bot.id, s.id, {
            operationId: 'tool:cancel', observed: '1'
        });
        assert.equal(stale.status, 'conflict');
        const kept = h.runtime.store.get<Schedule>('schedules', s.id)!;
        assert.equal(kept.state, 'paused');
        assert.throws(() => service.cancelSchedule('foreign-bot', s.id, {
            operationId: 'tool:foreign', observed: '2'
        }), /owner/i);
        assert.equal(service.cancelSchedule(h.bot.id, s.id, {
            operationId: 'tool:cancel-2', observed: String(kept.revision)
        }).status, 'committed');
    }
    finally {
        await h.close();
    }
});
test('read evidence freezes what the model was shown when it called a tool', () => {
    const evidence = new ReadEvidence();
    const input = (id: string, kind: Envelope['kind'] = 'user', threadId = 'main') => ({
        id, kind, route: {
            ...route, threadId
        }
    }) as Envelope;
    const conversation = conversationResource(route);
    evidence.observeContext([input('m1'), input('peer', 'bot'), input('side', 'user', 'side')]);
    evidence.bind('call-1');
    evidence.observe(scheduleResource('s'), '1');
    evidence.bind('call-2');
    assert.deepEqual(evidence.decision('call-1', conversation), {
        operationId: 'tool:call-1', observed: 'm1'
    });
    // A tool result is evidence only once a later model request has shown it.
    assert.equal(evidence.decision('call-2', scheduleResource('s')).observed, null);
    evidence.observeContext([input('m1'), input('m2')]);
    evidence.bind('call-3');
    evidence.bind('nested', 'call-1');
    assert.equal(evidence.decision('call-3', scheduleResource('s')).observed, '1');
    assert.equal(evidence.decision('call-3', conversation).observed, 'm2');
    assert.equal(evidence.decision('nested', conversation).observed, 'm1');
    assert.equal(evidence.decision('call-3', conversationResource({
        ...route, threadId: 'side'
    })).observed, 'side');
});
test('native Pi send_message returns the conflict to the deciding agent, which rewrites and commits', {
    timeout: 15000
}, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bot-state-pi-'));
    const faux = fauxProvider({
        provider: 'state-protection', models: [{
                id: 'mock', contextWindow: 128000, maxTokens: 4096
            }], tokensPerSecond: 1000000
    });
    const toolResults: string[] = [];
    let runtime!: BotRuntime, botId = '', correction = '';
    faux.setResponses([
        () => {
            // The user corrects the request after this model request was built.
            correction = runtime.accept({
                to: botId, text: 'Correction: only report failures.', key: 'correction', route
            }).id;
            return fauxAssistantMessage(fauxToolCall('send_message', {
                text: 'Everything passed.', key: 'first-reply'
            }, {
                id: 'first-reply'
            }), {
                stopReason: 'toolUse'
            });
        },
        (ctx: any) => {
            toolResults.push(JSON.stringify(ctx.messages.filter((m: any) => m.role === 'toolResult')));
            return fauxAssistantMessage(fauxToolCall('send_message', {
                text: 'No failures.', key: 'second-reply', source_message_id: correction
            }, {
                id: 'second-reply'
            }), {
                stopReason: 'toolUse'
            });
        },
        ...Array.from({
            length: 4
        }, () => fauxAssistantMessage('done'))
    ]);
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false
    });
    runtime = new BotRuntime(join(dir, 'bot.db'), piSessionFactory({
        dir: join(dir, 'sessions'), modelRuntime, model: faux.getModel(), extensions: [pi => pi.registerProvider(faux.provider)], preemptInference: false
    }));
    try {
        botId = runtime.createBot('main', '', 'alpha').id;
        runtime.accept({
            to: botId, text: 'Report the test status.', key: 'request', route
        });
        await runtime.idle();
        assert.match(toolResults[0], /\\"status\\":\\"conflict\\"/);
        assert.match(toolResults[0], /not-applied/);
        assert.deepEqual(runtime.store.list<Outbound>('outbox').map(o => o.text), ['No failures.']);
    }
    finally {
        await runtime.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('native Pi schedule_cancel commits against the revision its own read tools showed', {
    timeout: 15000
}, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bot-state-pi-'));
    const faux = fauxProvider({
        provider: 'state-protection-schedule', models: [{
                id: 'mock', contextWindow: 128000, maxTokens: 4096
            }], tokensPerSecond: 1000000
    });
    const results = (ctx: any) => ctx.messages.filter((m: any) => m.role === 'toolResult').map((m: any) => m.details);
    const seen: any[] = [];
    let runtime!: BotRuntime, service!: ProactiveService, botId = '', scheduleId = '';
    const cancel = (id: string) => fauxAssistantMessage(fauxToolCall('schedule_cancel', {
        id: scheduleId
    }, {
        id
    }), {
        stopReason: 'toolUse'
    });
    faux.setResponses([
        () => fauxAssistantMessage(fauxToolCall('schedule_create', {
            key: 'daily', prompt: 'report', at: 5000, timezone: 'Asia/Shanghai', intervalMs: 60000
        }, {
            id: 'create'
        }), {
            stopReason: 'toolUse'
        }),
        (ctx: any) => {
            scheduleId = results(ctx)[0].id;
            // A human pauses the schedule after the model saw revision 1.
            service.pauseSchedule(botId, scheduleId);
            return cancel('stale-cancel');
        },
        (ctx: any) => {
            seen.push(results(ctx).at(-1));
            return fauxAssistantMessage(fauxToolCall('schedule_list', {}, {
                id: 'list'
            }), {
                stopReason: 'toolUse'
            });
        },
        () => cancel('fresh-cancel'),
        (ctx: any) => {
            seen.push(results(ctx).at(-1));
            return fauxAssistantMessage('done');
        },
        ...Array.from({
            length: 4
        }, () => fauxAssistantMessage('done'))
    ]);
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false
    });
    runtime = new BotRuntime(join(dir, 'bot.db'), piSessionFactory({
        dir: join(dir, 'sessions'), modelRuntime, model: faux.getModel(), extensions: [pi => pi.registerProvider(faux.provider)], preemptInference: false, proactive: () => service ??= new ProactiveService(runtime, {
            now: () => 1000
        })
    }));
    try {
        botId = runtime.createBot('main', '', 'alpha').id;
        runtime.accept({
            to: botId, text: 'Set up and manage a daily report.', key: 'request', route
        });
        await runtime.idle();
        assert.deepEqual(seen[0].status === 'conflict' && seen[0].conflicts, [{
                resourceId: scheduleResource(scheduleId), expectedRevision: '1', actualRevision: '2'
            }]);
        assert.deepEqual(seen[1], {
            cancelled: scheduleId, revision: 3
        });
        assert.equal(runtime.store.get<Schedule>('schedules', scheduleId)!.state, 'cancelled');
    }
    finally {
        await service?.close();
        await runtime.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
