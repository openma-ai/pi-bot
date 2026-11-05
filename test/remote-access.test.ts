import { fakeRelay } from './helpers/fake-relay.ts';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientHandshake, daemonHandshake, generateConnectCode, routeToken, routeTokenHash } from '../src/sdk/protocol/remote-e2e.ts';
import { DeviceRegistry } from '../src/daemon/remote/devices.ts';
import { RemoteConnection, decodePairingLink, pairFromLink } from '../src/sdk/remote/client.ts';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { listenHttp } from '../src/daemon/transports/http.ts';

async function handshake(clientCode: string, daemonCode: string) {
    const c = await clientHandshake(clientCode);
    const d = await daemonHandshake(daemonCode, c.hello);
    const { confirm, session: cs } = await c.finish(d.welcome);
    return { cs, ds: await d.verify(confirm) };
}

test('E2E handshake derives matching AES-GCM sessions bound to the connect code', async () => {
    const code = generateConnectCode();
    const { cs, ds } = await handshake(code, code);
    const r1 = await cs.seal('hello daemon');
    assert.ok(!Buffer.from(r1).toString().includes('hello'));
    assert.equal(await ds.openText(r1), 'hello daemon');
    assert.equal(await cs.openText(await ds.seal('hi client')), 'hi client');
    // Replay and tamper are rejected.
    await assert.rejects(ds.open(r1));
    const r2 = await cs.seal('x');
    r2[r2.length - 1] ^= 1;
    await assert.rejects(ds.open(r2));
});

test('E2E handshake fails without the connect code (relay MITM)', async () => {
    const code = generateConnectCode();
    await assert.rejects(handshake(generateConnectCode(), code), /Daemon failed authentication/);
    // A daemon-side impostor cannot fake the client confirm either.
    const c = await clientHandshake(code);
    const d = await daemonHandshake(code, c.hello);
    await assert.rejects(d.verify({ t: 'confirm', mac: 'AAAA' }), /Client failed authentication/);
});

test('route token is a one-way derivation of the code', async () => {
    const code = generateConnectCode();
    const t = await routeToken(code);
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(t, code);
    assert.equal(t, await routeToken(code));
    assert.equal(await routeTokenHash(t), createHash('sha256').update(t).digest('hex'));
});

test('device registry: single-use tickets, regeneration, revoke, rotation, provisioning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-remote-'));
    const r = new DeviceRegistry(dir);
    const old = r.issueTicket();
    const fresh = r.issueTicket();
    assert.equal(r.claim(old.ticket, 'a'), 'invalid', 'regenerating invalidates the previous code');
    const a = r.claim(fresh.display.toLowerCase(), 'a');
    assert.ok(typeof a === 'object');
    assert.equal(r.claim(fresh.ticket, 'b'), 'closed', 'tickets are single use');
    assert.equal(r.authenticate(a.token), a.deviceId);
    const rotated = r.rotateToken(a.deviceId)!;
    assert.equal(r.authenticate(a.token), undefined);
    assert.equal(r.authenticate(rotated), a.deviceId);
    const t = r.issueTicket();
    for (let i = 0; i < 5; i++) r.claim('WRONG', 'x');
    assert.equal(r.claim(t.ticket, 'x'), 'closed', 'attempt limit closes the ticket');
    const ci = 'pbd_' + Buffer.alloc(32, 7).toString('base64url');
    const ciId = r.provision(ci, 'ci')!;
    assert.equal(r.provision(ci, 'ci'), ciId, 'provisioning is idempotent');
    assert.ok(r.revoke(ciId));
    assert.equal(r.provision(ci, 'ci'), undefined, 'revoked provisioned tokens stay revoked across restarts');
    assert.equal(r.authenticate(ci), undefined);
    const code = r.connectCode;
    r.rotateConnectCode();
    assert.notEqual(r.connectCode, code);
    const store = readFileSync(join(dir, 'remote-access.json'), 'utf8');
    assert.ok(!store.includes(rotated) && !store.includes(ci), 'only token hashes are stored');
    assert.equal(new DeviceRegistry(dir).authenticate(rotated), a.deviceId, 'persists');
});

