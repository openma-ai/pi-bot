import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { SimulatedChat } from '../src/evals/chat.ts';
import { runEvaluation, gradeScenario, scenarios, RequestBudget, SMOKE_CAP } from '../src/evals/evaluation.ts';
test('simulated transport: same actor/task/key isolated by channel; members and cross-channel handoffs enforced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-route-test-'));
    const runtime = new BotRuntime(join(dir, 'bot.db'), async () => ({
        async run() {
        }, async close() {
        }
    }));
    try {
        const chat = new SimulatedChat(runtime);
        const a = chat.channel('alpha', ['alice', 'bob']);
        const b = chat.channel('beta', ['alice', 'eve']);
        const message = {
            senderId: 'alice', threadId: 'thread', taskId: 'same-task', key: 'same-key', text: 'same text'
        };
        const first = chat.send({
            ...message, channelId: a.id
        });
        const second = chat.send({
            ...message, channelId: b.id
        });
        assert.notEqual(first.id, second.id);
        assert.notEqual(first.to, second.to);
        assert.throws(() => chat.send({
            ...message, channelId: 'beta', senderId: 'bob'
        }), /authorized/);
        assert.throws(() => chat.send({
            ...message, channelId: 'alpha', senderId: 'bob', key: 'steal', taskControl: 'cancel'
        }), /owned/);
        assert.throws(() => runtime.sendToBot(first, b.worker.id, 'cross-channel', 'cross'), /channel mismatch/);
        const handed = runtime.sendToBot(first, a.worker.id, 'same-channel', 'same');
        runtime.sendMessage(handed, 'alpha only', 'a-out');
        runtime.sendMessage(second, 'beta only', 'b-out');
        await runtime.idle();
        await chat.deliver();
        assert.deepEqual(chat.deliveries.map(o => o.route?.channelId), ['alpha', 'beta']);
    }
    finally {
        await runtime.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('scheduled behavioral runner exercises native Pi and grades side effects/routes across all custom scenarios', async () => {
    const report = await runEvaluation();
    assert.equal(report.pass, true, JSON.stringify(report));
    assert.equal(report.scenarios.reduce((n, s) => n + s.score.validTaskCompletion, 0), 5);
    assert.ok(report.scenarios.every(s => s.transcriptPairsValid && s.pendingEvents === 0));
    assert.ok(report.budget.requests <= SMOKE_CAP.requests);
    assert.equal(report.budget.refused, 0);
});
test('behavior oracle rejects missing, duplicate, wrong-route, obsolete and chatter output', () => {
    const scenario = scenarios[0]!;
    const expected = scenario.expected[0]!;
    const effect = {
        channel: expected.channel, task: expected.task, item: expected.item, value: expected.value, messageId: 'source', dispatchOrder: 1
    };
    const outbound: any = {
        taskId: expected.task, route: {
            channelId: 'wrong', threadId: expected.thread, senderId: expected.sender
        }, text: 'DONE brief=ALPHA'
    };
    const score = gradeScenario(scenario, [effect, effect, {
            ...effect, value: 'OLD'
        }], [outbound, {
            ...outbound, taskId: scenario.noise[0], text: 'chat acknowledgement'
        }]);
    assert.equal(score.validTaskCompletion, 0);
    assert.equal(score.missedCommitments, 3);
    assert.equal(score.duplicateActions, 2);
    assert.equal(score.wrongRecipients, 1);
    assert.equal(score.obsoleteActions, 1);
    assert.equal(score.appropriateSilence, false);
});
test('request budget refuses before request dispatch and does not silently expand caps', () => {
    const budget = new RequestBudget({
        ...SMOKE_CAP, requests: 1, inputTokenReservations: 2000
    });
    budget.reserve({
        messages: []
    }, 1024);
    assert.throws(() => budget.reserve({
        messages: []
    }, 1024), /budget reached/);
    assert.equal(budget.requests, 1);
    assert.equal(budget.outputReserved, 1024);
    assert.equal(budget.refused, 1);
});
test('task replacement/cancellation closes stale action and pending-delivery races; dispatched job survives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-stale-test-'));
    const runtime = new BotRuntime(join(dir, 'bot.db'), async () => ({
        async run() {
        }, async close() {
        }
    }));
    let release!: () => void;
    const gate = new Promise<void>(r => release = r);
    let effects = 0;
    let began!: () => void;
    const dispatched = new Promise<void>(resolve => { began = resolve; });
    try {
        const chat = new SimulatedChat(runtime);
        const channel = chat.channel('alpha', ['alice']);
        const base = {
            channelId: channel.id, senderId: 'alice', threadId: 'thread', taskId: 'task'
        };
        const old = chat.send({
            ...base, key: 'old', text: 'old task'
        });
        runtime.sendMessage(old, 'old pending message', 'old-out');
        const started = runtime.startJob(old, 'ordinary-started-effect', {}, 'started', async () => {
            began();
            await gate;
            effects++;
            return 'complete';
        });
        // The contract below concerns an already dispatched effect, not a queued job.
        await dispatched;
        const corrected = chat.send({
            ...base, key: 'new', text: 'corrected task', taskControl: 'replace'
        });
        assert.throws(() => runtime.sendMessage(old, 'stale new message', 'stale'), /superseded/);
        assert.throws(() => runtime.startJob(old, 'future', {}, 'future', async () => {
        }), /superseded/);
        runtime.sendMessage(corrected, 'corrected', 'corrected');
        await chat.deliver();
        assert.deepEqual(chat.deliveries.map(o => o.text), ['corrected']);
        assert.equal(runtime.store.list<any>('outbox').find(o => o.key === 'old-out')?.state, 'superseded');
        chat.send({
            ...base, key: 'cancel', text: 'cancel future work', taskControl: 'cancel'
        });
        assert.throws(() => runtime.sendToBot(corrected, channel.worker.id, 'future work', 'future-handoff'), /cancelled/);
        release();
        await runtime.idle();
        assert.equal(effects, 1);
        assert.equal(runtime.store.get<any>('jobs', started.id)?.state, 'completed');
        assert.ok(runtime.store.list<any>('inbox').some(e => e.kind === 'job' && e.state === 'processed'));
    }
    finally {
        release();
        await runtime.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('request budget keeps aborted reservations and rejects invalid output caps/mutated caller limits', () => {
    const limits = {
        ...SMOKE_CAP, requests: 1
    };
    const budget = new RequestBudget(limits);
    for (const cap of [NaN, Infinity, 0, -1, 1.5])
        assert.throws(() => budget.reserve({}, cap), /budget/);
    budget.reserve({}, 1024); // Even an aborted request remains charged/reserved.
    limits.requests = 999;
    assert.throws(() => budget.reserve({}, 1024), /budget/);
    assert.equal(budget.requests, 1);
    assert.equal(budget.outputReserved, 1024);
});
test('thinking evaluation: round timeout is distinct from behavioral outcome and fails incomplete', async () => {
    const report = await runEvaluation({
        deadlineMs: 5
    });
    assert.equal(report.timeouts.roundReached, true);
    assert.equal(report.pass, false);
    assert.ok(report.budget.requests <= SMOKE_CAP.requests);
    assert.equal(SMOKE_CAP.outputTokensPerRequest, 16384);
    assert.equal(SMOKE_CAP.requests * SMOKE_CAP.outputTokensPerRequest, 524288);
    assert.ok(Math.abs(SMOKE_CAP.estimatedUsd - (384000 * 0.30 + 524288 * 1.20) / 1000000) < 1e-10);
});
test('wire accounting reserves the provider messages and tools, not unsent nested diagnostic copies', () => {
    const budget = new RequestBudget({
        ...SMOKE_CAP, inputTokenReservations: 3000
    });
    const body = {
        model: 'deepseek-v4-flash', messages: [{
                role: 'user', content: 'Task'
            }, {
                role: 'tool', tool_call_id: 'x', content: 'Complete output'
            }], tools: [], max_tokens: 16384, thinking: {
            type: 'enabled'
        }, reasoning_effort: 'high'
    };
    assert.equal(typeof budget.reserveWire, 'function');
    budget.reserveWire(body);
    assert.equal(budget.requests, 1);
    assert.ok(budget.inputReserved < 3000);
    assert.throws(() => budget.reserveWire({
        ...body, messages: [{
                role: 'user', content: 'x'.repeat(4000)
            }]
    }), /budget/);
});
test('request-count evaluation keeps finite dispatch limits without input reservations', () => {
    const budget = new RequestBudget({
        ...SMOKE_CAP, requests: 2, inputTokenReservations: 10
    }, 'wire', {
        reserveInput: false
    });
    budget.reserveWire({
        max_tokens: 8192, messages: [{
                content: 'x'.repeat(10000)
            }]
    });
    budget.reserveWire({
        max_tokens: 16384, messages: [{
                content: 'y'.repeat(10000)
            }]
    });
    assert.equal(budget.requests, 2);
    assert.equal(budget.inputReserved, 0);
    assert.throws(() => budget.reserveWire({
        max_tokens: 1
    }), /request budget reached/);
});
test('natural-language controls are evaluated without host cancellation or replacement protection', async () => {
    const report = await runEvaluation({
        mode: 'scripted', trace: true, scenarioIds: ['replace-cancel'], hostControls: false
    });
    assert.equal(report.controlMode, 'natural-language-only');
    assert.equal(report.pass, true);
    assert.ok(report.scenarios[0].trace!.inbox.every(e => !e.taskControl));
    assert.equal(report.scenarios[0].score.validTaskCompletion, 1);
    assert.equal(report.scenarios[0].score.obsoleteActions, 0);
});
