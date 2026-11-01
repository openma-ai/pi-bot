import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Effect, Exit } from 'effect';
import { WorkEventSchema, type JsonValue } from '@openma/matter';
import { Schema } from 'effect';
import { OpenMatterReplyHost } from '../src/daemon/openmatter/reply-host.ts';
import { makePiBotIntegration, PiBotReplyNotApplied, PI_BOT_REPLY_TOOL, workEventForEnvelope, type PiBotReplyInput } from '../src/daemon/openmatter/pi-bot-integration.ts';
import type { Envelope } from '../src/daemon/runtime/store.ts';
const route = { channelId: 'alpha', threadId: 'main', senderId: 'alice' };
let n = 0;
const envelope = (over: Partial<Envelope> = {}): Envelope => ({
    id: `e${++n}`, from: 'user', to: 'bot-a', text: 'hello', key: `k${n}`, kind: 'user', taskId: 't1', replyTo: null, hop: 0, state: 'queued', createdAt: 1793000000000 + n, route, ...over
} as Envelope);
test('pi-bot integration manifest declares message.reply as a guarded tool', () => {
    const integration = makePiBotIntegration({ reply: () => null });
    assert.equal(integration.manifest.id, 'pi-bot');
    assert.deepEqual(integration.manifest.operations, ['message.reply']);
    assert.equal(integration.manifest.tools?.['message.reply']?.freshness, 'best-effort');
    assert.ok(integration.manifest.events.includes('pi.user'));
    assert.equal(PI_BOT_REPLY_TOOL, 'pi-bot.message.reply');
});
test('event binding: envelopes become valid WorkEvents; user/answer are human, bots and jobs are apps', () => {
    const integration = makePiBotIntegration({ reply: () => null });
    const user = envelope();
    const [event] = Effect.runSync(integration.ingest(user));
    assert.ok(Schema.is(WorkEventSchema)(event));
    assert.equal(event!.source.provider, 'pi-bot');
    assert.equal(event!.source.messageId, user.id);
    assert.equal(event!.source.threadId, 'main');
    assert.deepEqual(integration.observe!(event!)?.sender, { id: 'user', kind: 'human' });
    assert.equal(integration.observe!(workEventForEnvelope(envelope({ kind: 'answer' })))?.sender?.kind, 'human');
    assert.equal(integration.observe!(workEventForEnvelope(envelope({ kind: 'bot', from: 'bot-b' })))?.sender?.kind, 'app');
    assert.equal(integration.observe!(workEventForEnvelope(envelope({ kind: 'job', from: 'job:1' })))?.sender?.kind, 'app');
    // Conversations are per recipient bot, as pi-bot's conversation revision is.
    assert.notEqual(workEventForEnvelope(envelope({ to: 'bot-b' })).source.conversationId, event!.source.conversationId);
    assert.ok(Exit.isFailure(Effect.runSyncExit(integration.ingest({ nope: true }))));
});
test('bindToolInput binds the trigger as the reply target and refuses anything the Agent should not choose', () => {
    const integration = makePiBotIntegration({ reply: () => null });
    const trigger = workEventForEnvelope(envelope());
    assert.deepEqual(integration.bindToolInput!('message.reply', { text: 'hi', key: 'r' }, trigger), {
        input: { sourceMessageId: trigger.source.messageId!, conversationId: trigger.source.conversationId!, threadId: 'main', text: 'hi', key: 'r' }
    });
    assert.ok('refused' in integration.bindToolInput!('message.reply', { text: 'hi', key: 'r', sourceMessageId: 'other' }, trigger));
    assert.ok('refused' in integration.bindToolInput!('message.reply', { text: 1 } as unknown as JsonValue, trigger));
    assert.ok('refused' in integration.bindToolInput!('message.reply', { text: 'hi', key: 'r' }, { ...trigger, source: { ...trigger.source, provider: 'slack' } }));
});
test('deliver maps host refusals to not-applied and returns the host receipt', () => {
    const seen: PiBotReplyInput[] = [];
    const ok = makePiBotIntegration({ reply: i => (seen.push(i), { outboxId: 'o1' }) });
    const input = { sourceMessageId: 'e1', conversationId: 'c', threadId: 'main', text: 'hi', key: 'r' };
    const effect = { schemaVersion: '0.1', id: 'x', eventId: 'e1', integrationId: 'pi-bot', operation: 'message.reply', idempotencyKey: 'x', input };
    assert.deepEqual(Effect.runSync(ok.deliver(effect)), { providerReceipt: { outboxId: 'o1' } });
    assert.equal(seen.length, 1);
    const stale = makePiBotIntegration({ reply: () => { throw new PiBotReplyNotApplied('Task superseded'); } });
    const exit = Effect.runSyncExit(stale.deliver(effect));
    assert.ok(Exit.isFailure(exit) && exit.cause._tag === 'Fail' && exit.cause.error.effectState === 'not-applied');
    const bad = Effect.runSyncExit(ok.deliver({ ...effect, operation: 'message.send' }));
    assert.ok(Exit.isFailure(bad));
});
test('reply host: grant, freshness conflict with seen-revision advance, idempotent replay, receipts', () => {
    const db = new DatabaseSync(':memory:');
    const delivered: PiBotReplyInput[] = [];
    const host = new OpenMatterReplyHost(db, new Map([['pi-bot', makePiBotIntegration({ reply: i => (delivered.push(i), { outboxId: `o${delivered.length}` }) })]]));
    const first = envelope({ text: 'status?' });
    const trigger = workEventForEnvelope(first);
    assert.equal(host.record(trigger)?.revision, 1);
    assert.equal(host.record(trigger)?.revision, 1, 'idempotent by event id');
    host.record(workEventForEnvelope(envelope({ kind: 'bot', from: 'bot-b', text: 'peer' })));
    host.record(workEventForEnvelope(envelope({ route: { ...route, threadId: 'side' }, text: 'other thread' })));
    const params = (key: string, text = 'ok') => ({ integrationId: 'pi-bot', operation: 'message.reply', input: { text, key } });
    assert.equal(host.call({ turnId: 't', callId: 'denied', trigger, allow: [], seen: { revision: 0 }, params: params('denied') }).status, 'refused');
    // Peer/app messages and other threads do not make the reply stale.
    const ok = host.call({ turnId: 't', callId: 'a', trigger, allow: [PI_BOT_REPLY_TOOL], seen: { revision: 0 }, params: params('a') });
    assert.deepEqual(ok, { status: 'delivered', receipt: { outboxId: 'o1' } });
    assert.deepEqual(host.getCall('t', 'a')?.conversation?.revision, 3);
    assert.deepEqual(host.call({ turnId: 't', callId: 'a', trigger, allow: [PI_BOT_REPLY_TOOL], seen: { revision: 0 }, params: params('a') }), ok);
    assert.equal(delivered.length, 1, 'replay does not deliver twice');
    assert.equal(host.call({ turnId: 't', callId: 'a', trigger, allow: [PI_BOT_REPLY_TOOL], seen: { revision: 0 }, params: params('a', 'changed') }).status, 'fingerprint-mismatch');
    host.record(workEventForEnvelope(envelope({ text: 'Correction: failures only' })));
    const seen = { revision: 0 };
    const stale = host.call({ turnId: 't', callId: 'b', trigger, allow: [PI_BOT_REPLY_TOOL], seen, params: params('b') });
    assert.equal(stale.status, 'conflict');
    assert.ok(stale.status === 'conflict' && stale.effect === 'not-applied' && stale.conflict.messages[0]!.text === 'Correction: failures only');
    assert.equal(seen.revision, 4);
    assert.equal(delivered.length, 1, 'nothing delivered on conflict');
    // Having been shown the newer message, the Agent may reply again with a new call.
    assert.equal(host.call({ turnId: 't', callId: 'c', trigger, allow: [PI_BOT_REPLY_TOOL], seen, params: params('c') }).status, 'delivered');
});
