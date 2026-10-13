import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelBackgroundWorker } from '../src/daemon/proactive-model-worker.ts';
import type { Envelope } from '../src/daemon/store.ts';
const evidence = [{
        id: 'source', from: 'user', to: 'bot', kind: 'user', text: 'Notify me only when builds change', taskId: 't', replyTo: null, hop: 0, key: 'e', state: 'processed', createdAt: 1
    }] satisfies Envelope[];
test('background generation and review are separate tool-free bounded model calls', async () => {
    const calls: any[] = [];
    const models = {
        async completeSimple(_model: unknown, context: any, options: any) {
            calls.push({
                context, options
            });
            return {
                stopReason: 'stop', content: [{
                        type: 'text', text: calls.length === 1 ? JSON.stringify({
                            text: 'Prefers change-only build notifications', evidenceRefs: ['source']
                        }) : JSON.stringify({
                            approved: true, reason: 'Explicit source request'
                        })
                    }]
            };
        }
    };
    const worker = createModelBackgroundWorker(models as any, {
        maxTokens: 16384
    } as any, 'memory');
    const signal = new AbortController().signal;
    const proposal = await worker.generate(evidence, signal);
    const review = await worker.review(proposal, evidence, signal);
    assert.equal(calls.length, 2);
    assert.equal(review.approved, true);
    assert.equal(calls[0].options.maxRetries, 0);
    assert.equal(calls[0].options.maxTokens, 8192);
    assert.equal(calls[0].options.signal, signal);
    assert.equal(calls[0].context.tools, undefined);
    assert.match(calls[1].context.systemPrompt, /independent/i);
});
test('invalid model JSON or tool call cannot become approved background work', async () => {
    const models = {
        async completeSimple() {
            return {
                stopReason: 'toolUse', content: [{
                        type: 'toolCall', name: 'send_message'
                    }]
            };
        }
    };
    const worker = createModelBackgroundWorker(models as any, {
        maxTokens: 16384
    } as any, 'research');
    await assert.rejects(worker.generate(evidence, new AbortController().signal), /incomplete/i);
});
