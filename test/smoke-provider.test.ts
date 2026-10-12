import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureSmokeProvider, SMOKE_PROVIDER } from '../src/smoke-provider.ts';
test('official Flash wire: fixed endpoint, explicit non-thinking mode and bounded output; fetch is mocked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-smoke-wire-'));
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    try {
        const model = configureSmokeProvider(runtime, 'deepseek-v4-flash');
        await runtime.setRuntimeApiKey(SMOKE_PROVIDER, 'SYNTHETIC-NOT-A-REAL-KEY');
        let url = '';
        let payload: any;
        let requests = 0;
        const reply = await runtime.completeSimple(model, {
            messages: [{
                    role: 'user', content: 'synthetic fixture', timestamp: 0
                }]
        }, {
            maxTokens: 1024, maxRetries: 0, fetch: async (input, init) => {
                requests++;
                url = String(input);
                payload = JSON.parse(String(init?.body));
                const chunk = {
                    id: 'fixture', object: 'chat.completion.chunk', created: 0, model: model.id, choices: [{
                            index: 0, delta: {
                                role: 'assistant', content: 'fixture complete'
                            }, finish_reason: 'stop'
                        }]
                };
                return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                    headers: {
                        'content-type': 'text/event-stream'
                    }
                });
            }
        });
        assert.equal(reply.stopReason, 'stop');
        assert.equal(requests, 1);
        assert.equal(url, 'https://api.deepseek.com/chat/completions');
        assert.equal(payload.model, 'deepseek-v4-flash');
        assert.deepEqual(payload.thinking, {
            type: 'disabled'
        });
        assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 1024);
        assert.throws(() => configureSmokeProvider(runtime, 'deepseek-v4-pro'), /Only reviewed/);
    }
    finally {
        await runtime.removeRuntimeApiKey(SMOKE_PROVIDER);
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
