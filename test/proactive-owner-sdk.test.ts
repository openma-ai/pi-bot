import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { PiBotClient, PiBotApiError } from '../src/sdk/client.ts';
import type { Envelope } from '../src/pi/types.ts';

const factory = async () => ({ async run() {}, async close() {} });
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'proactive-owner-sdk-'));
    let d = await PiBotDaemon.create({ dataDir: dir, factory });
    let now = Date.now();
    const clients: PiBotClient[] = [];
    const setup = () => {
        d.proactive.options.now = () => now;
        d.proactive.options.detectors!.file = async () => ({ decision: 'silent' });
    };
    setup();
    return {
        get d() { return d; }, get now() { return now; }, advance() { now += 1000; },
        async client(owner: string) {
            let connection!: ReturnType<PiBotDaemon['connect']>;
            const api = await PiBotClient.connect({ transport: { inProcess: { connect() {
                connection = d.connect('owner-fixture'); connection.fileOwner = owner; return connection;
            } } } });
            clients.push(api); return { api, get connection() { return connection; } };
        },
        async restart() {
            for (const c of clients.splice(0)) c.close();
            await d.close(); d = await PiBotDaemon.create({ dataDir: dir, factory }); setup();
        },
        async close() { for (const c of clients) c.close(); await d.close(); await rm(dir, { recursive: true, force: true }); }
    };
}
const forbidden = (error: unknown) => error instanceof PiBotApiError && error.reason === 'forbidden';

test('routine list and every action use authenticated owner even when two clients share one bot', async () => {
    const h = await fixture();
    try {
        const alice = await h.client('alice'), bob = await h.client('bob');
        const { bot } = await alice.api.bot.create({ name: 'shared fixture bot' });
        const { routine: schedule } = await alice.api.routine.create({ kind: 'schedule', botId: bot.id, prompt: 'alice schedule', at: h.now + 1000, intervalMs: 1000, timezone: 'UTC', key: 'alice-schedule' });
        const { routine: monitor } = await alice.api.routine.create({ kind: 'monitor', botId: bot.id, prompt: 'alice monitor', intervalMs: 1000, deadline: h.now + 60000, key: 'alice-monitor' });
        const { routine: bobs } = await bob.api.routine.create({ kind: 'schedule', botId: bot.id, prompt: 'bob schedule', at: h.now + 1000, timezone: 'UTC', key: 'bob-schedule' });
        assert.deepEqual((await alice.api.routine.list({})).routines.map(r => r.id).sort(), [schedule.id, monitor.id].sort());
        assert.deepEqual((await bob.api.routine.list({ botId: bot.id })).routines.map(r => r.id), [bobs.id]);
        for (const routine of [schedule, monitor])
            for (const action of ['pause', 'resume', 'cancel', 'enable', 'dryRun'] as const)
                await assert.rejects(bob.api.routine[action]({ routineId: routine.id }), forbidden);
        await assert.rejects(alice.api.routine.cancel({ routineId: bobs.id }), forbidden);
        const spoof = await bob.connection.request({ id: 'spoof', method: 'routine/cancel', params: { routineId: schedule.id, fileOwner: 'alice' } });
        assert.equal(spoof.error?.data.reason, 'invalidParams');
        await alice.api.routine.pause({ routineId: schedule.id });
        await alice.api.routine.resume({ routineId: schedule.id });
        await alice.api.routine.dryRun({ routineId: monitor.id });
        await alice.api.routine.enable({ routineId: monitor.id });
        // The legacy host API remains an explicitly trusted administrator operation.
        await h.d.routineAction('pause', bobs.id);
        assert.equal((await bob.api.routine.list({})).routines[0].state, 'paused');
        await alice.api.routine.cancel({ routineId: schedule.id });
        assert.equal((await alice.api.routine.list({ kind: 'schedule' })).routines[0].state, 'cancelled');
    }
    finally { await h.close(); }
});

