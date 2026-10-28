import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiSettings } from '../src/daemon/pi-settings.ts';

const fixtureAccess = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`;
const token = () => Response.json({ access_token: fixtureAccess, refresh_token: 'fixture-refresh-not-real', expires_in: 3600 });
const device = () => Response.json({ device_auth_id: 'fixture-device-not-real', user_code: 'TEST-ONLY', interval: 1 });
const authorization = () => Response.json({ authorization_code: 'fixture-code-not-real', code_verifier: 'fixture-verifier-not-real' });
const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.fail('isolated OAuth step did not advance');
};
const isolated = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pibo-oauth-contract-'));
    return { dir, service: await PiSettings.create({ agentDir: dir, cwd: dir, allowModelNetwork: false }) };
};

test('installed SDK registers distinct OpenAI login methods and exports their true labels', async () => {
    const { service } = await isolated();
    try {
        const state = await service.state();
        const openai = state.providers.find(p => p.id === 'openai')!;
        const codex = state.providers.find(p => p.id === 'openai-codex')!;
        assert.deepEqual(openai.methods, ['api_key', 'oauth']);
        assert.equal((openai as any).methodLabels.oauth, 'Sign in with ChatGPT');
        assert.equal(codex.name, 'OpenAI Codex (legacy)');
        assert.deepEqual(codex.methods, ['oauth']);
        const flow = service.startLogin(codex.id, 'oauth');
        await waitFor(() => !!service.loginState(flow.id).prompt);
        const prompt = service.loginState(flow.id).prompt!;
        assert.equal(prompt.type, 'select');
        assert.deepEqual(prompt.options.map((o: any) => o.id), ['browser', 'device_code']);
        service.cancel(flow.id); // No method selected: no grant or callback listener starts.
    } finally { service.close(); }
});

test('actual SDK device flow returns HTTP control immediately, resumes by request id, and keeps tokens in runtime', async t => {
    const { PiBotDaemon } = await import('../src/daemon/core/daemon.ts');
    const { listenHttp } = await import('../src/daemon/transports/http.ts');
    const dir = mkdtempSync(join(tmpdir(), 'pibo-oauth-http-'));
    const daemon = await PiBotDaemon.create({ dataDir: join(dir, 'data'), piOptions: { agentDir: join(dir, 'pi'), cwd: dir, allowModelNetwork: false }, factory: async () => ({ run: async () => {}, close: async () => {} }) });
    const http = await listenHttp(daemon, { port: 0 });
    const realFetch = globalThis.fetch;
    let release!: (response: Response) => void;
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith(http.url + '/')) return realFetch(input, init);
        assert.equal(new URL(url).origin, 'https://auth.openai.com', 'no unmocked external network allowed');
        requests++;
        if (url.endsWith('/deviceauth/usercode')) return device();
        if (url.endsWith('/deviceauth/token')) return new Promise<Response>(resolve => { release = resolve; });
        assert.equal(new URL(url).pathname, '/oauth/token');
        return token();
    });
    const headers = { authorization: `Bearer ${http.token}`, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) => fetch(http.url + '/pi/' + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(1000) });
    const get = (id: string) => fetch(http.url + '/pi/login/' + id, { headers, signal: AbortSignal.timeout(1000) }).then(r => r.json());
    try {
        const requestId = randomUUID();
        const body = { provider: 'openai-codex', type: 'oauth', requestId };
        const start = await post('login', body);
        assert.equal(start.status, 200);
        assert.deepEqual(await start.json(), { id: requestId });
        await waitFor(() => !!daemon.piSettings!.loginState(requestId).prompt);
        // A lost POST response is recoverable with a read, without starting another grant.
        const state = await get(requestId);
        assert.equal(state.providerId, 'openai-codex');
        assert.equal(state.type, 'oauth');
        assert.deepEqual(await (await post('login', body)).json(), { id: requestId });
        assert.equal((await post('login', { ...body, provider: 'openai' })).status, 409);
        assert.equal((await post('login', { ...body, requestId: '../invalid' })).status, 400);
        const submitted = await post(`login/${requestId}/input`, { promptId: state.prompt.id, value: 'device_code' });
        assert.equal(submitted.status, 200, 'input must not await the device polling response');
        await waitFor(() => !!release);
        const pending = await get(requestId);
        assert.equal(pending.status, 'pending');
        assert.deepEqual(pending.events[0], { type: 'device_code', userCode: 'TEST-ONLY', verificationUri: 'https://auth.openai.com/codex/device', intervalSeconds: 1, expiresInSeconds: 900 });
        assert.equal(requests, 2);
        release(authorization());
        await waitFor(() => daemon.piSettings!.loginState(requestId).status === 'complete');
        const saved = JSON.parse(readFileSync(join(dir, 'pi', 'auth.json'), 'utf8'));
        assert.equal(saved['openai-codex'].access, fixtureAccess);
        assert.equal(saved['openai-codex'].refresh, 'fixture-refresh-not-real');
        const publicState = JSON.stringify({ login: await get(requestId), config: await daemon.piSettings!.state(), snapshot: daemon.snapshot(), events: daemon.log.read(0) });
        assert.ok(!publicState.includes(fixtureAccess));
        assert.ok(!publicState.includes('fixture-refresh-not-real'));
        assert.ok(!publicState.includes('fixture-device-not-real'));
        assert.deepEqual(await (await post('login', body)).json(), { id: requestId });
        assert.equal(requests, 3, 'terminal replay must not issue another OAuth grant');
    } finally { release?.(authorization()); await http.close(); await daemon.close(); }
});

test('device approval has the SDK fifteen-minute window, not the old ten-minute cancellation', async t => {
    const { service } = await isolated();
    let release!: (response: Response) => void;
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') return device();
        assert.equal(url, 'https://auth.openai.com/api/accounts/deviceauth/token');
        return new Promise<Response>(resolve => { release = resolve; });
    });
    try {
        const id = service.startLogin('openai-codex', 'oauth').id;
        await waitFor(() => !!service.loginState(id).prompt);
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        service.answer(id, service.loginState(id).prompt!.id, 'device_code');
        for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
        assert.ok(release);
        t.mock.timers.tick(600001);
        assert.equal(service.loginState(id).status, 'pending');
        t.mock.timers.tick(300000 + 30001);
        assert.equal(service.loginState(id).status, 'failed');
        assert.equal((service.loginState(id) as any).errorCode, 'loginTimeout');
        t.mock.timers.tick(15 * 60 * 1000 + 1);
        assert.throws(() => service.loginState(id), /expired/);
    } finally { service.close(); release?.(new Response(null, { status: 403 })); }
});

test('cancelling actual SDK device exchange discards a late mocked token and allows a fresh session', async t => {
    const { service, dir } = await isolated();
    let release!: (response: Response) => void;
    let grantCount = 0;
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') { grantCount++; return device(); }
        if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') return authorization();
        assert.equal(url, 'https://auth.openai.com/oauth/token');
        return new Promise<Response>(resolve => { release = resolve; });
    });
    try {
        const id = service.startLogin('openai-codex', 'oauth').id;
        await waitFor(() => !!service.loginState(id).prompt);
        service.answer(id, service.loginState(id).prompt!.id, 'device_code');
        await waitFor(() => !!release);
        service.cancel(id);
        release(token()); // Intentionally ignores AbortSignal, like a response arriving too late.
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(service.loginState(id).status, 'cancelled');
        assert.ok(!existsSync(join(dir, 'auth.json')) || !readFileSync(join(dir, 'auth.json'), 'utf8').includes(fixtureAccess));
        const next = service.startLogin('openai-codex', 'oauth').id;
        await waitFor(() => !!service.loginState(next).prompt);
        assert.notEqual(next, id);
        assert.equal(grantCount, 1, 'showing method choices must not start a new grant');
        service.cancel(next);
    } finally { service.close(); release?.(token()); }
});
