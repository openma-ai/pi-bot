import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const managerModule = await import('../src/daemon/transports/runtime-manager.ts').catch(() => undefined);
const hostModule = await import('../src/daemon/transports/client-host.ts').catch(() => undefined);
const sdkModule = await import('../src/sdk/runtime-client.ts').catch(() => undefined);
const local = {
    mode: 'local' as const, dataDir: '/tmp/pi-runtime-test'
};
const ssh = {
    mode: 'ssh' as const, host: 'alice@box', projectDir: '/home/alice/pi-bot', dataDir: 'work/gui/demo', serverPort: 4318, node: 'node'
};
test('runtime profiles reject SSH option injection and quote remote paths literally', () => {
    assert.ok(managerModule, 'runtime manager is required');
    assert.throws(() => managerModule.validateProfile({
        ...ssh, host: '-oProxyCommand=evil'
    }));
    assert.throws(() => managerModule.validateProfile({
        ...ssh, serverPort: 65536
    }));
    const args = managerModule.sshStartArgs({
        ...ssh, projectDir: "/home/alice/it's $(touch NEVER)"
    });
    assert.ok(args.includes('BatchMode=yes'));
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.includes('ForwardAgent=no'));
    assert.match(args.at(-1)!, /cd '\/home\/alice\/it'"'"'s \$\(touch NEVER\)'/);
    const custom = managerModule.sshStartArgs({
        ...ssh, configFile: '/tmp/pi-bot-ssh-config'
    });
    assert.equal(custom[custom.indexOf('-F') + 1], '/tmp/pi-bot-ssh-config');
});
test('switch is atomic, failed SSH leaves local connected, old routes are revoked, no tokens persist', async () => {
    assert.ok(managerModule, 'runtime manager is required');
    const file = join(mkdtempSync(join(tmpdir(), 'pi-client-')), 'client.json');
    let fail = false, closed = 0;
    const manager = new managerModule.RuntimeManager({
        file, defaults: {
            local, ssh
        }, open: async (p: any) => {
            if (fail)
                throw Error('Permission denied (publickey) secret-should-not-leak');
            return {
                url: 'http://127.0.0.1:4999', host: '127.0.0.1:4318', token: 'private-test-transport-token', close: () => {
                    closed++;
                }
            };
        }
    });
    try {
        const a = await manager.connect(local);
        assert.equal(manager.route(a.active!.id).token, 'private-test-transport-token');
        fail = true;
        await assert.rejects(manager.connect(ssh), /SSH/);
        assert.equal(manager.status().active!.id, a.active!.id);
        assert.equal(closed, 0);
        fail = false;
        const b = await manager.connect(ssh);
        assert.notEqual(a.active!.scope, b.active!.scope);
        assert.throws(() => manager.route(a.active!.id), /切换/);
        assert.equal(closed, 1);
        assert.doesNotMatch(JSON.stringify(manager.status()) + readFileSync(file, 'utf8'), /private-test|secret-should/);
        const c = await manager.connect(local);
        assert.equal(a.active!.scope, c.active!.scope, 'draft scope survives reconnect');
        assert.equal(typeof (manager as any).remove, 'function', 'configured Cloud can be removed without deleting remote data');
        const removed = manager.remove(b.active!.profileId);
        assert.ok(removed.profiles.every(p => p.mode !== 'ssh'));
        assert.equal(removed.active!.id, c.active!.id);
    }
    finally {
        await manager.close();
    }
});
test('concurrent switches cannot install out-of-order runtime sessions', async () => {
    assert.ok(managerModule, 'runtime manager is required');
    let release!: () => void;
    const manager = new managerModule.RuntimeManager({
        file: join(mkdtempSync(join(tmpdir(), 'pi-client-')), 'client.json'), defaults: {
            local, ssh
        }, open: async () => {
            await new Promise<void>(r => release = r);
            return {
                url: 'http://127.0.0.1:4999', host: '127.0.0.1:4318', token: 'fixture', close() {
                }
            };
        }
    });
    try {
        const pending = manager.connect(local);
        await assert.rejects(manager.connect(ssh), /连接/);
        release();
        await pending;
        assert.equal(manager.status().active!.mode, 'local');
    }
    finally {
        await manager.close();
    }
});
test('named runtimes are added without connecting, multiple VPS profiles remain distinct', async () => {
    assert.ok(managerModule);
    let opened = 0;
    const file = join(mkdtempSync(join(tmpdir(), 'pi-many-runtimes-')), 'client.json');
    const manager = new managerModule.RuntimeManager({
        file, defaults: {
            local, ssh: null
        }, open: async () => {
            opened++;
            return {
                url: 'http://127.0.0.1:4999', host: '127.0.0.1:4318', token: 'private-fixture', close() {
                }
            };
        }
    });
    try {
        manager.configure({
            ...ssh, name: 'Research VPS'
        });
        const added = manager.configure({
            ...ssh, host: 'bob@other-box', name: 'Build VPS'
        });
        assert.ok(Array.isArray(added.profiles), 'runtime settings are a collection, not two fixed slots');
        assert.equal(added.profiles.length, 3);
        assert.equal(opened, 0, 'add never enables or starts the server');
        const a = added.profiles.find((p: any) => p.name === 'Research VPS')!;
        const b = added.profiles.find((p: any) => p.name === 'Build VPS')!;
        const first = await manager.connect(a), second = await manager.connect(b);
        assert.notEqual(first.active!.scope, second.active!.scope);
        assert.equal(second.active!.profile!.name, 'Build VPS');
        assert.throws(() => manager.remove(b.id!), /启用/);
        manager.configure({
            ...b, name: 'Renamed VPS'
        });
        const renamed = await manager.connect({
            ...b, name: 'Renamed VPS'
        });
        assert.equal(second.active!.scope, renamed.active!.scope, 'renaming does not lose drafts');
        manager.remove(a.id!);
        assert.equal(manager.status().profiles.length, 2);
    }
    finally {
        await manager.close();
    }
});
test('client gateway forwards existing SDK calls and private Pi auth to the chosen server only', async () => {
    assert.ok(managerModule && hostModule && sdkModule, 'client host and SDK are required');
    const { PiBotDaemon } = await import('../src/daemon/core/daemon.ts');
    const { listenHttp } = await import('../src/daemon/transports/http.ts');
    const { PiBotClient } = await import('../src/sdk/client.ts');
    const dir = mkdtempSync(join(tmpdir(), 'pi-client-integration-'));
    const daemons = await Promise.all(['a', 'b'].map(name => PiBotDaemon.create({
        dataDir: join(dir, name), factory: async (_bot, host) => ({
            run: async (e) => {
                host.sendMessage(e, 'real server ' + name, 'reply:' + e.id);
            }, close: async () => {
            }
        })
    })));
    const servers = await Promise.all(daemons.map(d => listenHttp(d, {
        port: 0
    })));
    const { PiSettings } = await import('../src/daemon/pi-settings.ts');
    daemons[0].piSettings = await PiSettings.create({
        agentDir: join(dir, 'auth-a'), cwd: dir
    });
    daemons[1].piSettings = await PiSettings.create({
        agentDir: join(dir, 'auth-b'), cwd: dir
    });
    const manager = new managerModule.RuntimeManager({
        file: join(dir, 'client.json'), defaults: {
            local, ssh
        }, open: async (p: any) => {
            const s = servers[p.mode === 'local' ? 0 : 1];
            return {
                url: s.url, host: new URL(s.url).host, token: s.token, close() {
                }
            };
        }
    });
    const host = await hostModule.listenClientHost(manager, {
        port: 0
    });
    const control = new sdkModule.RuntimeClient(host.url, () => ({
        authorization: 'Bearer ' + host.token
    }));
    const clients: any[] = [];
    try {
        assert.equal((await fetch(host.url + '/client/rpc', {
            method: 'POST', body: '{}'
        })).status, 401);
        const a = await control.runtime.connect({
            profile: local
        });
        const client = await PiBotClient.connect({
            transport: {
                http: host.url + a.active!.baseUrl, token: host.token
            }
        });
        clients.push(client);
        const { bot } = await client.bot.create({
            name: 'only-local'
        });
        await client.turn.start({
            botId: bot.id, text: 'hello', key: 'one'
        });
        await daemons[0].runtime.idle();
        assert.equal((await client.daemon.snapshot({})).bots.length, 1);
        assert.equal(daemons[1].runtime.listBots().length, 0);
        const subscription: any[] = [];
        await client.events.subscribe({
            after: 0
        }, e => subscription.push(e));
        await client.bot.create({
            name: 'event-local'
        });
        for (let i = 0; i < 100 && !subscription.some(e => e.method === 'bot/created'); i++)
            await new Promise(r => setTimeout(r, 5));
        assert.ok(subscription.some(e => e.method === 'bot/created'), 'SSE travels through the same runtime path');
        const b = await control.runtime.connect({
            profile: ssh
        });
        assert.equal((await fetch(host.url + a.active!.baseUrl + '/rpc', {
            method: 'POST', headers: {
                authorization: 'Bearer ' + host.token
            }, body: '{}'
        })).status, 410);
        const remote = await PiBotClient.connect({
            transport: {
                http: host.url + b.active!.baseUrl, token: host.token
            }
        });
        clients.push(remote);
        assert.equal((await remote.daemon.snapshot({})).bots.length, 0);
        const privateAuth = await import('../src/sdk/pi-settings-client.ts');
        assert.equal(typeof privateAuth.createPiSettingsClient, 'function', 'Pi settings must be scoped to the selected runtime');
        const settings = privateAuth.createPiSettingsClient(host.url + b.active!.baseUrl, () => ({
            authorization: 'Bearer ' + host.token
        }));
        const flow = await settings('login', {
            provider: 'deepseek', type: 'api_key'
        });
        let state: any;
        for (let i = 0; i < 100; i++) {
            state = await settings('login/' + flow.id);
            if (state.prompt)
                break;
            await new Promise(r => setTimeout(r, 2));
        }
        await settings('login/' + flow.id + '/input', {
            promptId: state.prompt.id, value: 'fixture-cloud-key'
        });
        for (let i = 0; i < 100; i++) {
            state = await settings('login/' + flow.id);
            if (state.status === 'complete')
                break;
            await new Promise(r => setTimeout(r, 2));
        }
        assert.equal(state.status, 'complete');
        assert.equal(JSON.parse(readFileSync(join(dir, 'auth-b', 'auth.json'), 'utf8')).deepseek.key, 'fixture-cloud-key');
        assert.ok(!(await daemons[0].piSettings.state()).providers.find((p: any) => p.id === 'deepseek')?.credential, 'local Pi auth is untouched');
        assert.doesNotMatch(JSON.stringify(await remote.daemon.snapshot({})), /fixture-cloud-key/);
        assert.doesNotMatch(JSON.stringify(await control.runtime.status({})), new RegExp(servers[1].token));
        const originRejected = await fetch(host.url + '/client/rpc', {
            method: 'POST', headers: {
                authorization: 'Bearer ' + host.token, origin: 'http://evil.invalid'
            }, body: '{}'
        });
        assert.equal(originRejected.status, 403);
    }
    finally {
        clients.forEach(c => c.close());
        await host.close();
        await manager.close();
        await Promise.all(servers.map(s => s.close()));
        await Promise.all(daemons.map(d => d.close()));
    }
});
