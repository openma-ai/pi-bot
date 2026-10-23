import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { PiBotClient } from '../src/sdk/client.ts';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { piSessionFactory } from '../src/pi/session-factory.ts';
import { inboxIds } from '../src/pi/inbox-identity.ts';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { ProactiveService } from '../src/daemon/runtime/proactive.ts';
import type { Envelope, Outbound } from '../src/daemon/runtime/store.ts';

test('SDK has one user reply path and neither creates notification tables nor deletes old experimental rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'single-reply-sdk-'));
    const factory = async () => ({ async run() {}, async close() {} });
    let d = await PiBotDaemon.create({ dataDir: dir, factory });
    const connection = d.connect('fixture');
    const client = await PiBotClient.connect({ transport: { inProcess: { connect: () => connection } } });
    try {
        assert.equal('notification' in client, false);
        for (const method of ['notification/list', 'notification/read', 'notification/preferences', 'notification/configure']) {
            const response = await connection.request({ id: method, method, params: {} });
            assert.equal(response.error?.code, -32601);
        }
        const tables = d.runtime.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'notification_%'").all();
        assert.deepEqual(tables, []);
        // Never destroy experimental data when opening an old database; it is simply unused.
        d.runtime.store.db.exec("CREATE TABLE notification_entries(id TEXT PRIMARY KEY,data TEXT NOT NULL); INSERT INTO notification_entries VALUES('legacy','{}')");
        client.close(); await d.close();
        d = await PiBotDaemon.create({ dataDir: dir, factory });
        assert.equal(d.runtime.store.db.prepare('SELECT count(*) AS n FROM notification_entries').get()!.n, 1);
    } finally { client.close(); await d.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const producer of ['monitor', 'dream'] as const)
    for (const speak of [false, true])
        test(`native Pi ${producer}: main agent ${speak ? 'uses existing send_message once despite repeated same-key calls' : 'stays silent and creates no outbound message'}`, { timeout: 15000 }, async () => {
            const dir = await mkdtemp(join(tmpdir(), 'native-proactive-reply-'));
            let runtime!: BotRuntime, service!: ProactiveService;
            let calls = 0, now = 1000;
            const expectedKind = producer === 'dream' ? 'research' : 'monitor';
            const faux = fauxProvider({ provider: `single-reply-${producer}-${speak}`, models: [{ id: 'test', contextWindow: 128000, maxTokens: 4096 }], tokensPerSecond: 1000000 });
            faux.setResponses(Array.from({ length: 12 }, () => (ctx: any) => {
                const finding = inboxIds(ctx).map(id => runtime.store.get<Envelope>('inbox', id)).find(e => e?.kind === expectedKind);
                if (speak && finding && calls < 2) {
                    calls++;
                    return fauxAssistantMessage(fauxToolCall('send_message', { text: 'SELECTED_FINDING', key: `finding:${finding.id}`, source_message_id: finding.id }, { id: `same-key-reply-${calls}` }), { stopReason: 'toolUse' });
                }
                return fauxAssistantMessage('internal only');
            }));
            const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
            runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({ dir, modelRuntime: models, model: faux.getModel(), extensions: [pi => pi.registerProvider(faux.provider)], preemptInference: false }));
            const bot = runtime.createBot('main', '', 'alpha');
            const route = { channelId: 'alpha', threadId: 'original', senderId: 'alice' };
            try {
                const source = runtime.accept({ to: bot.id, fileOwner: 'alice', text: 'local fixture evidence', key: 'origin', route });
                await runtime.idle();
                service = new ProactiveService(runtime, {
                    now: () => now,
                    detectors: { fixture: async ({ dryRun }) => dryRun ? { decision: 'silent' } : { decision: 'wake', dedupKey: 'change', payload: 'fixture finding' } },
                    workers: { research: {
                        async generate() { return { text: 'fixture finding', evidenceRefs: [source.id] }; },
                        async review() { return { approved: true, reason: 'fixture evidence' }; }
                    } }
                });
                if (producer === 'monitor') {
                    const m = service.createMonitor(source, { key: 'watch', detector: 'fixture', prompt: 'watch', intervalMs: 1000, deadline: 10000 });
                    await service.dryRunMonitor(bot.id, m.id); service.enableMonitor(bot.id, m.id);
                } else service.createDream(source, { key: 'dream', at: 2000, deadline: 10000, maxRuns: 1, evidenceRefs: [source.id] });
                now = 2000;
                await service.tick(); await runtime.idle();
                const finding = runtime.store.list<Envelope>('inbox').find(e => e.kind === expectedKind)!;
                assert.ok(finding);
                runtime.activateInbox(finding.id); runtime.activateInbox(finding.id);
                now = 3000; await service.tick(); await runtime.idle();
                assert.equal(runtime.store.list<Envelope>('inbox').filter(e => e.kind === expectedKind).length, 1);
                const out = runtime.store.list<Outbound>('outbox');
                assert.equal(out.length, speak ? 1 : 0);
                if (speak) { assert.equal(calls, 2); assert.equal(out[0].replyTo, finding.id); assert.deepEqual(out[0].route, route); }
                const delivered: Outbound[] = [];
                await runtime.deliver(async o => { delivered.push(o); }); await runtime.deliver(async o => { delivered.push(o); });
                assert.equal(delivered.length, speak ? 1 : 0);
                assert.equal(runtime.errors.length, 0);
            } finally { await service?.close(); await runtime.close(); await rm(dir, { recursive: true, force: true }); }
        });
