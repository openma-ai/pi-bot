import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startDaemon } from '../src/daemon/server.ts';
import { PiBotApiError, PiBotClient } from '../src/sdk/index.ts';

test('SDK client drives the daemon end to end and surfaces typed errors', async () => {
    await mkdir(resolve('work/gui'), { recursive: true });
    process.env.PI_BOT_DIR = await mkdtemp(resolve('work/gui/sdk-'));
    process.env.PI_BOT_GUI_PORT = '0';
    const daemon = await startDaemon({
        factory: async (_bot, host) => ({
            async run(e) {
                host.sendMessage(e, 'echo:' + e.text, 'reply:' + e.id);
            }, async close() {
            }
        })
    });
    try {
        const client = new PiBotClient({ baseUrl: `http://127.0.0.1:${(daemon.server.address() as { port: number }).port}` });
        // Writes before any state() call lazily acquire the token.
        const second = await client.createBot({ name: 'second' });
        const state = await client.state();
        assert.equal(state.bots.length, 2);
        assert.ok(state.token);
        const first = state.bots.find(b => b.id !== second.id)!;
        await client.sendMessage({ to: first.id, text: 'hello' });
        await daemon.runtime.idle();
        await daemon.runtime.deliver(async () => {
        });
        const after = await client.state();
        assert.deepEqual(after.messages.map(m => [m.direction, m.text]), [['inbound', 'hello'], ['outbound', 'echo:hello']]);
        const group = await client.createGroup({ name: 'team', memberIds: [first.id, second.id] });
        assert.deepEqual(group.memberIds, [first.id, second.id]);
        await assert.rejects(client.sendMessage({ to: 'nobody', text: 'x' }), (e: unknown) => e instanceof PiBotApiError && e.status === 400);
        const forged = new PiBotClient({ baseUrl: `http://127.0.0.1:${(daemon.server.address() as { port: number }).port}`, token: 'forged' });
        await assert.rejects(forged.createBot({ name: 'x' }), (e: unknown) => e instanceof PiBotApiError && e.status === 403);
    }
    finally {
        await daemon.close();
    }
});
