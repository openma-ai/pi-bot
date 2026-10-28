import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { get, Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryCredentialStore, type AuthEvent, type AuthPrompt } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiSettings } from '../src/daemon/pi-settings.ts';

// All values below are synthetic. The SDK's public authorize URL is never opened.
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const REDIRECT = 'http://127.0.0.1:1455/auth/callback'; // Protocol string only; never used as a network destination.
const CODE = 'synthetic-browser-code-not-a-grant';
const CLIENT = 'synthetic-issued-client-not-real';
const ACCESS = 'synthetic-browser-access-not-real';
const REFRESH = 'synthetic-browser-refresh-not-real';
const ID_TOKEN = 'synthetic-browser-id-token-not-real';
const token = () => Response.json({ access_token: ACCESS, refresh_token: REFRESH, id_token: ID_TOKEN,
    expires_in: 3600, scope: 'openid offline_access chatgpt.tokens.use.direct' });
const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 300; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('isolated browser OAuth contract did not advance');
};

/** Per test-process interception: no bind, request or connection ever targets real port 1455. */
function network(t: TestContext) {
    const servers: Server[] = [];
    const spareConnections: Socket[] = [];
    const exchanges: { body: URLSearchParams; signal?: AbortSignal | null; respond: (r: Response) => void }[] = [];
    let closeAllCount = 0;
    const originalListen = Server.prototype.listen;
    const originalCloseAll = Server.prototype.closeAllConnections;
    t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: any[]) {
        assert.equal(args[0], 1455, 'only the SDK callback listener may be created in this test');
        const callback = [...args].reverse().find(arg => typeof arg === 'function');
        servers.push(this);
        // Do not forward the SDK's port or ambient callback-host setting.
        return originalListen.call(this, { port: 0, host: '127.0.0.1' }, callback);
    } as typeof Server.prototype.listen);
    t.mock.method(Server.prototype, 'closeAllConnections', function (this: Server) {
        closeAllCount++;
        return originalCloseAll.call(this);
    });
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        assert.equal(url, TOKEN_URL, 'all external fetches are mocked; unexpected destinations fail closed');
        assert.equal(init?.method, 'POST');
        assert.ok(init?.body instanceof URLSearchParams);
        return new Promise<Response>(respond => exchanges.push({
            body: new URLSearchParams(init.body as URLSearchParams), signal: init.signal, respond
        }));
    });
    return {
        servers, exchanges, get closeAllCount() { return closeAllCount; },
        async spareConnection() {
            const address = servers.at(-1)!.address();
            assert.ok(address && typeof address !== 'string');
            assert.notEqual(address.port, 1455);
            const socket = connect({ host: '127.0.0.1', port: address.port });
            spareConnections.push(socket);
            await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
            return socket;
        },
        async callback(state: string, overrides: Record<string, string> = {}) {
            const server = servers.at(-1)!;
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            assert.equal(address.address, '127.0.0.1');
            assert.notEqual(address.port, 1455);
            const query = new URLSearchParams({ code: CODE, state, client_id: CLIENT, ...overrides });
            return new Promise<{ status: number; body: string }>((resolve, reject) => {
                const request = get({ hostname: '127.0.0.1', port: address.port,
                    path: '/auth/callback?' + query, agent: false }, response => {
                    let body = '';
                    response.setEncoding('utf8');
                    response.on('data', chunk => { body += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode!, body }));
                });
                request.setTimeout(1000, () => request.destroy(Error('synthetic callback timed out')));
                request.on('error', reject);
            });
        },
        async closed() { await waitFor(() => servers.length > 0 && servers.every(s => !s.listening)); },
        cleanup() { for (const socket of spareConnections) socket.destroy(); for (const s of servers) { s.close(); s.closeAllConnections(); } }
    };
}

