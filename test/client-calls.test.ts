import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientCallHub } from '../src/daemon/client-calls/hub.ts';
import { ClientCallRunner, httpCallFetch } from '../src/sdk/client-calls.ts';
import { RemoteConnection, pairFromLink } from '../src/sdk/remote/client.ts';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { listenHttp } from '../src/daemon/transports/http.ts';
import { fakeRelay } from './helpers/fake-relay.ts';

const sinkOf = () => {
    const lines: any[] = [];
    let closed = false;
    return { lines, get closed() { return closed; }, sink: { write: (l: string) => { lines.push(JSON.parse(l)); return true; }, close: () => { closed = true; } } };
};
const calls = (s: ReturnType<typeof sinkOf>) => s.lines.filter(l => l.t === 'call');
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };

test('hub: default deny, explicit target, capability check', async () => {
    const hub = new ClientCallHub();
    assert.deepEqual(await hub.call('local', 'fs/read', {}), { status: 'error', code: 'METHOD_NOT_ALLOWED', message: 'fs/read is not on the allowlist', notSent: true });
    hub.setAllowlist(['fs/read', 'shell/exec']);
    const s = sinkOf();
    hub.attach('local', { after: 0, capabilities: ['fs/read'] }, s.sink);
    const r = await hub.call('local', 'shell/exec', {});
    assert.equal(r.status === 'error' && r.code, 'CAPABILITY_MISSING');
    const p = hub.call('local', 'fs/read', { path: '/x' }, { id: 'a' });
    assert.equal(calls(s)[0].method, 'fs/read');
    hub.receive('local', { ack: 1, results: [{ id: 'a', ok: true, result: 'data' }] });
    assert.deepEqual(await p, { status: 'ok', result: 'data' });
    // A different target is independent.
    assert.equal(hub.presence('device:other'), 'unknown');
    hub.close();
});

test('hub: presence tri-state; unknown waits, offline fails fast', async () => {
    const hub = new ClientCallHub({ allow: ['m'] });
    const seen: string[] = [];
    hub.on('presence', e => seen.push(e.presence));
    const waiting = hub.call('c', 'm', {}, { id: 'w', timeoutMs: 2000 });
    const s = sinkOf();
    const detach = hub.attach('c', { after: 0, capabilities: ['m'] }, s.sink);
    assert.equal(calls(s)[0].id, 'w', 'queued call delivered on attach');
    hub.receive('c', { results: [{ id: 'w', ok: true, result: 1 }] });
    assert.equal((await waiting).status, 'ok');
    detach();
    assert.equal(hub.presence('c'), 'offline');
    const r = await hub.call('c', 'm', {});
    assert.equal(r.status === 'error' && r.code, 'DEVICE_OFFLINE');
    assert.deepEqual(seen, ['online', 'offline']);
    // Never-seen client: waits then fails as not sent.
    const never = await hub.call('ghost', 'm', {}, { timeoutMs: 30 });
    assert.equal(never.status === 'error' && never.notSent, true);
    hub.close();
});

test('hub: unacked frames replay on re-attach after the acked seq; results deduped', async () => {
    const hub = new ClientCallHub({ allow: ['m'] });
    const s1 = sinkOf();
    const d1 = hub.attach('c', { after: 0, capabilities: ['m'] }, s1.sink);
    const p1 = hub.call('c', 'm', 1, { id: 'one' }), p2 = hub.call('c', 'm', 2, { id: 'two' }), p3 = hub.call('c', 'm', 3, { id: 'three' });
    hub.receive('c', { ack: 1 });
    d1();
    const s2 = sinkOf();
    hub.attach('c', { after: 2, capabilities: ['m'] }, s2.sink);
    assert.deepEqual(calls(s2).map(c => c.id), ['three'], 'only frames after the client cursor are replayed');
    assert.equal(s2.lines[0].t, 'hello');
    hub.receive('c', { ack: 3, results: [{ id: 'one', ok: true, result: 1 }, { id: 'two', ok: true, result: 2 }, { id: 'three', ok: false, error: { code: 'X', message: 'nope' } }] });
    hub.receive('c', { results: [{ id: 'one', ok: true, result: 'dup' }] });
    assert.deepEqual(await p1, { status: 'ok', result: 1 });
    assert.equal((await p2).status, 'ok');
    assert.deepEqual(await p3, { status: 'error', code: 'X', message: 'nope', notSent: false });
    hub.close();
});

