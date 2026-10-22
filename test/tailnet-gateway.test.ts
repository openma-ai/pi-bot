import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createTailnetGateway, tailnetAddress } from '../src/daemon/transports/tailnet-gateway.ts';
test('Tailnet ingress is explicit, paired, one-use, revocable; binary and WS use authenticated proxy', {
    timeout: 10000
}, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pibo-gateway-test-'));
    const daemonToken = 'a'.repeat(64);
    const runtime = createServer((req, res) => {
        if (req.url === '/readyz') {
            res.end('ready');
            return;
        }
        assert.equal(req.headers.authorization, 'Bearer ' + daemonToken);
        assert.equal(req.headers.origin, `http://127.0.0.1:${(runtime.address() as any).port}`);
        req.pipe(res);
    });
    const ws = new WebSocketServer({
        server: runtime
    });
    ws.on('connection', (client, req) => {
        assert.equal(req.headers.authorization, 'Bearer ' + daemonToken);
        client.on('message', (data, binary) => client.send(data, {
            binary
        }));
    });
    await new Promise<void>(r => runtime.listen(0, '127.0.0.1', r));
    const gateway = createTailnetGateway({
        host: '100.100.1.2', port: 4319, runtime: {
            url: `http://127.0.0.1:${(runtime.address() as any).port}`, token: daemonToken
        }, dataDir: dir
    });
    // Test sockets bind loopback only. Production wrapper binds the explicit Tailnet IP.
    await new Promise<void>(r => gateway.server.listen(0, '127.0.0.1', r));
    const port = (gateway.server.address() as any).port;
    const call = (path: string, body?: Buffer, token?: string, extra: Record<string, string> = {}) => new Promise<{
        status: number;
        body: Buffer;
    }>(resolve => {
        const req = request({
            agent: false, host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers: {
                host: '100.100.1.2:4319', ...(token ? {
                    authorization: 'Bearer ' + token
                } : {}), ...extra
            }
        }, res => {
            const chunks: Buffer[] = [];
            res.on('data', x => chunks.push(x));
            res.on('end', () => resolve({
                status: res.statusCode!, body: Buffer.concat(chunks)
            }));
        });
        req.on('error', e => {
            throw e;
        });
        req.end(body);
    });
    try {
        assert.equal((await call('/pibo/service')).status, 200);
        assert.equal((await call('/rpc')).status, 401);
        assert.equal((await call('/pibo/service', undefined, undefined, {
            origin: 'http://evil.invalid'
        })).status, 403);
        const { code } = gateway.beginPairing();
        const attempts = await Promise.all([1, 2].map(() => call('/pibo/pair', Buffer.from(JSON.stringify({
            code
        })))));
        assert.deepEqual(attempts.map(x => x.status).sort(), [200, 403]);
        const pair = JSON.parse(attempts.find(x => x.status === 200)!.body.toString());
        assert.equal((await call('/pibo/ready', undefined, pair.token)).status, 200);
        assert.notEqual(pair.token, daemonToken);
        assert.equal(pair.token.length, 64);
        assert.equal(readFileSync(join(dir, 'tailnet-devices.json'), 'utf8').includes(pair.token), false);
        const bytes = Buffer.from([0, 255, 128, 1, 2, 0]);
        const reply = await call('/api/files', bytes, pair.token);
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body, bytes);
        assert.equal((await call('http://evil.invalid/api/files', undefined, pair.token)).status, 403);
        assert.equal((await call('/tailnet/admin', undefined, pair.token)).status, 404);
        await new Promise<void>((resolve, reject) => {
            const client = new WebSocket(`ws://127.0.0.1:${port}/api/desktop/test/ws`, {
                headers: {
                    host: '100.100.1.2:4319', authorization: 'Bearer ' + pair.token
                }
            });
            client.once('error', reject);
            client.once('open', () => client.send(bytes));
            client.once('message', data => {
                assert.deepEqual(data, bytes);
                client.close();
            });
            client.once('close', () => resolve());
        });
        assert.equal(gateway.revoke(pair.deviceId), true);
        assert.equal((await call('/rpc', undefined, pair.token)).status, 401);
        gateway.beginPairing();
        for (let i = 0; i < 5; i++)
            assert.equal((await call('/pibo/pair', Buffer.from('{"code":"wrong"}'))).status, 403);
        const expired = gateway.beginPairing();
        const now = Date.now;
        Date.now = () => now() + 121000;
        try {
            assert.equal((await call('/pibo/pair', Buffer.from(JSON.stringify({
                code: expired.code
            })))).status, 403);
        }
        finally {
            Date.now = now;
        }
        const cancelled = gateway.beginPairing();
        gateway.server.once('request', () => gateway.cancelPairing());
        assert.equal((await call('/pibo/pair', Buffer.from(JSON.stringify({
            code: cancelled.code
        })))).status, 403);
    }
    finally {
        gateway.server.closeAllConnections();
        runtime.closeAllConnections();
        await gateway.close();
        ws.close();
        await new Promise<void>(r => runtime.close(() => r()));
        rmSync(dir, {
            recursive: true
        });
    }
});
test('only canonical Tailnet IPv4 listener addresses are accepted', () => {
    for (const ip of ['127.0.0.1', '0.0.0.0', '100.63.1.2', '100.128.1.2', '100.064.1.2', 'example.com'])
        assert.equal(tailnetAddress(ip), false);
    assert.equal(tailnetAddress('100.64.0.1'), true);
});
