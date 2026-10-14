import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeManager } from '../../src/daemon/transports/runtime-manager.ts';
import { listenClientHost } from '../../src/daemon/transports/client-host.ts';
import { PiBotClient } from '../../src/sdk/client.ts';
// Run explicitly against an isolated SSH host, never part of offline/model scoring.
test('actual OpenSSH starts a remote server, tunnels SDK and owns a remote Linux screen', async () => {
    const configFile = process.env.PI_BOT_TEST_SSH_CONFIG;
    assert.ok(configFile, 'set PI_BOT_TEST_SSH_CONFIG to the controlled test host config');
    const profile = {
        mode: 'ssh' as const, host: process.env.PI_BOT_TEST_SSH_HOST ?? 'pi-bot-test', projectDir: '/app', dataDir: 'work/gui/demo', serverPort: 4318, node: 'node', configFile: resolve(configFile)
    };
    const manager = new RuntimeManager({
        file: join(mkdtempSync(join(tmpdir(), 'pi-ssh-')), 'client.json'), defaults: {
            local: {
                mode: 'local', dataDir: '/tmp/unused'
            }, ssh: null
        }
    });
    const host = await listenClientHost(manager, {
        port: 0
    });
    let api: PiBotClient | undefined;
    try {
        const connected = await manager.connect(profile);
        assert.equal(connected.active?.mode, 'ssh');
        api = await PiBotClient.connect({
            transport: {
                http: host.url + connected.active!.baseUrl, token: host.token
            }
        });
        assert.equal((await api.daemon.status({})).status, 'ready');
        const snapshot = await api.daemon.snapshot({});
        const bot = snapshot.bots.find(b => b.name === 'SSH screen acceptance') ?? (await api.bot.create({
            name: 'SSH screen acceptance'
        })).bot;
        const binding = await api.desktop.bind({
            botId: bot.id
        });
        assert.ok(binding);
        const screen = await fetch(host.url + connected.active!.baseUrl + '/api/desktop/' + bot.id + '/screen', {
            headers: {
                authorization: 'Bearer ' + host.token
            }
        });
        assert.equal(screen.status, 200);
        const png = Buffer.from(await screen.arrayBuffer());
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        assert.equal(png.readUInt32BE(16), 1280);
        assert.equal(png.readUInt32BE(20), 900);
        await api.desktop.control({
            botId: bot.id, take: true
        });
        await api.desktop.control({
            botId: bot.id, take: false
        });
    }
    finally {
        api?.close();
        await host.close();
        await manager.close();
    }
});