async function sdk(t: TestContext) {
    const wire = network(t), dir = mkdtempSync(join(tmpdir(), 'pibo-browser-sdk-contract-'));
    const credentials = new InMemoryCredentialStore();
    const models = await ModelRuntime.create({ credentials, modelsPath: null,
        modelsStorePath: join(dir, 'models-store.json'), refreshOnCreate: false, allowModelNetwork: false });
    assert.equal(models.getProvider('openai')?.auth.oauth?.loginLabel, 'Sign in with ChatGPT');
    const abort = new AbortController(), events: AuthEvent[] = [];
    let manual: AuthPrompt | undefined, answer!: (value: string) => void, manualAbortCount = 0, settled = false;
    const result = models.login('openai', 'oauth', {
        signal: abort.signal, notify: event => events.push(event),
        prompt: prompt => new Promise<string>((resolve, reject) => {
            assert.equal(prompt.type, 'manual_code');
            manual = prompt;
            const cancel = () => { manualAbortCount++; reject(Error('Synthetic manual prompt aborted')); };
            answer = value => { prompt.signal?.removeEventListener('abort', cancel); resolve(value); };
            prompt.signal?.addEventListener('abort', cancel, { once: true });
            if (prompt.signal?.aborted) cancel();
        })
    }, { getDeviceId: () => '11111111-2222-4333-8444-555555555555', agentName: 'Synthetic browser contract' })
        .then(value => { settled = true; return { value, error: undefined }; },
            error => { settled = true; return { value: undefined, error }; });
    await waitFor(() => settled || (!!manual && events.some(e => e.type === 'auth_url')));
    if (settled) assert.ifError((await result).error);
    const event = events.find(e => e.type === 'auth_url')!;
    assert.equal(event.type, 'auth_url');
    const authorize = new URL(event.url);
    assert.equal(authorize.origin, 'https://auth.openai.com');
    assert.equal(authorize.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.ok(authorize.searchParams.get('state'));
    return { wire, models, credentials, events, authorize, abort, result,
        get manual() { return manual!; }, get manualAbortCount() { return manualAbortCount; },
        get settled() { return settled; }, answer: (value: string) => answer(value),
        async cleanup() { abort.abort(); for (const x of wire.exchanges) x.respond(token()); await result; wire.cleanup(); }
    };
}

function verifyExchange(wire: ReturnType<typeof network>, authorize: URL) {
    assert.equal(wire.exchanges.length, 1);
    const body = wire.exchanges[0].body;
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), CODE);
    assert.equal(body.get('client_id'), CLIENT);
    assert.equal(body.get('redirect_uri'), REDIRECT);
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), authorize.searchParams.get('code_challenge'));
}
function publicOnly(value: unknown, verifier?: string) {
    const text = JSON.stringify(value);
    for (const secret of [ACCESS, REFRESH, ID_TOKEN, CODE, CLIENT, ...(verifier ? [verifier] : [])])
        assert.ok(!text.includes(secret), 'public metadata must not expose token, callback input or verifier');
}

test('actual Pi browser SDK races callback with manual fallback and cleans the unused prompt after exchange', async t => {
    const h = await sdk(t);
    try {
        assert.equal(h.manual.type, 'manual_code');
        assert.equal(h.manual.placeholder, REDIRECT);
        assert.equal(h.settled, false);
        assert.equal(h.wire.exchanges.length, 0, 'showing both choices must not request a token');
        const spare = await h.wire.spareConnection();
        assert.equal((await h.wire.callback('synthetic-wrong-state')).status, 400);
        assert.equal(h.wire.exchanges.length, 0, 'invalid callback state must not consume the flow');
        assert.equal(h.manual.signal?.aborted, false);
        assert.equal((await h.wire.callback(h.authorize.searchParams.get('state')!)).status, 200);
        await waitFor(() => h.wire.exchanges.length === 1);
        verifyExchange(h.wire, h.authorize);
        assert.equal(h.events.at(-1)?.type, 'progress');
        assert.equal(h.settled, false, 'progress is exchanging, not successful login');
        assert.equal(h.manual.signal?.aborted, false, 'Pi 1.2.0 aborts the unused prompt in finally, after exchange');
        assert.equal(await h.credentials.read('openai'), undefined);
        h.wire.exchanges[0].respond(token());
        const done = await h.result;
        assert.ifError(done.error);
        assert.equal((done.value as any).access, ACCESS);
        assert.equal((await h.credentials.read('openai') as any).refresh, REFRESH);
        assert.equal(h.manual.signal?.aborted, true);
        assert.equal(h.manualAbortCount, 1);
        await h.wire.closed();
        await waitFor(() => spare.destroyed);
        assert.equal(h.wire.closeAllCount, 1, 'SDK closes spare browser connections as well as the listener');
        publicOnly({ events: h.events, credentials: await h.models.listCredentials() }, h.wire.exchanges[0].body.get('code_verifier')!);
    } finally { await h.cleanup(); }
});

test('actual Pi browser SDK accepts a synthetic manual callback URL without an HTTP callback', async t => {
    const h = await sdk(t);
    try {
        h.answer(REDIRECT + '?' + new URLSearchParams({ code: CODE, state: h.authorize.searchParams.get('state')!, client_id: CLIENT }));
        await waitFor(() => h.wire.exchanges.length === 1);
        verifyExchange(h.wire, h.authorize);
        assert.equal(h.events.at(-1)?.type, 'progress');
        h.wire.exchanges[0].respond(token());
        assert.ifError((await h.result).error);
        assert.equal((await h.credentials.read('openai') as any).clientId, CLIENT);
        assert.equal(h.manual.signal?.aborted, true);
        await h.wire.closed();
        assert.equal(h.wire.closeAllCount, 1);
        publicOnly(h.events);
    } finally { await h.cleanup(); }
});

