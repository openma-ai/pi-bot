import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { PiBotClient, PiBotApiError } from '../src/sdk/client.ts';
import type { NotificationEntry, NotificationPreferences } from '../src/sdk/notification-types.ts';
import type { Envelope } from '../src/pi/types.ts';

const factory = async () => ({ async run() {}, async close() {} });
async function clientFor(d: PiBotDaemon, owner: string) {
    let connection!: ReturnType<PiBotDaemon['connect']>;
    const client = await PiBotClient.connect({ transport: { inProcess: {
        connect() {
            connection = d.connect('notification-fixture');
            connection.fileOwner = owner;
            return connection;
        }
    } } });
    return { client, get connection() { return connection; } };
}
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'notification-sdk-'));
    let daemon = await PiBotDaemon.create({ dataDir: dir, factory });
    const clients: PiBotClient[] = [];
    return {
        get daemon() { return daemon; },
        async client(owner: string) {
            const result = await clientFor(daemon, owner);
            clients.push(result.client);
            return result;
        },
        async restart() {
            for (const c of clients.splice(0)) c.close();
            await daemon.close();
            daemon = await PiBotDaemon.create({ dataDir: dir, factory });
        },
        async close() {
            for (const c of clients) c.close();
            await daemon.close();
            await rm(dir, { recursive: true, force: true });
        }
    };
}

test('notification SDK preferences are typed, disabled by default and scoped to authenticated owner', async () => {
    const h = await fixture();
    try {
        const a = await h.client('alice'), b = await h.client('bob');
        const defaults: NotificationPreferences = (await a.client.notification.preferences({})).preferences;
        assert.equal(defaults.enabled, false);
        const configured: NotificationPreferences = (await a.client.notification.configure({
            enabled: true, timezone: 'Asia/Shanghai', quiet: { startMinute: 1320, endMinute: 480 }
        })).preferences;
        assert.equal(configured.enabled, true);
        assert.equal(configured.timezone, 'Asia/Shanghai');
        assert.deepEqual(configured.quiet, { startMinute: 1320, endMinute: 480 });
        assert.equal((await b.client.notification.preferences({})).preferences.enabled, false);
        await assert.rejects(a.client.notification.configure({ enabled: true, timezone: 'Bad/Zone' }));
        await assert.rejects(a.client.notification.configure({
            enabled: true, timezone: 'UTC', quiet: { startMinute: -1, endMinute: 1440 }
        }), (e: unknown) => e instanceof PiBotApiError && e.reason === 'invalidParams');
        // Also exercise daemon-side validation instead of relying on SDK rejection.
        for (const method of ['notification/list', 'notification/preferences', 'notification/configure']) {
            const params = method === 'notification/configure' ? { enabled: true, timezone: 'UTC', ownerId: 'bob' } : { ownerId: 'bob' };
            const response = await a.connection.request({ id: 'spoof', method, params });
            assert.equal(response.error?.data.reason, 'invalidParams');
        }
        for (const method of ['notification/flush', 'notification/publishResult']) {
            const response = await a.connection.request({ id: 'host-only', method, params: {} });
            assert.equal(response.error?.code, -32601);
        }
        assert.equal((await a.client.notification.preferences({})).preferences.timezone, 'Asia/Shanghai');
    }
    finally { await h.close(); }
});

test('notification list/read follow canonical request state without granting approval or broadcasting owner payloads', async () => {
    const h = await fixture();
    try {
        const a = await h.client('alice'), b = await h.client('bob');
        const { bot } = await a.client.bot.create({ name: 'notification fixture' });
        const turn = await a.client.turn.start({ botId: bot.id, text: 'fixture task', key: 'notify-origin' });
        await h.daemon.runtime.idle();
        const source = h.daemon.runtime.store.get<Envelope>('inbox', turn.inputId)!;
        assert.equal(source.fileOwner, 'alice');
        const before = await b.client.daemon.snapshot({});
        const events: string[] = [];
        const stop = await b.client.events.subscribe({ after: before.seq }, e => events.push(e.method));
        const request = h.daemon.broker.create('approval', source, {
            botId: bot.id, taskId: source.taskId, tool: 'fixture_tool', args: { fixture: true }
        }, Date.now() + 60000);
        const entries: NotificationEntry[] = (await a.client.notification.list({})).notifications;
        assert.equal(entries.length, 1);
        assert.equal(entries[0].kind, 'action_required');
        assert.equal(entries[0].reference.id, request.id);
        assert.equal(entries[0].sourceMessageId, source.id);
        assert.deepEqual((await b.client.notification.list({})).notifications, []);
        await assert.rejects(b.client.notification.read({ notificationId: entries[0].id }));
        const spoof = await b.connection.request({ id: 'spoof-read', method: 'notification/read', params: { notificationId: entries[0].id, ownerId: 'alice' } });
        assert.equal(spoof.error?.data.reason, 'invalidParams');
        const read: NotificationEntry = (await a.client.notification.read({ notificationId: entries[0].id })).notification;
        assert.equal(read.status, 'read');
        assert.equal(h.daemon.broker.list().find(r => r.id === request.id)!.status, 'pending');
        assert.equal(read.delivery.attempts, 0);
        assert.equal((await a.client.notification.list({})).notifications.length, 1);
        h.daemon.broker.finish(request, 'resolved', { decision: 'deny' }, 'fixture');
        assert.equal((await a.client.notification.read({ notificationId: entries[0].id })).notification.status, 'resolved');
        assert.equal((await a.client.notification.list({})).notifications[0].status, 'resolved');
        assert.ok(!events.some(method => method.startsWith('notification/')), 'notification payloads do not enter the shared event stream');
        stop();
    }
    finally { await h.close(); }
});

