import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import type { Outbound } from '../src/daemon/runtime/store.ts';
const route = { channelId: 'alpha', threadId: 'main', senderId: 'alice' };
test('BotRuntime routes replies through OpenMatter into the outbox and rejects a stale source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bot-om-reply-'));
    const runtime = new BotRuntime(join(dir, 'bot.db'), async () => ({ async run() { }, async close() { } }));
    try {
        const bot = runtime.createBot('main', '', 'alpha');
        const first = runtime.accept({ to: bot.id, text: 'What is the status?', key: 'first', route });
        await runtime.idle();
        const sent = runtime.replyThroughOpenMatter(first, 'All green.', 'reply', { toolCallId: 'call-1', observedInputId: first.id });
        assert.equal(sent.status, 'delivered');
        assert.ok(sent.status === 'delivered' && (sent.receipt as any).outboxId === sent.outbound?.id);
        assert.equal(sent.outbound?.replyTo, first.id);
        assert.equal(sent.outbound?.toolCallId, 'call-1');
        runtime.accept({ to: bot.id, text: 'Correction: only failures.', key: 'second', route });
        await runtime.idle();
        const stale = runtime.replyThroughOpenMatter(first, 'Everything passed.', 'stale', { observedInputId: first.id });
        assert.equal(stale.status, 'conflict');
        assert.deepEqual(runtime.store.list<Outbound>('outbox').map(o => o.text), ['All green.']);
        await runtime.deliver(async () => { });
        assert.equal(runtime.store.list<Outbound>('outbox')[0]!.state, 'delivered');
        assert.throws(() => runtime.replyThroughOpenMatter(first, 'Different', 'reply', { observedInputId: first.id }), /Idempotency key conflict/);
    }
    finally {
        await runtime.close();
        await rm(dir, { recursive: true, force: true });
    }
});