test('cancelling the actual SDK browser wait closes callback and manual paths without a token request', async t => {
    const h = await sdk(t);
    try {
        h.abort.abort();
        assert.ok((await h.result).error);
        assert.equal(h.wire.exchanges.length, 0);
        assert.equal(h.manual.signal?.aborted, true);
        assert.equal(await h.credentials.read('openai'), undefined);
        await h.wire.closed();
        assert.equal(h.wire.closeAllCount, 1);
    } finally { await h.cleanup(); }
});

test('cancelling actual browser token exchange discards a late mocked response rather than saving credentials', async t => {
    const h = await sdk(t);
    try {
        await h.wire.callback(h.authorize.searchParams.get('state')!);
        await waitFor(() => h.wire.exchanges.length === 1);
        assert.equal(h.events.at(-1)?.type, 'progress');
        h.abort.abort();
        assert.equal(h.wire.exchanges[0].signal?.aborted, true);
        h.wire.exchanges[0].respond(token()); // Deliberately ignores AbortSignal, simulating a response already in flight.
        assert.ok((await h.result).error);
        assert.equal(await h.credentials.read('openai'), undefined);
        assert.deepEqual(await h.models.listCredentials(), []);
        assert.equal(h.manual.signal?.aborted, true);
        await h.wire.closed();
        publicOnly(h.events);
    } finally { await h.cleanup(); }
});

test('PiSettings browser exchange stays pending and hides synthetic callback/token errors from public state', async t => {
    const wire = network(t), dir = mkdtempSync(join(tmpdir(), 'pibo-browser-public-contract-'));
    const service = await PiSettings.create({ agentDir: dir, cwd: dir });
    const id = service.startLogin('openai', 'oauth', randomUUID()).id;
    try {
        await waitFor(() => !!service.loginState(id).prompt && service.loginState(id).events.some(e => e.type === 'auth_url'));
        const initial = service.loginState(id), event = initial.events.find(e => e.type === 'auth_url')!;
        assert.equal(event.type, 'auth_url');
        assert.equal(initial.prompt?.type, 'manual_code');
        await wire.callback(new URL(event.url).searchParams.get('state')!);
        await waitFor(() => wire.exchanges.length === 1);
        const exchanging = service.loginState(id);
        assert.equal(exchanging.status, 'pending');
        assert.equal(exchanging.events.at(-1)?.type, 'progress');
        const stored = existsSync(join(dir, 'auth.json')) ? JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')) : {};
        assert.equal(stored.openai, undefined, 'an initialized empty auth store is not a completed credential');
        publicOnly({ login: exchanging, config: await service.state() }, wire.exchanges[0].body.get('code_verifier')!);
        wire.exchanges[0].respond(new Response(`${ACCESS} ${REFRESH} ${CODE}`, { status: 400 }));
        await waitFor(() => service.loginState(id).status === 'failed' && !service.loginState(id).prompt);
        const failed = service.loginState(id);
        assert.equal(failed.error, 'Pi 登录未完成，请重试');
        publicOnly({ login: failed, config: await service.state() });
        assert.ok(!existsSync(join(dir, 'auth.json')) || !readFileSync(join(dir, 'auth.json'), 'utf8').includes(ACCESS));
        await wire.closed();
        assert.equal(wire.closeAllCount, 1);
    } finally { service.close(); for (const x of wire.exchanges) x.respond(token()); wire.cleanup(); }
});

test('PiSettings browser cancellation remains terminal after a late synthetic token response', async t => {
    const wire = network(t), dir = mkdtempSync(join(tmpdir(), 'pibo-browser-cancel-contract-'));
    const service = await PiSettings.create({ agentDir: dir, cwd: dir });
    let loginCompletions = 0;
    service.onLogin = async () => { loginCompletions++; };
    const id = service.startLogin('openai', 'oauth').id;
    try {
        await waitFor(() => !!service.loginState(id).prompt && service.loginState(id).events.some(e => e.type === 'auth_url'));
        const event = service.loginState(id).events.find(e => e.type === 'auth_url')!;
        assert.equal(event.type, 'auth_url');
        await wire.callback(new URL(event.url).searchParams.get('state')!);
        await waitFor(() => wire.exchanges.length === 1);
        service.cancel(id);
        assert.equal(service.loginState(id).status, 'cancelled');
        assert.equal(service.loginState(id).prompt, undefined);
        assert.equal(wire.exchanges[0].signal?.aborted, true);
        wire.exchanges[0].respond(token());
        await wire.closed();
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(service.loginState(id).status, 'cancelled');
        assert.equal(loginCompletions, 0);
        const stored = existsSync(join(dir, 'auth.json')) ? JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')) : {};
        assert.equal(stored.openai, undefined);
        publicOnly({ login: service.loginState(id), config: await service.state() }, wire.exchanges[0].body.get('code_verifier')!);
    } finally { service.close(); for (const x of wire.exchanges) x.respond(token()); wire.cleanup(); }
});
