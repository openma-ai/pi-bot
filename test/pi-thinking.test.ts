import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type ThinkingLevel } from '@earendil-works/pi-agent-core';
import { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { clampThinkingLevel, getSupportedThinkingLevels, hasApi, type Credential, type CredentialStore } from '@earendil-works/pi-ai';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { PiSettings } from '../src/daemon/pi-settings.ts';
import { piThinkingSelection } from '../src/gui/pi-thinking.ts';

type TestModelId = 'gpt-6-sol' | 'gpt-6.1-sol' | 'o3' | 'gpt-4';
const model = (id: TestModelId = 'gpt-6-sol') => getBuiltinModel('openai', id)!;
const publicModel = (id: TestModelId) => ({ reasoning: model(id).reasoning, thinkingLevels: getSupportedThinkingLevels(model(id)) });
class MemoryCredentials implements CredentialStore {
    async read(id: string): Promise<Credential | undefined> { return id === 'openai' ? { type: 'api_key', key: 'isolated-effort-fixture' } : undefined; }
    async list() { return [{ providerId: 'openai', type: 'api_key' as const }]; }
    async modify(): Promise<Credential | undefined> { throw new Error('No credential writes in effort tests'); }
    async delete() { throw new Error('No credential writes in effort tests'); }
}
async function service() {
    const runtime = await ModelRuntime.create({ credentials: new MemoryCredentials(), modelsPath: null,
        modelsStore: { async read() { return undefined; }, async write() {}, async delete() {} },
        refreshOnCreate: false, allowModelNetwork: false });
    // Restrict auth checks to synthetic OpenAI credentials, never ambient providers.
    const scoped = new Proxy(runtime, { get(target, key) {
        if (key === 'refresh') return (options: any) => target.refresh({ ...options, providers: ['openai'], allowNetwork: false });
        if (key === 'getAvailable') return (_provider: string | undefined, options: any) => target.getAvailable('openai', options);
        if (key === 'getProviders') return () => target.getProviders().filter(p => p.id === 'openai');
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    const dir = mkdtempSync(join(tmpdir(), 'pibo-effort-'));
    const settings: PiSettings = new (PiSettings as any)(dir, dir, scoped, false);
    return { dir, settings, close() { settings.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('actual SDK 1.2.0 capabilities differ by model, including disabled off/minimal', () => {
    assert.deepEqual(getSupportedThinkingLevels(model()), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(getSupportedThinkingLevels(model('gpt-6.1-sol')), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(getSupportedThinkingLevels(model('o3')), ['low', 'medium', 'high']);
    assert.deepEqual(getSupportedThinkingLevels(model('gpt-4')), ['off']);
    assert.equal(clampThinkingLevel(model(), 'minimal'), 'low');
    assert.equal(clampThinkingLevel(model(), 'off'), 'off');
});

test('UI uses only SDK capabilities and retains unsupported historical selection for an explicit user choice', () => {
    const existing = piThinkingSelection(publicModel('gpt-6-sol'), 'off');
    assert.equal(existing.value, 'off');
    assert.equal(existing.saveLevel, 'off');
    assert.equal(existing.valid, true);
    assert.ok(!existing.items.some(item => item.id === 'minimal'));
    const invalid = piThinkingSelection(publicModel('gpt-6-sol'), 'minimal');
    assert.equal(invalid.saveLevel, 'minimal', 'no silent clamp or state write');
    assert.equal(invalid.value, '');
    assert.equal(invalid.valid, false);
    assert.match(invalid.note, /最低.*不受此模型支持/);
    const switched = piThinkingSelection(publicModel('gpt-6.1-sol'), 'off');
    assert.equal(switched.saveLevel, 'off');
    assert.equal(switched.valid, false);
});

test('unknown runtime capabilities do not resurrect the hardcoded seven choices', () => {
    const result = piThinkingSelection({ reasoning: true }, 'low');
    assert.equal(result.known, false);
    assert.deepEqual(result.items, []);
    assert.equal(result.valid, false);
    assert.equal(result.saveLevel, 'low');
    assert.match(result.note, /运行环境/);
    assert.equal(piThinkingSelection({ reasoning: true, thinkingLevels: {} } as any, 'low').valid, false);
});

test('non-reasoning models explicitly save off and malformed public choices are not invented', () => {
    const result = piThinkingSelection(publicModel('gpt-4'), 'high');
    assert.equal(result.saveLevel, 'off');
    assert.equal(result.valid, true);
    assert.match(result.note, /不支持调节.*关闭/);
    assert.deepEqual(piThinkingSelection({ reasoning: true, thinkingLevels: ['low', 'low', 'arbitrary'] }, 'low').items,
        [{ id: 'low', name: '低' }]);
});

test('settings metadata reports SDK levels and effective legacy value without rewriting settings', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network allowed'); });
    const s = await service();
    try {
        const file = join(s.dir, 'settings.json');
        const before = JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'minimal' });
        writeFileSync(file, before);
        const state = await s.settings.state();
        assert.equal(state.current.thinkingLevel, 'minimal');
        assert.equal(state.current.effectiveThinkingLevel, 'low');
        assert.deepEqual(state.providers[0].models.find(m => m.id === 'gpt-6-sol')?.thinkingLevels,
            getSupportedThinkingLevels(model()));
        assert.equal(readFileSync(file, 'utf8'), before);
        await assert.rejects(s.settings.selectModel('openai', 'gpt-6-sol', 'minimal'), /不支持所选思考强度/);
        assert.equal(readFileSync(file, 'utf8'), before);
        await s.settings.selectModel('openai', 'gpt-6-sol', 'off');
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).defaultThinkingLevel, 'off');
        const off = await s.settings.state();
        assert.equal(off.current.thinkingLevel, 'off');
        assert.equal(off.current.effectiveThinkingLevel, 'off');
    } finally { s.close(); }
});

test('server rejects per-model unsupported levels and accepts only supported explicit saves', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network allowed'); });
    const s = await service();
    try {
        await assert.rejects(s.settings.selectModel('openai', 'gpt-6.1-sol', 'off'), /不支持所选思考强度/);
        await assert.rejects(s.settings.selectModel('openai', 'o3', 'max'), /不支持所选思考强度/);
        await assert.rejects(s.settings.selectModel('openai', 'gpt-4', 'high'), /不支持所选思考强度/);
        await s.settings.selectModel('openai', 'gpt-6.1-sol', 'low');
        assert.equal(JSON.parse(readFileSync(join(s.dir, 'settings.json'), 'utf8')).defaultThinkingLevel, 'low');
        await s.settings.selectModel('openai', 'gpt-4', 'off');
        assert.equal(JSON.parse(readFileSync(join(s.dir, 'settings.json'), 'utf8')).defaultThinkingLevel, 'off');
    } finally { s.close(); }
});

for (const [id, requested, effective, effort] of [
    ['gpt-6-sol', 'off', 'off', 'none'],
    ['gpt-6-sol', 'minimal', 'low', 'low'],
    ['gpt-6-sol', 'low', 'low', 'low'],
    ['gpt-6-sol', 'medium', 'medium', 'medium'],
    ['gpt-6-sol', 'high', 'high', 'high'],
    ['gpt-6-sol', 'xhigh', 'xhigh', 'xhigh'],
    ['gpt-6-sol', 'max', 'max', 'max'],
    ['gpt-6.1-sol', 'off', 'low', 'low'],
    ['gpt-4', 'high', 'off', undefined],
] as const) test(`real SDK session → agent → mocked Responses payload: ${id}/${requested} → ${effort ?? 'omitted'}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected real network'); });
    const captured: any[] = [], changes: string[] = [];
    const selected = model(id);
    const agent = new Agent({ initialState: { model: selected, thinkingLevel: 'medium', tools: [] },
        streamFn: (m, context, options) => {
            assert.ok(hasApi(m, 'openai-responses'));
            return streamSimple(m, context, { ...options, apiKey: 'isolated-effort-fixture', maxRetries: 0,
            fetch: async (url, init) => {
                assert.equal(String(url), 'https://api.openai.com/v1/responses');
                captured.push(JSON.parse(String(init?.body)));
                // Never submit inference: this injected transport ends at a synthetic HTTP response.
                return new Response(JSON.stringify({ error: { message: 'isolated transport stop', type: 'invalid_request_error' } }),
                    { status: 400, headers: { 'content-type': 'application/json' } });
            } }); } });
    // Exercise the actual SDK setter/availability/clamp methods with isolated collaborators.
    const session = Object.create(AgentSession.prototype);
    Object.assign(session, { agent, sessionManager: { appendThinkingLevelChange: (level: string) => changes.push(level) },
        settingsManager: { setDefaultThinkingLevel() { throw new Error('Must not persist automatically'); } },
        _extensionRunner: { async emit() {} }, _emit() {} });
    session.setThinkingLevel(requested as ThinkingLevel);
    assert.equal(agent.state.thinkingLevel, effective);
    await agent.prompt('isolated effort mapping test');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, id);
    assert.equal(captured[0].reasoning?.effort, effort);
    if (effective !== 'medium') assert.equal(changes.at(-1), effective);
});
