import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { PiBotClient, PiBotApiError } from '../src/sdk/client.ts';
test('SDK namespace client drives the same daemon without a second runtime or leaked auth', async () => {
    const daemon = await PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-sdk-')), factory: async (_bot, host) => ({
            run: async (e) => {
                host.sendMessage(e, 'echo:' + e.text, 'reply:' + e.id);
            }, close: async () => {
            }
        })
    });
    const client = await PiBotClient.connect({
        transport: {
            inProcess: daemon
        }
    });
    try {
        const { bot: first } = await client.bot.create({
            name: 'first'
        });
        const { bot: second } = await client.bot.create({
            name: 'second'
        });
        await client.turn.start({
            botId: first.id, text: 'hello', key: 'hello'
        });
        await daemon.runtime.idle();
        await daemon.runtime.deliver(async () => {
        });
        const state = await client.daemon.snapshot({});
        assert.equal(state.bots.length, 2);
        assert.ok(!('token' in state));
        assert.deepEqual(state.items.filter(i => i.type === 'agentMessage').map(i => i.text), ['echo:hello']);
        const { group } = await client.group.create({
            name: 'team', memberIds: [first.id, second.id]
        });
        assert.deepEqual(group.memberIds, [first.id, second.id]);
        await assert.rejects(client.turn.start({
            botId: 'nobody', text: 'x', key: 'x'
        }), (e: unknown) => e instanceof PiBotApiError && e.reason === 'notFound');
    }
    finally {
        client.close();
        await daemon.close();
    }
});
