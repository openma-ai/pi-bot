import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotRuntime, type SessionFactory } from '../src/daemon/runtime/runtime.ts';
import { ProactiveService } from '../src/daemon/runtime/proactive.ts';
import type { Envelope, Outbound } from '../src/pi/types.ts';

type Producer = 'monitor' | 'dream';
const isFinding = (e: Envelope) => e.kind === 'monitor' || e.kind === 'research';
const replyKey = (e: Envelope) => `selected-finding:${e.id}`;
async function fixture(select: boolean) {
    const dir = await mkdtemp(join(tmpdir(), 'proactive-replies-'));
    const path = join(dir, 'runtime.db');
    const seen: Envelope[] = [];
    const factory: SessionFactory = async (_bot, host) => ({
        async run(e) {
            seen.push(e);
            if (select && isFinding(e))
                host.sendMessage(e, 'Selected useful fixture finding', replyKey(e));
        }, async close() {}
    });
    let runtime = new BotRuntime(path, factory);
    let now = 1000;
    const options = {
        now: () => now,
        detectors: { fixture: async ({ dryRun }: { dryRun: boolean }) => dryRun
            ? { decision: 'silent' as const }
            : { decision: 'wake' as const, dedupKey: 'same-change', payload: 'Fixture condition changed' } },
        workers: { research: {
            async generate(evidence: Envelope[]) { return { text: 'Fixture local evidence synthesis', evidenceRefs: evidence.map(e => e.id) }; },
            async review() { return { approved: true, reason: 'Fixture independent review' }; }
        } }
    };
    let service = new ProactiveService(runtime, options);
    const bot = runtime.createBot('fixture', '', 'fixture-channel');
    const source = runtime.accept({
        to: bot.id, key: 'original-task', text: 'Fixture evidence and authorization', fileOwner: 'alice',
        route: { channelId: 'fixture-channel', conversationId: 'fixture-conversation', threadId: 'original-thread', senderId: 'alice' }
    });
    await runtime.idle();
    return {
        source, seen, get runtime() { return runtime; }, get service() { return service; },
        async produce(kind: Producer) {
            let id: string;
            if (kind === 'monitor') {
                const monitor = service.createMonitor(source, { key: 'watch', detector: 'fixture', prompt: 'Check fixture condition', intervalMs: 1000, deadline: 10000 });
                await service.dryRunMonitor(bot.id, monitor.id);
                service.enableMonitor(bot.id, monitor.id);
                id = monitor.id;
            }
            else id = service.createDream(source, { key: 'dream', at: 2000, deadline: 10000, maxRuns: 1, evidenceRefs: [source.id] }).id;
            now = 2000;
            await service.tick(); await runtime.idle();
            return id;
        },
        async repeat() { now = 3000; await Promise.all([service.tick(), service.tick()]); await runtime.idle(); },
        ownerOf(e: Envelope) {
            let current = e;
            while (!current.fileOwner && current.replyTo)
                current = runtime.store.get<Envelope>('inbox', current.replyTo)!;
            return current.fileOwner;
        },
        async restart() {
            await service.close(); await runtime.close();
            runtime = new BotRuntime(path, factory); service = new ProactiveService(runtime, options);
            runtime.start(); await service.tick(); await runtime.idle();
        },
        async close() { await service.close(); await runtime.close(); await rm(dir, { recursive: true, force: true }); }
    };
}

