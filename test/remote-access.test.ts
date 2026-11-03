import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
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

/** Minimal in-process relay speaking alma-relay protocol 1 (JSON frames), enough for CI. */
async function fakeRelay() {
    const server = createServer((req, res) => {
        const m = req.url!.match(/^\/c\/([^/]+)(\/.*)$/);
        const agent = m && agents.get(createHash('sha256').update(m[1]!).digest('hex'));
        if (!agent) { res.writeHead(502); res.end(); return; }
        const id = 'h' + next++;
        httpWaiters.set(id, res);
        agent.send(JSON.stringify({ t: 'hreq', id, method: req.method, path: m![2], headers: {} }));
    });
    const agents = new Map<string, WebSocket>(), sockets = new Map<string, WebSocket>(), httpWaiters = new Map<string, any>();
    const seen: { bytes: number; text: boolean; data: Buffer }[] = [];
    let next = 1;
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
        const url = new URL(req.url!, 'http://x');
        if (url.pathname === '/agent') {
            ws.on('close', () => { for (const [k, v] of agents) if (v === ws) agents.delete(k); });
            ws.on('message', (d: Buffer) => {
                const f = JSON.parse(d.toString());
                if (f.t === 'register') { agents.set(f.tokenHash, ws); ws.send(JSON.stringify({ t: 'registered' })); }
                if (f.t === 'wmsg') { const c = sockets.get(f.id); c?.send(f.b !== undefined ? Buffer.from(f.b, 'base64') : f.s, { binary: f.b !== undefined }); }
                if (f.t === 'werr' || f.t === 'wclose') sockets.get(f.id)?.close();
                if (f.t === 'hres') httpWaiters.get(f.id)?.writeHead(f.status);
                if (f.t === 'hend') httpWaiters.get(f.id)?.end();
            });
            return;
        }
        const m = url.pathname.match(/^\/c\/([^/]+)(\/.*)$/);
        const agent = m && agents.get(createHash('sha256').update(m[1]!).digest('hex'));
        if (!agent) return ws.close();
        const id = 'w' + next++;
        sockets.set(id, ws);
        agent.send(JSON.stringify({ t: 'wopen', id, path: m![2] }));
        ws.on('message', (d: Buffer, binary: boolean) => {
            seen.push({ bytes: d.length, text: !binary, data: Buffer.from(d) });
            agent.send(JSON.stringify(binary ? { t: 'wmsg', id, b: d.toString('base64') } : { t: 'wmsg', id, s: d.toString() }));
        });
        ws.on('close', () => agent.send(JSON.stringify({ t: 'wclose', id })));
    }));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return { url: 'http://127.0.0.1:' + (server.address() as any).port, seen, close: () => { for (const c of wss.clients) c.terminate(); server.close(); } };
}

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