test('daemon HTTP API: pairing required locally and through the E2E relay; revoke cuts access', async () => {
    const relay = await fakeRelay();
    const dataDir = mkdtempSync(join(tmpdir(), 'pi-remote-http-'));
    const ciToken = 'pbd_' + Buffer.alloc(32, 9).toString('base64url');
    writeFileSync(join(dataDir, 'ci.token'), ciToken);
    process.env.PI_BOT_DEVICE_TOKEN_FILE = join(dataDir, 'ci.token');
    const d = await PiBotDaemon.create({ dataDir, factory: async () => ({ run: async () => {}, close: async () => {} }) } as any);
    const http = await listenHttp(d, { port: 0, remote: { relayUrl: relay.url, name: 'test-daemon', onFrame: process.env.DBG ? (f: any) => console.log('frame', f.dir, f.kind, f.bytes) : undefined } });
    delete process.env.PI_BOT_DEVICE_TOKEN_FILE;
    try {
        for (let i = 0; i < 50 && http.relayStatus !== 'registered'; i++) await new Promise(r => setTimeout(r, 20));
        assert.equal(http.relayStatus, 'registered');
        // Unpaired local clients are rejected even on loopback.
        for (const p of ['/remote/devices', '/pi/config', '/events?connection=x'])
            assert.equal((await fetch(http.url + p)).status, 401, p);
        assert.equal((await fetch(http.url + '/rpc', { method: 'POST', body: '{}' })).status, 401);
        assert.equal((await fetch(http.url + '/remote/devices', { headers: { authorization: 'Bearer pbd_' + 'x'.repeat(43) } })).status, 401);
        // Pre-provisioned CI token works.
        assert.equal((await fetch(http.url + '/remote/devices', { headers: { authorization: 'Bearer ' + ciToken } })).status, 200);
        // Relay never gets a plaintext answer.
        const plain = await fetch(relay.url + '/c/' + await routeToken(http.registry.connectCode) + '/remote/devices');
        assert.equal(plain.status, 403);
        // Pair through the relay with the link from `pair`.
        const pair = await (await fetch(http.url + '/remote/admin', { method: 'POST', headers: { authorization: 'Bearer ' + http.token }, body: JSON.stringify({ action: 'pair' }) })).json();
        assert.equal(decodePairingLink(pair.link).relay, relay.url);
        const dev = await pairFromLink(pair.link, 'phone');
        const conn = await RemoteConnection.connect({ relay: relay.url, code: dev.code });
        const unauth = await conn.fetch('/remote/devices');
        assert.equal(unauth.status, 401, 'E2E alone is not authorization');
        await unauth.text();
        const list = await conn.fetch('/remote/devices', { headers: { authorization: 'Bearer ' + dev.token } });
        assert.equal(list.status, 200);
        const body = await list.json();
        assert.equal(body.self, dev.deviceId);
        assert.ok(body.devices.some((x: any) => x.name === 'phone'));
        // Relay only saw ciphertext after the two handshake frames.
        const records = relay.seen.filter(f => !f.text);
        assert.ok(records.length > 0);
        for (const f of records) assert.ok(!f.data.includes(Buffer.from('Bearer')) && !f.data.includes(Buffer.from('/remote')));
        for (const f of relay.seen.filter(f => f.text)) assert.match(f.data.toString(), /"t":"(hello|confirm)"/);
        // Invite from a paired device, then revoke it.
        const invite = await (await conn.fetch('/remote/invite', { method: 'POST', headers: { authorization: 'Bearer ' + dev.token }, body: '{}' })).json();
        const second = await pairFromLink(invite.link, 'laptop');
        assert.equal(http.registry.list().find(x => x.id === second.deviceId)?.invitedBy, dev.deviceId);
        await (await conn.fetch('/remote/devices/revoke', { method: 'POST', headers: { authorization: 'Bearer ' + dev.token }, body: JSON.stringify({ id: second.deviceId }) })).text();
        const revoked = await conn.fetch('/remote/devices', { headers: { authorization: 'Bearer ' + second.token } });
        assert.equal(revoked.status, 401);
        await revoked.text();
        conn.close();
        // Rotating the connect code kills the old route/handshake.
        await fetch(http.url + '/remote/admin', { method: 'POST', headers: { authorization: 'Bearer ' + http.token }, body: JSON.stringify({ action: 'rotate-code' }) });
        await assert.rejects(RemoteConnection.connect({ relay: relay.url, code: dev.code }));
    } finally {
        await http.close();
        await d.close();
        relay.close();
    }
});

