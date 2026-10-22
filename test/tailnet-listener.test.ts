import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailnetListenerOptions } from '../src/daemon/transports/tailnet-listener.ts';
import { tailnetBindAddress, listenTailnetGateway } from '../src/daemon/transports/tailnet-gateway.ts';
test('Serve forwarding is explicit and never accepts a wildcard or arbitrary fallback', () => {
    assert.equal(tailnetListenerOptions([]), undefined);
    const ordinary = tailnetListenerOptions(['--tailnet-listen', '100.100.1.2:4319'])!;
    assert.equal(tailnetBindAddress(ordinary), '100.100.1.2');
    const forwarded = tailnetListenerOptions(['--tailnet-listen', '100.100.1.2:4319', '--tailnet-serve-loopback'])!;
    assert.equal(tailnetBindAddress(forwarded), '127.0.0.1');
    assert.equal(forwarded.host, '100.100.1.2');
    for (const args of [['--tailnet-serve-loopback'], ['--tailnet-listen'], ['--tailnet-listen', '0.0.0.0:4319'], ['--tailnet-listen', '127.0.0.1:4319', '--tailnet-serve-loopback'], ['--tailnet-listen', '100.100.1.999:4319'], ['--tailnet-listen', '100.100.1.2:0'], ['--tailnet-listen', '100.100.1.2:04319'], ['--tailnet-listen', '100.100.1.2:65536'], ['--tailnet-listen', '100.100.1.2:4319', '--tailnet-serve-loopback=0.0.0.0'], ['--tailnet-listen', '100.100.1.2:4319', '--tailnet-listen', '100.100.1.3:4319']])
        assert.throws(() => tailnetListenerOptions(args), args.join(' '));
    assert.throws(() => tailnetBindAddress({
        host: '100.100.1.2', port: 4319, listenMode: 'wildcard' as any
    }));
});
test('production Serve-loopback listener binds localhost and still requires the advertised Tailnet Host', async () => {
    const reserve = createServer();
    await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
    const port = (reserve.address() as any).port;
    await new Promise<void>(r => reserve.close(() => r()));
    const dir = mkdtempSync(join(tmpdir(), 'pibo-forward-test-'));
    const gateway = await listenTailnetGateway({
        host: '100.100.1.2', port, listenMode: 'serve-loopback', runtime: {
            url: 'http://127.0.0.1:1/', token: 'a'.repeat(64)
        }, dataDir: dir
    });
    const call = (host: string) => new Promise<number>((resolve, reject) => {
        const req = request({
            agent: false, hostname: '127.0.0.1', port, path: '/pibo/service', headers: {
                host
            }
        }, res => {
            res.resume();
            res.once('end', () => resolve(res.statusCode!));
        });
        req.once('error', reject);
        req.end();
    });
    try {
        assert.equal((gateway.server.address() as any).address, '127.0.0.1');
        assert.equal(await call(`100.100.1.2:${port}`), 200);
        assert.equal(await call(`127.0.0.1:${port}`), 403);
        assert.equal(await call(`100.100.1.3:${port}`), 403);
        assert.deepEqual(gateway.listDevices(), []);
    }
    finally {
        await gateway.close();
        rmSync(dir, {
            recursive: true
        });
    }
});
test('Serve-loopback option keeps local owner administration and pairing separate from remote device access', async () => {
    const { PiBotDaemon } = await import('../src/daemon/core/daemon.ts');
    const { listenHttp } = await import('../src/daemon/transports/http.ts');
    const reserve = createServer();
    await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
    const port = (reserve.address() as any).port;
    await new Promise<void>(r => reserve.close(() => r()));
    const dir = mkdtempSync(join(tmpdir(), 'pibo-forward-admin-test-'));
    const daemon = await PiBotDaemon.create({
        dataDir: dir, piOptions: {
            agentDir: join(dir, 'pi'), cwd: dir
        }, factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    const transport = await listenHttp(daemon, {
        port: 0, tailnet: tailnetListenerOptions(['--tailnet-listen', `100.100.1.2:${port}`, '--tailnet-serve-loopback'])
    });
    const owner = (action: string, id?: string, authorized = true) => fetch(transport.url + '/tailnet/admin', {
        method: 'POST', headers: {
            'content-type': 'application/json', ...(authorized ? {
                authorization: 'Bearer ' + transport.token
            } : {})
        }, body: JSON.stringify({
            action, id
        })
    });
    const remote = (path: string, token?: string, body?: any) => new Promise<{
        status: number;
        value: any;
    }>((resolve, reject) => {
        const req = request({
            agent: false, hostname: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers: {
                host: `100.100.1.2:${port}`, ...(token ? {
                    authorization: 'Bearer ' + token
                } : {})
            }
        }, res => {
            let text = '';
            res.on('data', c => text += c);
            res.once('end', () => resolve({
                status: res.statusCode!, value: JSON.parse(text)
            }));
        });
        req.once('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });
    try {
        assert.equal((await owner('pair', undefined, false)).status, 403);
        const approval = await owner('pair');
        assert.equal(approval.status, 200);
        const { code } = await approval.json() as any;
        const pair = await remote('/pibo/pair', undefined, {
            code
        });
        assert.equal(pair.status, 200);
        assert.equal((await remote('/pibo/ready', pair.value.token)).status, 200);
        assert.equal((await remote('/tailnet/admin', pair.value.token, {
            action: 'pair'
        })).status, 404);
        assert.equal((await owner('revoke', pair.value.deviceId)).status, 200);
        assert.equal((await remote('/pibo/ready', pair.value.token)).status, 401);
    }
    finally {
        await transport.close();
        await daemon.close();
        rmSync(dir, {
            recursive: true
        });
    }
});
