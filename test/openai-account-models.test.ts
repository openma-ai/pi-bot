import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { OpenAIAccountModels } from '../src/daemon/openai-account-models.ts';
import { PiModelCatalog } from '../src/daemon/pi-model-catalog.ts';
import { PiSettings } from '../src/daemon/pi-settings.ts';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const endpoint = 'https://api.openai.com/v1/models';
const fixtureToken = 'qa-only-not-a-token';
const spec = (id: string): any => ({ id, name: 'SDK ' + id, provider: 'openai', api: 'openai-responses', reasoning: true });
const entry = (slug: string, visibility = 'list') => ({ slug, visibility, display_name: 'Account ' + slug });
function runtime(overrides: Record<string, any> = {}): any {
    return {
        getAuth: async () => ({ source: 'OAuth', auth: { apiKey: fixtureToken, headers: { 'x-private': 'must-not-forward' } } }),
        isUsingOAuth: (id: string) => id === 'openai', checkAuth: async () => ({ type: 'oauth' }),
        getProvider: () => ({ id: 'openai', baseUrl: 'https://api.openai.com/v1' }),
        refresh: async () => ({ aborted: false, errors: new Map() }), getAvailable: async () => [spec('one'), spec('two')],
        getProviders: () => [{ id: 'openai' }], hasConfiguredAuth: () => true, getError: () => undefined, ...overrides
    };
}
function safeFailure(value: any) {
    assert.deepEqual(value.models, []);
    assert.equal(value.catalog.source, 'openai-account');
    assert.equal(value.catalog.status, 'failed');
    assert.equal(value.catalog.accountAccess, 'unverified');
    assert.ok(!JSON.stringify(value).includes(fixtureToken));
}
test('SIWC list uses fixed endpoint, exact bearer only, display name/order, visibility and SDK intersection', async t => {
    t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
        assert.equal(input, endpoint); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
        assert.deepEqual(Object.fromEntries(new Headers(init.headers)), { accept: 'application/json', authorization: 'Bearer ' + fixtureToken });
        return Response.json({ models: [entry('two'), entry('hidden', 'hidden'), entry('unknown'), entry('one')] });
    });
    const result = await new OpenAIAccountModels(runtime()).read([spec('one'), spec('two'), spec('hidden')], true);
    assert.deepEqual(result.models.map(m => [m.id, m.name, m.reasoning]), [['two', 'Account two', true], ['one', 'Account one', true]]);
    assert.equal(result.catalog.accountAccess, 'confirmed'); assert.equal(result.catalog.status, 'partial');
    assert.equal(result.catalog.unsupportedModelCount, 1); assert.ok(result.catalog.unsupportedModelReason);
});

test('successful empty account list is confirmed empty, never replaced with public models', async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ models: [] }));
    const result = await new OpenAIAccountModels(runtime()).read([spec('one')], true);
    assert.deepEqual(result.models, []); assert.equal(result.catalog.accountAccess, 'confirmed');
    assert.equal(result.catalog.status, 'refreshed');
});

test('custom per-model routes and unsupported API specifications are not guessed into SIWC compatibility', async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ models: [entry('proxy'), entry('chat-completions')] }));
    const value = await new OpenAIAccountModels(runtime()).read([
        { ...spec('proxy'), baseUrl: 'https://proxy.invalid/v1' },
        { ...spec('chat-completions'), api: 'openai-completions' }
    ], true);
    assert.deepEqual(value.models, []);
    assert.equal(value.catalog.accountAccess, 'confirmed');
    assert.equal(value.catalog.unsupportedModelCount, 2);
});

test('offline, API key auth, legacy, custom base URL and changed auth source cannot dispatch SIWC', async t => {
    let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('Must not fetch'); });
    for (const candidate of [runtime({ isUsingOAuth: () => false }), runtime({ checkAuth: async () => ({ type: 'api_key' }) }),
        runtime({ getProvider: () => ({ baseUrl: 'https://proxy.invalid/v1' }) }),
        runtime({ getAuth: async () => ({ source: 'OAuth', auth: { apiKey: fixtureToken, baseUrl: 'https://proxy.invalid/v1' } }) }),
        runtime({ getAuth: async () => ({ source: 'stored credential', auth: { apiKey: fixtureToken } }) })]) {
        safeFailure(await new OpenAIAccountModels(candidate).read([spec('one')], true));
    }
    safeFailure(await new OpenAIAccountModels(runtime()).read([spec('one')], false));
    assert.equal(calls, 0);
});

test('HTTP errors, redirects, malformed JSON and missing models fail closed with no raw response', async t => {
    const responses = [() => new Response(fixtureToken, { status: 401 }), () => new Response(fixtureToken, { status: 403 }),
        () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }),
        () => new Response('{'+fixtureToken, { headers: { 'content-type': 'application/json' } }),
        () => Response.json({ data: [entry('one')] }), () => Response.json({ models: [entry('one'), entry('one')] })];
    for (const response of responses) {
        t.mock.method(globalThis, 'fetch', async () => response());
        safeFailure(await new OpenAIAccountModels(runtime()).read([spec('one')], true));
    }
});

