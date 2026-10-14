import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreResponseBenchmark } from '../src/evals/response-benchmark.ts';
import type { Envelope, Outbound } from '../src/daemon/runtime/store.ts';
const e = {
    id: 'task', from: 'user', to: 'bot', kind: 'user', text: 'compute', taskId: 't', replyTo: null, hop: 0, key: 't', state: 'processed', createdAt: 100, admittedAt: 120, consumedAt: 130, resolvedAt: 180, route: {
        channelId: 'a', threadId: 'x', senderId: 'alice'
    }
} satisfies Envelope;
const output = (id: string, text: string, time: number, deliveredAt = time + 5): Outbound => ({
    id, botId: 'bot', taskId: 't', replyTo: 'task', key: id, text, state: 'delivered', createdAt: time, deliveredAt, route: e.route
});
test('speed scores useful ground-truth response, never empty acknowledgement', () => {
    const score = scoreResponseBenchmark([e], [output('ack', 'Received', 125), output('result', 'RESULT 42', 170)], [{
            inboxId: e.id, finalText: 'RESULT 42', effectiveTexts: ['RESULT 42']
        }]);
    assert.equal(score.latencyMs.admission.p50, 20);
    assert.equal(score.latencyMs.firstEffectiveResponse.p50, 70);
    assert.equal(score.latencyMs.admissionToEffectiveResponse.p50, 50);
    assert.equal(score.latencyMs.delivery.p50, 5);
    assert.equal(score.unexpectedReplies, 1);
    assert.equal(score.completed, 1);
});
test('wrong group, duplicate, silence breach and missing timing remain visible', () => {
    const score = scoreResponseBenchmark([e, {
            ...e, id: 'noise', taskId: 'noise', admittedAt: undefined
        }], [output('one', 'RESULT 42', 170), output('two', 'RESULT 42', 171), {
            ...output('foreign', 'RESULT 42', 160), route: {
                ...e.route, channelId: 'b'
            }
        }, {
            ...output('noise', 'Hello', 150), taskId: 'noise', replyTo: 'noise'
        }], [{
            inboxId: e.id, finalText: 'RESULT 42'
        }, {
            inboxId: 'noise', silent: true
        }]);
    assert.equal(score.duplicates, 1);
    assert.equal(score.wrongRecipients, 1);
    assert.equal(score.silenceBreaches, 1);
    assert.equal(score.latencyMs.admission.samples, 1);
});