test('hub: backpressure cap fails fast without sending', async () => {
    const hub = new ClientCallHub({ allow: ['m'], limits: { maxUnacked: 2 } });
    const s = sinkOf();
    hub.attach('c', { after: 0, capabilities: ['m'] }, s.sink);
    void hub.call('c', 'm', {}, { timeoutMs: 1000 }); void hub.call('c', 'm', {}, { timeoutMs: 1000 });
    const r = await hub.call('c', 'm', {});
    assert.deepEqual([r.status, (r as any).code, (r as any).notSent], ['error', 'BACKPRESSURE', true]);
    assert.equal(calls(s).length, 2);
    hub.receive('c', { ack: 2 });
    const big = await hub.call('c', 'm', 'x'.repeat(2 * 1024 * 1024));
    assert.equal((big as any).code, 'FRAME_TOO_LARGE');
    hub.close();
});

test('hub: timeout is not cancellation (effect unknown, late result surfaced)', async () => {
    const hub = new ClientCallHub({ allow: ['m'] });
    const s = sinkOf();
    hub.attach('c', { after: 0, capabilities: ['m'] }, s.sink);
    const late: any[] = [];
    hub.on('lateResult', r => late.push(r));
    const r = await hub.call('c', 'm', {}, { id: 'slow', timeoutMs: 20 });
    assert.deepEqual(r, { status: 'timeout', effect: 'unknown' });
    assert.ok(s.lines.some(l => l.t === 'cancel' && l.id === 'slow'), 'best-effort cancel sent');
    hub.receive('c', { results: [{ id: 'slow', ok: true, result: 'did it anyway' }] });
    assert.equal(late[0].result, 'did it anyway');
    hub.close();
});

test('runner: default deny, ack-before-complete, never runs an id twice', async () => {
    const hub = new ClientCallHub({ allow: ['echo', 'secret'] });
    let runs = 0;
    const posts: any[] = [];
    let feed: ((line: string) => void) | undefined, end: (() => void) | undefined;
    const fetchFn = async (path: string, init: any = {}) => {
        if (path.startsWith('/client-calls/attach')) {
            const q = new URL('http://x' + path).searchParams;
            const queue: Uint8Array[] = []; let wake: (() => void) | undefined; let ended = false;
            const detach = hub.attach('c', { after: Number(q.get('after')), capabilities: q.get('caps')!.split(',') }, { write: l => { queue.push(new TextEncoder().encode(l)); wake?.(); return true; }, close: () => { ended = true; wake?.(); } });
            feed = l => { queue.push(new TextEncoder().encode(l)); wake?.(); };
            end = () => { ended = true; detach(); wake?.(); };
            init.signal?.addEventListener('abort', () => end!());
            return { status: 200, text: async () => '', chunks: (async function* () { while (true) { if (queue.length) { yield queue.shift()!; continue; } if (ended) return; await new Promise<void>(r => (wake = r)); wake = undefined; } })() };
        }
        const body = JSON.parse(init.body);
        posts.push(body);
        hub.receive('c', body);
        return { status: 200, text: async () => '{}' };
    };
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const runner = new ClientCallRunner({ fetch: fetchFn, handlers: { echo: async (p) => { runs++; await gate; return p; } }, backoff: { minMs: 10, maxMs: 20 } }).start();
    await until(() => hub.presence('c') === 'online');
    assert.equal((await hub.call('c', 'secret', {})).status, 'error', 'undeclared method rejected by hub');
    const p = hub.call('c', 'echo', { v: 1 }, { id: 'e1' });
    await until(() => posts.some(b => b.ack === 1));
    assert.equal(runs, 1);
    // Duplicate delivery of the same id (e.g. replay after a lost ack) does not re-run.
    feed!(JSON.stringify({ t: 'call', seq: 2, id: 'e1', method: 'echo', params: { v: 1 }, deadline: 0 }) + '\n');
    // A method the client never registered: refused locally.
    feed!(JSON.stringify({ t: 'call', seq: 3, id: 'x', method: 'rm-rf', params: {}, deadline: 0 }) + '\n');
    await until(() => posts.some(b => b.results?.some((r: any) => r.id === 'x' && r.error?.code === 'METHOD_NOT_ALLOWED')));
    release();
    assert.deepEqual(await p, { status: 'ok', result: { v: 1 } });
    assert.equal(runs, 1);
    // The two hand-injected frames used seq 2-3; keep the hub's counter consistent with them.
    (hub as any).clients.get('c').seq = 3;
    // Reconnect resumes from the client's cursor.
    end!();
    await until(() => hub.presence('c') === 'online' && runner.state === 'online');
    assert.equal((await hub.call('c', 'echo', 'again')).status, 'ok');
    assert.equal(runs, 2);
    await runner.stop();
    hub.close();
});

