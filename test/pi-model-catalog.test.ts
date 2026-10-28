import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Credential, CredentialStore, ModelsStore, ModelsStoreEntry, Provider } from '@earendil-works/pi-ai';
import { getBuiltinModelDataGeneratedAt } from '@earendil-works/pi-ai/providers/all';
import { PiModelCatalog } from '../src/daemon/pi-model-catalog.ts';
import { PiSettings } from '../src/daemon/pi-settings.ts';

const sdkBase = new URL('.', import.meta.resolve('@earendil-works/pi-coding-agent'));
const fakeOAuth = (): Credential => ({ type: 'oauth', access: 'qa-access-not-real', refresh: 'qa-refresh-not-real', expires: Date.now() + 3_600_000 });
class MemoryCredentials implements CredentialStore {
    constructor(public data: Record<string, Credential> = {}) {}
    async read(id: string) { return this.data[id]; }
    async list() { return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type })); }
    async modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
        const credential = await fn(this.data[id]);
        if (credential) this.data[id] = credential;
        return credential;
    }
    async delete(id: string) { delete this.data[id]; }
}
class MemoryCatalogs implements ModelsStore {
    data = new Map<string, ModelsStoreEntry>();
    async read(id: string) { return this.data.get(id); }
    async write(id: string, value: ModelsStoreEntry) { this.data.set(id, structuredClone(value)); }
    async delete(id: string) { this.data.delete(id); }
}
async function sdk(credentials = new MemoryCredentials({ openai: fakeOAuth() }), store = new MemoryCatalogs()) {
    return ModelRuntime.create({ credentials, modelsPath: null, modelsStore: store, refreshOnCreate: false, allowModelNetwork: false });
}
// Keep real SDK methods but restrict test probes to synthetic providers/credentials.
// This avoids inspecting ambient cloud credentials for unrelated built-in providers.
function only(runtime: ModelRuntime, id = 'openai'): ModelRuntime {
    return new Proxy(runtime, { get(target, property) {
        if (property === 'refresh') return (options: any) => target.refresh({ ...options, providers: [id] });
        if (property === 'getAvailable') return (provider: string | undefined, options: any) => target.getAvailable(provider ?? id, options);
        if (property === 'getProviders') return () => target.getProviders().filter(p => p.id === id);
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}
function service(runtime: ModelRuntime, allowNetwork = false) {
    const dir = mkdtempSync(join(tmpdir(), 'pibo-model-catalog-'));
    // Use the real service with an isolated, injected SDK runtime; no user's auth file.
    return { dir, settings: new (PiSettings as any)(dir, dir, runtime, allowNetwork) as PiSettings };
}
const ids = (models: readonly { id: string }[]) => models.map(m => m.id);

test('real Pi SDK OpenAI OAuth availability does not invent account-level model entitlement', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
    const credentials = new MemoryCredentials({ openai: fakeOAuth() });
    const runtime = await sdk(credentials);
    await runtime.refresh({ providers: ['openai'], allowNetwork: false });
    const raw = ids(runtime.getModels('openai'));
    const available = ids(await runtime.getAvailable('openai'));
    assert.equal(raw.length, 44, 'Pi 1.2.0 installed catalog contract');
    assert.deepEqual(available, raw);
    assert.deepEqual(ids(runtime.getAvailableSnapshot()), raw);
    for (const id of ['gpt-4', 'gpt-4-turbo', 'gpt-4.1', 'gpt-6.1-sol']) assert.ok(available.includes(id));
    credentials.data.openai = { type: 'api_key', key: 'qa-key-not-real' };
    assert.deepEqual(ids(await runtime.getAvailable('openai')), available, 'no fake OAuth model-name filter');
    assert.equal(runtime.getProvider('openai')!.baseUrl, 'https://api.openai.com/v1');
    assert.equal(runtime.getProvider('openai-codex')!.baseUrl, 'https://chatgpt.com/backend-api');
    assert.equal(runtime.getProvider('openai')!.filterModels, undefined);
});

test('real Pi TUI renders old models in all scope; only explicit scope/search/current ordering changes display', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
    const { ModelSelectorComponent } = await import(new URL('modes/interactive/components/model-selector.js', sdkBase).href);
    const { initTheme } = await import(new URL('modes/interactive/theme/theme.js', sdkBase).href);
    initTheme('dark');
    const runtime = only(await sdk());
    const refresh = runtime.refresh;
    const local = new Proxy(runtime, { get(target, property) {
        return property === 'refresh' ? (options: any) => refresh({ ...options, allowNetwork: false }) : Reflect.get(target, property);
    } });
    await local.refresh();
    const create = (current?: any, scope: any[] = [], search?: string) => new ModelSelectorComponent(
        { requestRender() {} }, current, local, scope, () => {}, () => {}, search);
    const all = create();
    const current = create(runtime.getModel('openai', 'gpt-6.1-sol'));
    const scoped = create(undefined, [{ model: runtime.getModel('openai', 'gpt-6.1-sol') }]);
    const search = create(undefined, [], 'gpt-4');
    try {
        assert.equal(all.scope, 'all');
        assert.equal(all.filteredModels.length, 44);
        assert.match(all.render(100).join('\n'), /gpt-4-turbo/);
        assert.equal(current.filteredModels[0].id, 'gpt-6.1-sol');
        assert.match(current.render(100).join('\n'), /gpt-4-turbo/);
        assert.equal(scoped.scope, 'scoped');
        assert.deepEqual(ids(scoped.filteredModels), ['gpt-6.1-sol']);
        assert.ok(!scoped.render(100).join('\n').includes('gpt-4-turbo'));
        assert.ok(search.filteredModels.length < 44);
    } finally { for (const selector of [all, current, scoped, search]) selector.dispose(); }
});

test('cache-only OAuth cannot turn the public SDK catalog into account-confirmed choices', async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Unexpected network'); });
    const runtime = only(await sdk());
    const { settings } = service(runtime);
    try {
        const state = await settings.state();
        const openai = state.providers[0];
        assert.deepEqual(openai.models, []);
        assert.equal(openai.configured, true);
        assert.equal(openai.credential, 'oauth');
        assert.equal(openai.catalog!.authChecked, true);
        assert.equal(state.catalog.status, 'failed');
        assert.equal(state.catalog.source, 'openai-account');
        assert.equal(state.catalog.accountAccess, 'unverified');
        assert.ok(!JSON.stringify(state).includes('qa-access-not-real'));
        assert.equal(requests, 0);
    } finally { settings.close(); }
});

