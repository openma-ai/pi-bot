import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeManager } from '../src/daemon/transports/runtime-manager.ts';
import { listenClientHost } from '../src/daemon/transports/client-host.ts';
import { RuntimeClient } from '../src/sdk/runtime-client.ts';
test('control SDK recovers stale browser auth against a real restarted client host', async () => {
    const manager = new RuntimeManager({
        file: join(mkdtempSync(join(tmpdir(), 'pi-client-restart-')), 'client.json'), defaults: {
            local: {
                mode: 'local', dataDir: '/tmp/test'
            }, ssh: null
        }
    });
    let server = await listenClientHost(manager, {
        port: 0
    });
    const base = server.url, port = Number(new URL(base).port);
    let cookie = '';
    const browserFetch: typeof fetch = async (url, init = {}) => {
        const response = await fetch(url, {
            ...init, headers: {
                ...init.headers as any, ...(cookie ? {
                    cookie
                } : {})
            }
        });
        const fresh = response.headers.get('set-cookie');
        if (fresh)
            cookie = fresh.split(';')[0];
        return response;
    };
    const html = await (await browserFetch(base + '/')).text();
    const oldCsrf = html.match(/name="pibot-csrf" content="([a-f0-9]+)"/)![1];
    const api = new RuntimeClient(base, () => ({
        'X-PiBot-CSRF': oldCsrf
    }), browserFetch);
    try {
        assert.equal((await api.runtime.status({})).active, null);
        await server.close();
        server = await listenClientHost(manager, {
            port
        });
        const recovered = await api.runtime.status({});
        assert.equal(recovered.profiles[0].mode, 'local');
        assert.equal((await api.runtime.status({})).active, null);
    }
    finally {
        await server.close();
        await manager.close();
    }
});
test('two client hosts on the same hostname keep separate browser cookies', async () => {
    const makeManager = () => new RuntimeManager({
        file: join(mkdtempSync(join(tmpdir(), 'pi-cookie-')), 'client.json'), defaults: {
            local: {
                mode: 'local', dataDir: '/tmp/test'
            }, ssh: null
        }
    });
    const managers = [makeManager(), makeManager()];
    const hosts = await Promise.all(managers.map(manager => listenClientHost(manager, {
        port: 0
    })));
    const cookies = new Map<string, string>();
    const csrf: string[] = [];
    try {
        for (const host of hosts) {
            const response = await fetch(host.url + '/');
            const pair = response.headers.get('set-cookie')!.split(';')[0], split = pair.indexOf('=');
            cookies.set(pair.slice(0, split), pair.slice(split + 1));
            csrf.push((await response.text()).match(/name="pibot-csrf" content="([a-f0-9]+)"/)![1]);
        }
        assert.equal(cookies.size, 2, 'ports must not overwrite another client host session');
        for (const [i, host] of hosts.entries()) {
            const response = await fetch(host.url + '/client/rpc', {
                method: 'POST', headers: {
                    cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; '), 'X-PiBot-CSRF': csrf[i], 'content-type': 'application/json'
                }, body: JSON.stringify({
                    jsonrpc: '2.0', id: 1, method: 'runtime/status', params: {}
                })
            });
            assert.equal(response.status, 200);
        }
    }
    finally {
        await Promise.all(hosts.map(host => host.close()));
        await Promise.all(managers.map(manager => manager.close()));
    }
});
test('scoped bot and Pi clients bootstrap the GUI origin after auth expires', async () => {
    const manager = new RuntimeManager({ file: join(mkdtempSync(join(tmpdir(), 'pi-scoped-auth-')), 'client.json'), defaults: { local: { mode: 'local', dataDir: '/tmp/test' }, ssh: null } });
    const host = await listenClientHost(manager, { port: 0 });
    try {
        const { refreshBrowserCsrf } = await import('../src/sdk/browser-session.ts');
        const nonce = await refreshBrowserCsrf(host.url + '/runtime/retired-connection');
        assert.match(nonce, /^[a-f0-9]{64}$/);
    } finally { await host.close(); await manager.close(); }
});
