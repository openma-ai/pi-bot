import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { PiBotClient } from '../src/sdk/client.ts';
import { listenHttp } from '../src/daemon/transports/http.ts';
const factory: any = async () => ({
    run: async () => {
    }, close: async () => {
    }
});
test('bot avatar shape/color updates persist and appear in shared SDK events', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pi-avatar-'));
    let d = await PiBotDaemon.create({
        dataDir, factory
    });
    let api = await PiBotClient.connect({
        transport: {
            inProcess: d
        }
    });
    try {
        const { bot } = await api.bot.create({
            name: 'editable'
        });
        const events: any[] = [];
        await api.events.subscribe({
            after: 0
        }, e => events.push(e));
        const avatar = {
            shape: 12, color: '#13b8a6'
        };
        const changed = await api.bot.update({
            botId: bot.id, avatar
        } as any);
        assert.deepEqual((changed.bot as any).avatar, avatar);
        assert.ok(events.some(e => e.method === 'bot/updated' && e.params.bot.avatar?.shape === 12));
        api.close();
        await d.close();
        d = await PiBotDaemon.create({
            dataDir, factory
        });
        api = await PiBotClient.connect({
            transport: {
                inProcess: d
            }
        });
        assert.deepEqual((await api.bot.read({
            botId: bot.id
        })).bot.avatar, avatar);
        await api.bot.update({
            botId: bot.id, avatar: null
        } as any);
        assert.equal((await api.bot.read({
            botId: bot.id
        })).bot.avatar, null);
        await assert.rejects(api.bot.update({
            botId: bot.id, avatar: {
                shape: 20, color: 'red;url(evil)'
            }
        } as any), (e: any) => e.reason === 'invalidParams');
    }
    finally {
        api.close();
        await d.close();
    }
});
test('uploaded avatar uses authenticated media, rejects active content, and stores small metadata only', async () => {
    const d = await PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-avatar-media-')), factory
    });
    const http = await listenHttp(d, {
        port: 0
    });
    const api = await PiBotClient.connect({
        transport: {
            http: http.url, token: http.token
        }
    });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cG1sAAAAASUVORK5CYII=';
    try {
        const { bot } = await api.bot.create({
            name: 'image'
        });
        assert.equal(typeof (api.bot as any).avatarUpload, 'function', 'avatar upload must use the SDK');
        const uploaded = await (api.bot as any).avatarUpload({
            botId: bot.id, mime: 'image/png', data: png
        });
        const path = '/api/bot/' + bot.id + '/avatar/' + uploaded.bot.avatar.picture;
        assert.equal((await fetch(http.url + path)).status, 401);
        const image = await fetch(http.url + path, {
            headers: {
                authorization: 'Bearer ' + http.token
            }
        });
        assert.equal(image.headers.get('content-type'), 'image/png');
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(png, 'base64'));
        assert.doesNotMatch(JSON.stringify(await api.daemon.snapshot({})), /iVBORw0/);
        await assert.rejects((api.bot as any).avatarUpload({
            botId: bot.id, mime: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64')
        }), (e: any) => e.reason === 'invalidParams');
        await assert.rejects((api.bot as any).avatarUpload({
            botId: bot.id, mime: 'image/png', data: Buffer.from('<script>bad</script>').toString('base64')
        }), (e: any) => e.reason === 'invalidParams');
    }
    finally {
        api.close();
        await http.close();
        await d.close();
    }
});