test('e2e: fake client serves calls over loopback and through the real E2E relay path', async () => {
    const relay = await fakeRelay();
    const dataDir = mkdtempSync(join(tmpdir(), 'pi-client-calls-'));
    const d = await PiBotDaemon.create({ dataDir, factory: async () => ({ run: async () => {}, close: async () => {} }) } as any);
    const http = await listenHttp(d, { port: 0, remote: { relayUrl: relay.url, name: 'cc-test' }, clientCalls: { allow: ['test/echo', 'test/whoami'] } });
    const runners: ClientCallRunner[] = [];
    let conn: RemoteConnection | undefined;
    try {
        // Unauthenticated attach is refused.
        assert.equal((await fetch(http.url + '/client-calls/attach')).status, 401);
        // Same-machine loopback with the host credential => target `local`.
        runners.push(new ClientCallRunner({ fetch: httpCallFetch(http.url, http.token), handlers: { 'test/echo': p => ({ local: p }) } }).start());
        await until(() => http.clientCalls.presence('local') === 'online');
        assert.deepEqual(await http.clientCalls.call('local', 'test/echo', 7), { status: 'ok', result: { local: 7 } });
        assert.equal((await http.clientCalls.call('local', 'test/whoami', {}) as any).code, 'CAPABILITY_MISSING');
        assert.equal((await http.clientCalls.call('local', 'shell/exec', {}) as any).code, 'METHOD_NOT_ALLOWED');

        // Remote device through the relay: pair, open the E2E tunnel, attach.
        await until(() => http.relayStatus === 'registered');
        const pair = await (await fetch(http.url + '/remote/admin', { method: 'POST', headers: { authorization: 'Bearer ' + http.token }, body: JSON.stringify({ action: 'pair' }) })).json();
        const dev = await pairFromLink(pair.link, 'laptop');
        conn = await RemoteConnection.connect({ relay: relay.url, code: dev.code });
        const c = conn;
        const auth = { authorization: 'Bearer ' + dev.token };
        runners.push(new ClientCallRunner({ fetch: (path, init = {}) => c.fetch(path, { method: init.method, headers: { ...init.headers, ...auth }, body: init.body }), handlers: { 'test/whoami': () => 'remote-laptop' } }).start());
        const target = 'device:' + dev.deviceId;
        await until(() => http.clientCalls.presence(target) === 'online', 5000);
        assert.deepEqual(await http.clientCalls.call(target, 'test/whoami', {}), { status: 'ok', result: 'remote-laptop' });
        // Relay saw ciphertext only.
        for (const f of relay.seen.filter(f => !f.text)) assert.ok(!f.data.includes(Buffer.from('test/whoami')));
        // Revoking the device drops it to offline; calls fail fast.
        await (await fetch(http.url + '/remote/devices/revoke', { method: 'POST', headers: { authorization: 'Bearer ' + http.token }, body: JSON.stringify({ id: dev.deviceId }) })).text();
        assert.equal(http.clientCalls.presence(target), 'offline');
        assert.equal((await http.clientCalls.call(target, 'test/whoami', {}) as any).code, 'DEVICE_OFFLINE');
    } finally {
        for (const r of runners) void r.stop();
        conn?.close();
        await http.close();
        await d.close();
        relay.close();
    }
});