for (const kind of ['schedule', 'monitor'] as const) {
    test(`${kind} owner archive persists suspension; unarchive requires original owner explicit resume`, async () => {
        const h = await fixture();
        try {
            const alice = await h.client('alice'), bob = await h.client('bob');
            const { bot } = await alice.api.bot.create({ name: 'archive fixture' });
            const { routine } = await alice.api.routine.create(kind === 'schedule'
                ? { kind, botId: bot.id, prompt: 'owned schedule', at: h.now + 1000, intervalMs: 1000, timezone: 'UTC' }
                : { kind, botId: bot.id, prompt: 'owned monitor', intervalMs: 1000, deadline: h.now + 60000 });
            if (kind === 'monitor') {
                await alice.api.routine.dryRun({ routineId: routine.id });
                await alice.api.routine.enable({ routineId: routine.id });
            }
            const stored: any = h.d.runtime.store.get(kind === 'schedule' ? 'schedules' : 'monitors', routine.id.split(':')[1]);
            const source = h.d.runtime.store.get<Envelope>('inbox', stored.sourceId)!;
            const thread = h.d.runtime.store.ensureThread(source);
            await alice.api.thread.archive({ threadId: thread.id });
            h.advance(); await h.d.proactive.tick();
            const paused: any = (await alice.api.routine.list({})).routines[0];
            assert.equal(paused.suspension?.reason, 'owner_archived');
            assert.equal(kind === 'schedule' ? paused.state : paused.enabled, kind === 'schedule' ? 'paused' : false);
            await assert.rejects(alice.api.routine.resume({ routineId: routine.id }));
            await assert.rejects(bob.api.routine.resume({ routineId: routine.id }), forbidden);
            await h.restart();
            const reopened = await h.client('alice'), other = await h.client('bob');
            assert.equal(((await reopened.api.routine.list({})).routines[0] as any).suspension?.reason, 'owner_archived');
            await reopened.api.thread.unarchive({ threadId: thread.id });
            await h.d.proactive.tick();
            const stillPaused: any = (await reopened.api.routine.list({})).routines[0];
            assert.equal(kind === 'schedule' ? stillPaused.state : stillPaused.enabled, kind === 'schedule' ? 'paused' : false);
            await assert.rejects(other.api.routine.resume({ routineId: routine.id }), forbidden);
            const resumed: any = (await reopened.api.routine.resume({ routineId: routine.id })).routine;
            assert.equal(resumed.suspension, undefined);
            assert.equal(kind === 'schedule' ? resumed.state : resumed.enabled, kind === 'schedule' ? 'active' : true);
        }
        finally { await h.close(); }
    });
}

test('persisted client owner may cancel a source-missing routine but cannot resume or transfer it', async () => {
    const h = await fixture();
    try {
        const alice = await h.client('alice'), bob = await h.client('bob');
        const { bot } = await alice.api.bot.create({ name: 'missing-source fixture' });
        const { routine } = await alice.api.routine.create({ kind: 'schedule', botId: bot.id, prompt: 'owned schedule', at: h.now + 1000, intervalMs: 1000, timezone: 'UTC' });
        const stored: any = h.d.runtime.store.get('schedules', routine.id.split(':')[1]);
        assert.equal(stored.ownerFileOwner, 'alice');
        h.d.runtime.store.db.prepare('DELETE FROM inbox WHERE id=?').run(stored.sourceId);
        h.advance(); await h.d.proactive.tick();
        assert.equal(((await alice.api.routine.list({})).routines[0] as any).suspension?.reason, 'source_missing');
        assert.deepEqual((await bob.api.routine.list({})).routines, []);
        await assert.rejects(alice.api.routine.resume({ routineId: routine.id }));
        await assert.rejects(bob.api.routine.cancel({ routineId: routine.id }), forbidden);
        await h.restart();
        const reopened = await h.client('alice');
        await assert.rejects(reopened.api.routine.resume({ routineId: routine.id }));
        assert.equal((await reopened.api.routine.cancel({ routineId: routine.id })).routine.state, 'cancelled');
    }
    finally { await h.close(); }
});
