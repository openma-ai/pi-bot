import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store, type Envelope } from '../src/daemon/runtime/store.ts';
import { ChannelMessageReader, redactChannelText } from '../src/daemon/runtime/channel-messages.ts';
test('GUI reader persists both directions, paginates and incrementally reports delivery failure', async () => {
    await mkdir(resolve('work/proactive-tests'), {
        recursive: true
    });
    const dir = await mkdtemp(resolve('work/proactive-tests/messages-'));
    const path = join(dir, 'runtime.db');
    let store = new Store(path);
    const incoming = (id: string, channelId = 'alpha'): Envelope => ({
        id, to: 'bot', from: 'alice', kind: 'user', text: 'hello', taskId: id, replyTo: null, hop: 0, key: id, state: 'queued', createdAt: 100, route: {
            channelId, threadId: 'thread', senderId: 'alice'
        }
    });
    let reader: ChannelMessageReader | undefined;
    try {
        store.put('inbox', incoming('one'));
        store.put('inbox', incoming('two'));
        store.put('inbox', incoming('foreign', 'beta'));
        reader = new ChannelMessageReader(path, {
            channels: ['alpha']
        });
        const first = reader.list({
            channelId: 'alpha', limit: 1
        });
        assert.equal(first.items[0].messageId, 'one');
        assert.equal(first.hasMore, true);
        const second = reader.list({
            channelId: 'alpha', after: first.nextCursor, limit: 1
        });
        assert.equal(second.items[0].messageId, 'two');
        assert.throws(() => reader!.list({
            channelId: 'beta'
        }), /scope/i);
        store.put('outbox', {
            id: 'reply', botId: 'bot', taskId: 'one', replyTo: 'one', key: 'reply', text: 'actual result', state: 'pending', createdAt: 150, route: incoming('one').route
        });
        const updates = reader.changes({
            channelId: 'alpha', after: first.changeCursor
        });
        assert.equal(updates.items.at(-1)?.direction, 'outbound');
        assert.equal(updates.items.at(-1)?.status, 'pending');
        store.put('outbox', {
            ...store.get<any>('outbox', 'reply'), state: 'uncertain'
        });
        const failure = reader.changes({
            channelId: 'alpha', after: updates.nextCursor
        });
        assert.equal(failure.items.length, 1);
        assert.equal(failure.items[0].status, 'uncertain');
        assert.equal(failure.items[0].causationId, 'one');
        reader.close();
        reader = undefined;
        store.close();
        store = new Store(path);
        reader = new ChannelMessageReader(path, {
            channels: ['alpha']
        });
        assert.equal(reader.list({
            channelId: 'alpha', direction: 'outbound'
        }).items[0].messageId, 'reply');
        const before = reader.changes({
            channelId: 'alpha'
        }).items.length;
        store.put('inbox', incoming('one'));
        assert.equal(reader.changes({
            channelId: 'alpha'
        }).items.length, before, 'identical persistence is not another receive event');
        assert.equal(reader.list({
            channelId: 'alpha', threadId: 'other'
        }).items.length, 0);
        store.put('inbox', {
            ...incoming('other-conversation'), route: {
                ...incoming('one').route!, conversationId: 'other'
            }
        });
        assert.equal(reader.list({
            channelId: 'alpha', conversationId: 'other'
        }).items.length, 1);
    }
    finally {
        reader?.close();
        store.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('channel redaction is stable across repeated persistence and handles JSON credential fields', () => {
    const text = redactChannelText('api_key=sk-fixture-secret-value');
    assert.equal(redactChannelText(text), text);
    assert.doesNotMatch(redactChannelText('{"password":"fixture-password-value"}'), /fixture-password-value/);
});
test('message projection excludes credential metadata and rollback leaves no ghost GUI event', async () => {
    await mkdir(resolve('work/proactive-tests'), {
        recursive: true
    });
    const dir = await mkdtemp(resolve('work/proactive-tests/messages-'));
    const path = join(dir, 'runtime.db');
    const store = new Store(path);
    const readerFactory = () => new ChannelMessageReader(path, {
        channels: ['local:bot']
    });
    let reader: ChannelMessageReader | undefined;
    try {
        const e: Envelope = {
            id: 'secret-test', to: 'bot', from: 'user', kind: 'user', text: 'api_key=sk-fixture-secret-value', taskId: 't', replyTo: null, hop: 0, key: 'test', state: 'queued', createdAt: 1
        };
        assert.throws(() => store.transaction(() => {
            store.put('inbox', e);
            throw Error('rollback');
        }), /rollback/);
        reader = readerFactory();
        assert.equal(reader.list({
            channelId: 'local:bot'
        }).items.length, 0);
        store.put('inbox', e);
        const message = reader.list({
            channelId: 'local:bot'
        }).items[0];
        assert.doesNotMatch(JSON.stringify(message), /sk-fixture-secret-value/);
        assert.equal(message.sourceKind, 'user');
        assert.equal(message.recipient, 'bot');
    }
    finally {
        reader?.close();
        store.close();
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