test('GUI host (pi-bot client): unpaired browsers get no session, cannot mint pairing codes or call /rpc', async () => {
    const { RuntimeManager } = await import('../src/daemon/transports/runtime-manager.ts');
    const { listenClientHost } = await import('../src/daemon/transports/client-host.ts');
    const { clientPairCli } = await import('../src/daemon/remote/cli.ts');
    const dir = mkdtempSync(join(tmpdir(), 'pibot-gui-host-'));
    const daemon = await PiBotDaemon.create({ dataDir: join(dir, 'data'), factory: async () => ({ run: async () => {}, close: async () => {} }) });
    const http = await listenHttp(daemon, { port: 0 });
    const local = { mode: 'local' as const, dataDir: join(dir, 'data') };
    const manager = new RuntimeManager({ file: join(dir, 'client', 'client.json'), defaults: { local, ssh: null } as any,
        open: async () => ({ url: http.url, host: new URL(http.url).host, token: http.token, close() {} }) });
    const host = await listenClientHost(manager, { port: 0, pairingDir: join(dir, 'client') });
    try {
        const active = (await manager.connect(local as any)).active!;
        const base = host.url + active.baseUrl;
        const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
        // Unpaired browser: redirected to the pairing flow, never handed a cookie or CSRF.
        for (const path of ['/', active.baseUrl + '/']) {
            const r = await fetch(host.url + path, { redirect: 'manual' });
            assert.equal(r.status, 302, path);
            assert.equal(r.headers.get('location'), '/pair');
            assert.equal(r.headers.get('set-cookie'), null);
        }
        const page = await fetch(host.url + '/pair');
        assert.equal(page.status, 200);
        assert.doesNotMatch(await page.text(), /pibot-csrf/);
        const forged = { cookie: `pibot_client_${new URL(host.url).port}=pbd_${'A'.repeat(43)}`, 'x-pibot-csrf': 'x' };
        for (const headers of [{}, forged]) {
            assert.equal((await post(base + '/remote/admin', { action: 'pair' }, headers)).status, 401, 'cannot create a daemon pairing code');
            assert.equal((await post(base + '/remote/invite', {}, headers)).status, 401);
            assert.equal((await fetch(base + '/remote/devices', { headers })).status, 401);
            assert.equal((await post(base + '/rpc', { jsonrpc: '2.0', id: 1, method: 'daemon/snapshot', params: {} }, headers)).status, 401, 'cannot call /rpc');
            assert.equal((await post(host.url + '/client/rpc', { jsonrpc: '2.0', id: 1, method: 'runtime/status', params: {} }, headers)).status, 401);
            assert.equal((await post(host.url + '/client/pair-code', {}, headers)).status, 401, 'cannot mint a GUI pairing code');
        }
        assert.equal((await post(host.url + '/client/pair', { ticket: 'AAAAA-AAAAA', name: 'x' })).status, 403);
        // Host CLI path (`pi-bot pair --client`, daemon-side bearer) mints a code; the browser claims it.
        let out = '';
        await clientPairCli(join(dir, 'client'), s => { out += s; });
        const code = out.match(/enter: (\S+)/)![1];
        const claimed = await post(host.url + '/client/pair', { ticket: code, name: 'browser' });
        assert.equal(claimed.status, 200);
        const cookie = claimed.headers.get('set-cookie')!.split(';')[0];
        assert.equal((await post(host.url + '/client/pair', { ticket: code, name: 'again' })).status, 403, 'single use');
        const index = await fetch(host.url + '/', { headers: { cookie } });
        assert.equal(index.status, 200);
        const csrf = (await index.text()).match(/name="pibot-csrf" content="([^"]+)"/)![1];
        assert.equal((await post(base + '/rpc', { jsonrpc: '2.0', id: 1, method: 'daemon/snapshot', params: {} }, { cookie })).status, 401, 'CSRF required');
        const ok = await post(base + '/rpc', { jsonrpc: '2.0', id: 1, method: 'daemon/snapshot', params: {} }, { cookie, 'x-pibot-csrf': csrf }); assert.ok(![401, 403].includes(ok.status), 'paired browser passes auth + CSRF');
        assert.equal((await post(base + '/remote/admin', { action: 'pair' }, { cookie, 'x-pibot-csrf': csrf })).status, 200, 'paired GUI may manage remote access');
        assert.equal((await post(host.url + '/client/pair-code', {}, { cookie, 'x-pibot-csrf': csrf })).status, 401, 'browsers never mint GUI codes');
        const id = host.registry.list()[0].id;
        assert.equal((await post(host.url + '/client/devices/revoke', { id }, { authorization: 'Bearer ' + host.token })).status, 200);
        assert.equal((await fetch(host.url + '/', { redirect: 'manual', headers: { cookie } })).status, 302, 'revoked browser is sent back to pairing');
        assert.equal((await post(base + '/rpc', {}, { cookie, 'x-pibot-csrf': csrf })).status, 401);
    } finally {
        await manager.close(); await host.close(); await http.close(); await daemon.close?.(); rmSync(dir, { recursive: true, force: true });
    }
});