test('declared and streamed response sizes are bounded', async t => {
    for (const response of [() => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }),
        () => new Response(new Uint8Array(1048577), { headers: { 'content-type': 'application/json' } })]) {
        t.mock.method(globalThis, 'fetch', async () => response());
        safeFailure(await new OpenAIAccountModels(runtime()).read([spec('one')], true));
    }
});

test('hanging headers and body have a deadline', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(() => {}));
    safeFailure(await new OpenAIAccountModels(runtime(), 15).read([spec('one')], true));
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }));
    safeFailure(await new OpenAIAccountModels(runtime(), 15).read([spec('one')], true));
});

test('external account switch discards late response, next read fetches new account instead of cached list', async t => {
    let token = fixtureToken, release!: (value: Response) => void, calls = 0;
    const api = new OpenAIAccountModels(runtime({ getAuth: async () => ({ source: 'OAuth', auth: { apiKey: token } }) }));
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); });
    const first = api.read([spec('one')], true);
    while (!release) await new Promise(r => setTimeout(r, 1));
    token = 'qa-different-account'; release(Response.json({ models: [entry('one')] }));
    safeFailure(await first);
    t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ models: [entry('two')] }); });
    const second = await api.read([spec('one'), spec('two')], true);
    assert.deepEqual(second.models.map(m => m.id), ['two']); assert.equal(calls, 2);
});

test('explicit login/logout invalidation blocks late publication and old canSelect', async t => {
    let release!: (value: Response) => void;
    t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { release = resolve; }));
    const catalog = new PiModelCatalog(runtime());
    const pending = catalog.refresh(); while (!release) await new Promise(r => setTimeout(r, 1));
    catalog.invalidate(); release(Response.json({ models: [entry('one')] }));
    safeFailure(await pending);
    release = undefined as any;
    const selected = catalog.canSelect('openai', 'one'); while (!release) await new Promise(r => setTimeout(r, 1));
    catalog.invalidate(); release(Response.json({ models: [entry('one')] }));
    assert.equal(await selected, false);
});

test('server selection re-queries SIWC and rejects public-only or revoked choices', async t => {
    let models = [entry('two')], calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ models }); });
    const catalog = new PiModelCatalog(runtime());
    assert.deepEqual((await catalog.refresh()).models.map(m => m.id), ['two']);
    assert.equal(await catalog.canSelect('openai', 'one'), false);
    models = [];
    assert.equal(await catalog.canSelect('openai', 'two'), false);
    assert.equal(calls, 3);
});

test('PiSettings rejects crafted model save without writing settings and invalidates logout reads', async t => {
    let release!: (value: Response) => void;
    const dir = mkdtempSync(join(tmpdir(), 'pibo-siwc-save-'));
    const fake = runtime({ getModel: (_p: string, id: string) => spec(id), logout: async () => {} });
    const settings = new (PiSettings as any)(dir, dir, fake, true) as PiSettings;
    t.mock.method(globalThis, 'fetch', async () => Response.json({ models: [entry('two')] }));
    try {
        await assert.rejects(settings.selectModel('openai', 'one', 'high'), /账号/);
        assert.equal(existsSync(join(dir, 'settings.json')), false);
        t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { release = resolve; }));
        const selected = settings.selectModel('openai', 'two', 'high');
        while (!release) await new Promise(r => setTimeout(r, 1));
        await settings.logout('openai'); release(Response.json({ models: [entry('two')] }));
        await assert.rejects(selected, /账号/);
    } finally { settings.close(); }
});

test('actual installed ModelRuntime resolves memory-only OAuth and SIWC never uses the legacy/API-key routes', async t => {
    let credential: Credential | undefined = { type: 'oauth', access: fixtureToken, refresh: 'qa-refresh-only', expires: Date.now()+3_600_000 };
    const credentials: CredentialStore = { read: async id => id==='openai'?credential:undefined,
        list: async () => credential?[{ providerId: 'openai', type: credential.type }]:[],
        modify: async () => { throw Error('Unexpected credential mutation'); }, delete: async () => { credential=undefined; } };
    const sdk = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    await sdk.refresh({ providers: ['openai'], allowNetwork: false });
    let calls=0;
    t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
        calls++; assert.equal(input, endpoint); assert.equal(new Headers(init.headers).get('authorization'), 'Bearer '+fixtureToken);
        return Response.json({ models: [entry('gpt-6.1-sol')] });
    });
    const adapter = new OpenAIAccountModels(sdk);
    const value = await adapter.read(sdk.getModels('openai'), true);
    assert.deepEqual(value.models.map(m => m.id), ['gpt-6.1-sol']); assert.equal(value.catalog.accountAccess, 'confirmed');
    credential = { type: 'api_key', key: 'qa-key-only' };
    safeFailure(await adapter.read(sdk.getModels('openai'), true));
    assert.equal(calls, 1);
});
