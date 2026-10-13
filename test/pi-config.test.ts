import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadPiConfiguration } from '../src/pi-config.ts';
function fixture() {
    mkdirSync('work/auth-tests', {
        recursive: true
    });
    const dir = mkdtempSync(resolve('work/auth-tests/case-'));
    mkdirSync(join(dir, 'project', '.pi'), {
        recursive: true
    });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
        defaultProvider: 'test-local', defaultModel: 'local-model'
    }));
    writeFileSync(join(dir, 'models.json'), JSON.stringify({
        providers: {
            'test-local': {
                baseUrl: 'https://example.invalid', api: 'openai-completions', models: [{
                        id: 'local-model', name: 'Local', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096, cost: {
                            input: 0, output: 0, cacheRead: 0, cacheWrite: 0
                        }
                    }]
            }
        }
    }));
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({
        'test-local': {
            type: 'api_key', key: 'test-fixture-not-a-real-key'
        }
    }));
    return dir;
}
test('loads native Pi settings and auth without exporting secrets', async () => {
    const dir = fixture();
    const config = await loadPiConfiguration({
        agentDir: dir, cwd: join(dir, 'project')
    });
    assert.equal(config.model.id, 'local-model');
    assert.equal(config.model.provider, 'test-local');
    assert.equal(config.source, 'pi');
    assert.equal((await config.models.getAuth(config.model))?.auth.apiKey, 'test-fixture-not-a-real-key');
    assert.ok(!JSON.stringify(config.public).includes('test-fixture'));
});
test('custom bot environment variables do not override native Pi settings', async () => {
    const dir = fixture();
    const previous = process.env.PI_BOT_PROVIDER;
    process.env.PI_BOT_PROVIDER = 'unwanted';
    try {
        const config = await loadPiConfiguration({
            agentDir: dir, cwd: join(dir, 'project')
        });
        assert.equal(config.model.id, 'local-model');
        assert.equal(config.model.provider, 'test-local');
    }
    finally {
        if (previous === undefined)
            delete process.env.PI_BOT_PROVIDER;
        else
            process.env.PI_BOT_PROVIDER = previous;
    }
});
test('partial native model settings fail instead of silently switching provider', async () => {
    const dir = fixture();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
        defaultProvider: 'test-local'
    }));
    await assert.rejects(loadPiConfiguration({
        agentDir: dir, cwd: join(dir, 'project')
    }), /together/);
});
test('missing native auth cannot silently admit a real task', async () => {
    const dir = fixture();
    writeFileSync(join(dir, 'auth.json'), '{}');
    await assert.rejects(loadPiConfiguration({
        agentDir: dir, cwd: join(dir, 'project')
    }), /login/);
});