test('notification SDK preferences and read receipts survive daemon restart', async () => {
    const h = await fixture();
    try {
        const a = await h.client('alice');
        await a.client.notification.configure({ enabled: true, timezone: 'UTC' });
        const { bot } = await a.client.bot.create({ name: 'restart fixture' });
        const turn = await a.client.turn.start({ botId: bot.id, text: 'question fixture', key: 'question-source' });
        await h.daemon.runtime.idle();
        const source = h.daemon.runtime.store.get<Envelope>('inbox', turn.inputId)!;
        h.daemon.broker.create('question', source, { botId: bot.id, taskId: source.taskId, text: 'Choose fixture option' });
        const [entry] = (await a.client.notification.list({})).notifications;
        const read = (await a.client.notification.read({ notificationId: entry.id })).notification;
        await h.restart();
        const reopened = await h.client('alice'), other = await h.client('bob');
        assert.equal((await reopened.client.notification.preferences({})).preferences.enabled, true);
        const restored = (await reopened.client.notification.list({})).notifications;
        assert.equal(restored.length, 1);
        assert.equal(restored[0].id, entry.id);
        assert.equal(restored[0].status, 'read');
        assert.equal(restored[0].readAt, read.readAt);
        assert.deepEqual((await other.client.notification.list({})).notifications, []);
        assert.equal((await other.client.notification.preferences({})).preferences.enabled, false);
        await h.daemon.notifications.flush();
        assert.equal((await reopened.client.notification.list({})).notifications[0].delivery.attempts, 0);
    }
    finally { await h.close(); }
});

test('notifications created after a question answer retain the original authenticated owner', async () => {
    const h = await fixture();
    try {
        const a = await h.client('alice'), local = await h.client('local');
        const { bot } = await a.client.bot.create({ name: 'answer fixture' });
        const turn = await a.client.turn.start({ botId: bot.id, text: 'follow-up task', key: 'answer-origin' });
        await h.daemon.runtime.idle();
        const source = h.daemon.runtime.store.get<Envelope>('inbox', turn.inputId)!;
        const question = h.daemon.runtime.askUser(source, 'Choose fixture option', 'fixture-question');
        h.daemon.runtime.answer(question.id, 'continue', 'fixture-answer');
        await h.daemon.runtime.idle();
        const answer = h.daemon.runtime.store.list<Envelope>('inbox').find(e => e.kind === 'answer')!;
        assert.equal(answer.fileOwner, undefined, 'answer ownership is inherited through its source');
        const request = h.daemon.broker.create('approval', answer, {
            botId: bot.id, taskId: answer.taskId, tool: 'fixture-follow-up'
        }, Date.now() + 60000);
        const own = (await a.client.notification.list({})).notifications;
        assert.ok(own.some(n => n.reference.id === request.id));
        assert.deepEqual((await local.client.notification.list({})).notifications, []);
    }
    finally { await h.close(); }
});

test('SDK steer and interrupt retain authenticated owner on new task-control inputs', async () => {
    const h = await fixture();
    try {
        const a = await h.client('alice'), local = await h.client('local');
        const { bot } = await a.client.bot.create({ name: 'steer fixture' });
        const turn = await a.client.turn.start({ botId: bot.id, text: 'initial task', key: 'steer-origin' });
        await h.daemon.runtime.idle();
        const steered = await a.client.turn.steer({ threadId: turn.threadId, text: 'updated task', key: 'steer-replacement' });
        await h.daemon.runtime.idle();
        const replacement = h.daemon.runtime.store.get<Envelope>('inbox', steered.inputId)!;
        assert.equal(replacement.fileOwner, 'alice');
        const request = h.daemon.broker.create('approval', replacement, {
            botId: bot.id, taskId: replacement.taskId, tool: 'fixture-steered-tool'
        }, Date.now() + 60000);
        assert.ok((await a.client.notification.list({})).notifications.some(n => n.reference.id === request.id));
        assert.deepEqual((await local.client.notification.list({})).notifications, []);
        const interrupted = await a.client.turn.interrupt({ threadId: turn.threadId, key: 'steer-cancel' });
        await h.daemon.runtime.idle();
        assert.equal(h.daemon.runtime.store.get<Envelope>('inbox', interrupted.inputId)!.fileOwner, 'alice');
        assert.equal((await a.client.notification.list({})).notifications.find(n => n.reference.id === request.id)!.status, 'superseded');
    }
    finally { await h.close(); }
});