for (const producer of ['monitor', 'dream'] as const) {
    test(`${producer} only supplies inbox data when the main agent chooses silence`, async () => {
        const h = await fixture(false);
        try {
            await h.produce(producer);
            const findings = h.seen.filter(isFinding);
            assert.equal(findings.length, 1);
            assert.deepEqual(findings[0].route, h.source.route);
            assert.equal(findings[0].taskId, h.source.taskId);
            assert.equal(h.ownerOf(findings[0]), 'alice');
            assert.equal(h.runtime.store.list('outbox').length, 0);
            assert.equal(h.seen.filter(e => e.kind === 'schedule').length, 0);
            await h.repeat();
            assert.equal(h.seen.filter(isFinding).length, 1);
            assert.equal(h.runtime.store.list('outbox').length, 0);
        }
        finally { await h.close(); }
    });

    test(`${producer} uses the existing reply path; duplicate wake and stable-key replay preserve one answer across restart`, async () => {
        const h = await fixture(true);
        try {
            await h.produce(producer);
            const finding = h.seen.find(isFinding)!;
            const [reply] = h.runtime.store.list<Outbound>('outbox');
            assert.equal(reply.replyTo, finding.id);
            assert.equal(reply.taskId, h.source.taskId);
            assert.deepEqual(reply.route, h.source.route);
            assert.equal(h.ownerOf(h.runtime.store.get<Envelope>('inbox', reply.replyTo!)!), 'alice');
            await h.repeat();
            h.runtime.activateInbox(finding.id); h.runtime.activateInbox(finding.id);
            await h.runtime.idle();
            // Replay exactly the selected answer with the same existing send key.
            // Different model-selected keys are outside this idempotency guarantee.
            assert.equal(h.runtime.sendMessage(finding, reply.text, replyKey(finding)).id, reply.id);
            assert.equal(h.runtime.store.list('outbox').length, 1);
            assert.equal(h.seen.filter(isFinding).length, 1);
            await h.restart();
            h.runtime.activateInbox(finding.id); await h.runtime.idle();
            assert.equal(h.runtime.sendMessage(finding, reply.text, replyKey(finding)).id, reply.id);
            assert.equal(h.runtime.store.list('outbox').length, 1);
            assert.equal(h.seen.filter(isFinding).length, 1);
        }
        finally { await h.close(); }
    });

    for (const taskControl of ['cancel', 'replace'] as const) {
        test(`${producer} ${taskControl} blocks old replies and supersedes pending delivery`, async () => {
            const h = await fixture(true);
            try {
                await h.produce(producer);
                const finding = h.seen.find(isFinding)!;
                const [reply] = h.runtime.store.list<Outbound>('outbox');
                assert.equal(reply.state, 'pending');
                h.runtime.accept({
                    to: h.source.to, taskId: h.source.taskId, taskControl, text: taskControl,
                    key: `control:${taskControl}`, route: h.source.route, fileOwner: 'alice'
                });
                await h.runtime.idle();
                assert.throws(() => h.runtime.sendMessage(finding, 'Obsolete reply', 'obsolete'), /superseded|cancelled/);
                const deliveries: Outbound[] = [];
                await h.runtime.deliver(async out => { deliveries.push(out); });
                assert.equal(deliveries.length, 0, 'the fixture sink receives no invalidated answer');
                assert.equal(h.runtime.store.get<Outbound>('outbox', reply.id)!.state, 'superseded');
                await h.restart();
                await h.runtime.deliver(async out => { deliveries.push(out); });
                assert.equal(deliveries.length, 0);
                assert.equal(h.runtime.store.list('outbox').length, 1);
            }
            finally { await h.close(); }
        });
    }

    test(`${producer} trigger cancellation also blocks an already selected pending reply`, async () => {
        const h = await fixture(true);
        try {
            const triggerId = await h.produce(producer);
            const finding = h.seen.find(isFinding)!;
            if (producer === 'monitor') h.service.cancelMonitor(h.source.to, triggerId);
            else h.service.cancelSchedule(h.source.to, triggerId);
            assert.throws(() => h.runtime.sendMessage(finding, 'Cancelled trigger result', 'late-trigger-result'), /cancelled/);
            let deliveries = 0;
            await h.runtime.deliver(async () => { deliveries++; });
            assert.equal(deliveries, 0);
            assert.equal(h.runtime.store.list<Outbound>('outbox')[0].state, 'superseded');
        }
        finally { await h.close(); }
    });
}
