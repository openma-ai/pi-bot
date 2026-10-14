import test from 'node:test';
import assert from 'node:assert/strict';
test('SSE completion records request finish and numeric usage without saving payload text', async () => {
    const { observeProviderSseLine } = await import('../src/evals/provider-telemetry.ts');
    const request: any = {
        id: 3, kind: 'summary', startedAt: 100, maxOutput: 16384
    };
    const usage: any[] = [];
    observeProviderSseLine('data: ' + JSON.stringify({
        choices: [{
                finish_reason: 'stop', delta: {
                    reasoning_content: 'private-reasoning'
                }
            }], usage: {
            prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 900, completion_tokens_details: {
                reasoning_tokens: 30
            }
        }
    }), request, usage, 200);
    assert.equal(request.finishedAt, 200);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].requestId, 3);
    assert.equal(usage[0].reasoning_tokens, 30);
    observeProviderSseLine('data: [DONE]\r', request, usage, 201);
    assert.equal(request.finishedAt, 200);
    assert.equal(JSON.stringify({
        request, usage
    }).includes('private-reasoning'), false);
});
