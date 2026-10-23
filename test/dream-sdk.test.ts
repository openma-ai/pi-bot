import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { PiBotClient } from '../src/sdk/client.ts';
import type { Envelope } from '../src/pi/types.ts';

test('host opts daemon into bounded local dream; only main-agent selection appends an existing outbox reply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dream-sdk-'));
    let evidenceId = '', generates = 0, reviews = 0;
    const seen: Envelope[] = [];
    const d = await PiBotDaemon.create({ dataDir: dir, factory: async () => ({ async run(e) { seen.push(e); }, async close() {} }), researchWorker: {
        async generate() { generates++; return { text: 'fixture finding', evidenceRefs: [evidenceId] }; },
        async review() { reviews++; return { approved: true, reason: 'fixture evidence' }; }
    }, researchWorkTimeoutMs: 1000 });
    const client = await PiBotClient.connect({ transport: { inProcess: { connect() { const c = d.connect('fixture'); c.fileOwner = 'alice'; return c; } } } });
    try {
        const { bot } = await client.bot.create({ name: 'dream fixture' });
        const turn = await client.turn.start({ botId: bot.id, text: 'local evidence only', key: 'origin' });
        evidenceId = turn.inputId; await d.runtime.idle();
        const source = d.runtime.store.get<Envelope>('inbox', turn.inputId)!;
        d.proactive.createDream(source, { key: 'bounded-dream', at: Date.now(), deadline: Date.now() + 60000, maxRuns: 1, evidenceRefs: [source.id] });
        await d.proactive.tick(); await d.runtime.idle();
        assert.equal(generates, 1); assert.equal(reviews, 1);
        assert.equal(seen.filter(e => e.kind === 'schedule').length, 0, 'research dispatch does not consume main-model turns');
        const finding = seen.find(e => e.kind === 'research'); assert.ok(finding);
        assert.equal(d.runtime.store.list('outbox').length, 0, 'a discovery cannot directly reply');
        const out = d.runtime.sendMessage(finding, 'main agent selected this finding', 'selected');
        assert.equal(out.replyTo, finding.id);
        assert.equal(out.taskId, source.taskId);
        assert.deepEqual(out.route, source.route);
        assert.equal(d.runtime.store.get<Envelope>('inbox', source.id)!.fileOwner, 'alice');
        assert.equal(d.runtime.sendMessage(finding, 'main agent selected this finding', 'selected').id, out.id);
        assert.equal(d.runtime.store.list('outbox').length, 1);
        const snapshot = await client.daemon.snapshot({});
        assert.ok(snapshot.items.some(i => i.type === 'agentMessage' && i.text === 'main agent selected this finding'));
        await d.proactive.tick(); await d.runtime.idle(); assert.equal(generates, 1);
    } finally { client.close(); await d.close(); await rm(dir, { recursive: true, force: true }); }
});

test('opt-in dream still passes the existing host permission gate before worker execution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dream-permission-'));
    let calls = 0;
    const d = await PiBotDaemon.create({ dataDir: dir, factory: async () => ({ async run() {}, async close() {} }), researchWorker: {
        async generate(evidence) { calls++; return { text: 'must not run', evidenceRefs: evidence.map(e => e.id) }; },
        async review() { calls++; return { approved: true, reason: 'must not run' }; }
    } });
    try {
        const bot = d.runtime.createBot('permission fixture');
        const source = d.runtime.accept({ to: bot.id, text: 'local evidence', key: 'origin' });
        await d.runtime.idle();
        d.runtime.options.permission = () => false;
        d.proactive.createDream(source, { key: 'denied-dream', at: Date.now(), deadline: Date.now() + 60000, maxRuns: 1, evidenceRefs: [source.id] });
        await d.proactive.tick(); await d.runtime.idle();
        assert.equal(calls, 0);
        assert.equal(d.runtime.store.list<any>('jobs')[0].state, 'failed');
        assert.equal(d.runtime.store.list<any>('proposals')[0].state, 'uncertain');
        assert.equal(d.runtime.store.list<Envelope>('inbox').filter(e => e.kind === 'research').length, 0);
        assert.equal(d.runtime.store.list('outbox').length, 0);
    } finally { await d.close(); await rm(dir, { recursive: true, force: true }); }
});


test('existing monitor SDK preserves authenticated owner through condition change, main selection and cancellation', async () => {
    await mkdir(join(process.cwd(), 'work'), { recursive: true });
    const dir = await mkdtemp(join(process.cwd(), 'work', 'monitor-sdk-'));
    const path = join(dir, 'watched-fixture'); await writeFile(path, 'a');
    const seen: Envelope[] = [];
    const d = await PiBotDaemon.create({ dataDir: join(dir, 'runtime'), factory: async () => ({ async run(e) { seen.push(e); }, async close() {} }) });
    let now = Date.now(); d.proactive.options.now = () => now;
    const client = await PiBotClient.connect({ transport: { inProcess: { connect() { const c = d.connect('fixture'); c.fileOwner = 'alice'; return c; } } } });
    try {
        const { bot } = await client.bot.create({ name: 'monitor fixture' });
        const { routine } = await client.routine.create({ kind: 'monitor', botId: bot.id, prompt: 'watch fixture metadata', filePath: path, key: 'watch', intervalMs: 1000, deadline: now + 60000 });
        await client.routine.dryRun({ routineId: routine.id }); await client.routine.enable({ routineId: routine.id });
        await d.proactive.tick(); await d.runtime.idle(); assert.equal(seen.length, 0);
        await writeFile(path, 'aa'); now += 1000; await d.proactive.tick(); await d.runtime.idle();
        const finding = seen.find(e => e.kind === 'monitor'); assert.ok(finding);
        assert.equal(d.runtime.store.get<Envelope>('inbox', finding.replyTo!)!.fileOwner, 'alice');
        assert.equal(d.runtime.store.list('outbox').length, 0);
        const out = d.runtime.sendMessage(finding, 'selected monitor finding', 'selected');
        assert.equal(out.replyTo, finding.id);
        assert.deepEqual(out.route, finding.route);
        assert.equal(d.runtime.sendMessage(finding, 'selected monitor finding', 'selected').id, out.id);
        assert.ok((await client.daemon.snapshot({})).items.some(i => i.type === 'agentMessage' && i.text === 'selected monitor finding'));
        await client.routine.cancel({ routineId: routine.id });
        assert.throws(() => d.runtime.sendMessage(finding, 'obsolete finding', 'late'), /cancelled/);
    } finally { client.close(); await d.close(); await rm(dir, { recursive: true, force: true }); }
});