test('real SDK refresh loads public pi.dev overlay, then SDK cache; no provider model inference request', async t => {
    const store = new MemoryCatalogs();
    const credentials = new MemoryCredentials({ openai: { type: 'api_key', key: 'qa-key-only' } });
    const runtime = only(await sdk(credentials, store));
    const fixture = { ...runtime.getModel('openai', 'gpt-6.1-sol')!, id: 'qa-future-model', name: 'QA future model' };
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        requests++;
        const url = new URL(String(input));
        assert.equal(url.origin, 'https://pi.dev');
        assert.equal(url.pathname, '/api/models/providers/openai');
        assert.equal(url.searchParams.get('types'), 'chat,image,classifier');
        assert.equal(new Headers(init?.headers).get('authorization'), null);
        return Response.json([fixture], { headers: { 'last-modified': new Date((getBuiltinModelDataGeneratedAt() ?? Date.now()) + 86_400_000).toUTCString(), etag: '"qa-only"' } });
    });
    const catalog = new PiModelCatalog(runtime, { allowNetwork: true });
    const first = await catalog.refresh();
    assert.ok(ids(first.models).includes('qa-future-model'));
    assert.ok(ids(first.models).includes('gpt-4'), 'SDK merges; it does not delete old names');
    assert.equal(first.catalog.status, 'refreshed');
    assert.equal(first.catalog.accountAccess, 'unverified');
    assert.equal(requests, 1);
    await catalog.refresh();
    assert.equal(requests, 1, 'SDK freshness window controls revalidation');
    const restored = new PiModelCatalog(only(await sdk(credentials, store)), { allowNetwork: false });
    const cached = await restored.refresh();
    assert.ok(ids(cached.models).includes('qa-future-model'));
    assert.equal(cached.catalog.status, 'cached');
    assert.equal(requests, 1);
});

test('provider policy is shared by returned model list and server-side selection', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
    const credentials = new MemoryCredentials({ 'qa-policy': fakeOAuth() });
    const runtime = await sdk(credentials);
    const base = runtime.getModel('openai', 'gpt-6.1-sol')!;
    const provider: Provider = {
        ...runtime.getProvider('openai')!, id: 'qa-policy', name: 'QA policy', refreshModels: undefined,
        getModels: () => ['allowed', 'excluded'].map(id => ({ ...base, provider: 'qa-policy', id })),
        filterModels: (models, credential) => credential?.type === 'oauth' ? models.filter(m => m.id === 'allowed') : models
    };
    runtime.registerNativeProvider(provider);
    const { dir, settings } = service(only(runtime, 'qa-policy'));
    try {
        const state = await settings.state();
        assert.deepEqual(ids(state.providers[0].models), ['allowed']);
        await assert.rejects(settings.selectModel('qa-policy', 'excluded', 'high'), /SDK/);
        await settings.selectModel('qa-policy', 'allowed', 'high');
        assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).defaultModel, 'allowed');
        delete credentials.data['qa-policy'];
        await assert.rejects(settings.selectModel('qa-policy', 'allowed', 'high'), /SDK/);
    } finally { settings.close(); }
});

test('configured non-stored auth remains usable without fabricating a stored credential', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
    const runtime = await sdk(new MemoryCredentials());
    const base = runtime.getModel('openai', 'gpt-6.1-sol')!;
    runtime.registerNativeProvider({
        ...runtime.getProvider('openai')!, id: 'qa-environment', name: 'QA environment', refreshModels: undefined,
        getModels: () => [{ ...base, id: 'qa-model', provider: 'qa-environment' }],
        auth: { apiKey: { name: 'QA configuration', check: async () => ({ type: 'api_key', source: 'QA environment' }), resolve: async () => ({ auth: { apiKey: 'qa-only' } }) } }
    });
    const { settings } = service(only(runtime, 'qa-environment'));
    try {
        const provider = (await settings.state()).providers[0];
        assert.equal(provider.credential, null);
        assert.equal(provider.configured, true);
        assert.deepEqual(ids(provider.models), ['qa-model']);
    } finally { settings.close(); }
});

function fakeRuntime(overrides: Record<string, any> = {}): any {
    return {
        refresh: async () => ({ aborted: false, errors: new Map() }),
        getAvailable: async () => [{ provider: 'qa', id: 'cached-model' }],
        getProviders: () => [{ id: 'qa' }], hasConfiguredAuth: () => true, getError: () => undefined, isUsingOAuth: () => false, ...overrides
    };
}

test('refresh failures retain authenticated cache, sanitize errors, and remain unverified', async () => {
    const catalog = new PiModelCatalog(fakeRuntime({ refresh: async () => ({ aborted: false, errors: new Map([['qa', new Error('do-not-leak-sensitive-provider-response')]]) }) }));
    const value = await catalog.refresh();
    assert.equal(value.catalog.status, 'partial');
    assert.equal(value.providers.get('qa')!.catalog.status, 'failed');
    assert.deepEqual(ids(value.models), ['cached-model']);
    assert.equal(value.catalog.accountAccess, 'unverified');
    assert.ok(!JSON.stringify(value).includes('do-not-leak'));
});

test('bounded refresh timeout retains independently checked cache and concurrent reads coalesce', async () => {
    let refreshes = 0;
    const catalog = new PiModelCatalog(fakeRuntime({ refresh: () => { refreshes++; return new Promise(() => {}); } }), { refreshTimeoutMs: 15 });
    const first = catalog.refresh();
    const second = catalog.refresh();
    assert.equal(first, second);
    const value = await first;
    assert.equal(refreshes, 1);
    assert.equal(value.catalog.status, 'partial');
    assert.equal(value.providers.get('qa')!.catalog.status, 'failed');
    assert.deepEqual(ids(value.models), ['cached-model']);
});

test('auth check failure cannot expose a stale selectable snapshot and selection is bounded', async () => {
    const catalog = new PiModelCatalog(fakeRuntime({ getAvailable: () => new Promise(() => {}) }), { authTimeoutMs: 15 });
    const value = await catalog.refresh();
    assert.equal(value.catalog.status, 'failed');
    assert.equal(value.providers.get('qa')!.catalog.authChecked, false);
    assert.equal(value.providers.get('qa')!.configured, false);
    assert.deepEqual(value.models, []);
    assert.equal(await catalog.canSelect('qa', 'cached-model'), false);
});

test('SDK models.json composition errors are not mislabeled as a successful refresh', async () => {
    const value = await new PiModelCatalog(fakeRuntime({ getError: () => 'invalid provider configuration' })).refresh();
    assert.equal(value.catalog.status, 'partial');
    assert.equal(value.providers.get('qa')!.catalog.status, 'failed');
});
