import { request as httpRequest } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { Store } from '../src/daemon/runtime/store.ts';
import { CredentialBroker } from '../src/daemon/runtime/credentials.ts';
import { listenHttp } from '../src/daemon/transports/http.ts';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
function fixture() {
    const path = join(mkdtempSync(join(tmpdir(), 'pi-invariant-')), 'runtime.db');
    return {
        path, runtime: new BotRuntime(path, async () => ({
            run: async () => {
            }, close: async () => {
            }
        }))
    };
}
test('I1: repeated inbox key is one record and different payload conflicts', async () => {
    const { runtime: r } = fixture();
    try {
        const b = r.createBot('A');
        const e = r.accept({
            to: b.id, text: 'work', key: 'k'
        });
        assert.equal(r.accept({
            to: b.id, text: 'work', key: 'k'
        }).id, e.id);
        assert.throws(() => r.accept({
            to: b.id, text: 'other', key: 'k'
        }), /conflict/i);
    }
    finally {
        await r.close();
    }
});
test('I2: recovered execution is uncertain and is never automatically replayed', async () => {
    const { path, runtime: r } = fixture();
    const b = r.createBot('A');
    r.store.put('jobs', {
        id: 'effect', botId: b.id, taskId: 'task', messageId: 'message', key: 'k', tool: 'effect', args: {}, state: 'running', createdAt: 1
    });
    await r.close();
    const store = new Store(path);
    try {
        store.recover();
        assert.equal(store.get<any>('jobs', 'effect').state, 'uncertain');
    }
    finally {
        store.close();
    }
});
test('I3: uncertain inbox cannot be reconciled without correlated evidence', async () => {
    const { runtime: r } = fixture();
    try {
        const b = r.createBot('A');
        const e = r.accept({
            to: b.id, text: 'work', key: 'k'
        });
        await r.idle();
        r.store.put('inbox', {
            ...e, state: 'uncertain'
        });
        assert.throws(() => r.reconcileInbox(e.id, {
            outcome: 'processed', evidence: []
        }), /evidence/i);
        assert.throws(() => r.reconcileInbox(e.id, {
            outcome: 'queued', evidence: ['unproven']
        }), /note/i);
    }
    finally {
        await r.close();
    }
});
test('I4: two live runtime owners cannot open the same database', async () => {
    const { path, runtime: r } = fixture();
    try {
        assert.throws(() => new BotRuntime(path, async () => ({
            run: async () => {
            }, close: async () => {
            }
        })), /owned|lock/i);
    }
    finally {
        await r.close();
    }
});
test('I5: recognizable secrets are removed before channel and event persistence', async () => {
    const { runtime: r } = fixture();
    try {
        const b = r.createBot('A');
        r.accept({
            to: b.id, text: 'api_key=fixture-key sk-0123456789abcdef', key: 'k'
        });
        await r.idle();
        assert.ok(!JSON.stringify(r.store.list('inbox')).includes('fixture-key'));
        assert.ok(!JSON.stringify(r.store.events.read(0)).includes('0123456789abcdef'));
    }
    finally {
        await r.close();
    }
});
test('I6: peer routing cannot escape an inherited group', async () => {
    const { runtime: r } = fixture();
    try {
        const a = r.createBot('A'), b = r.createBot('B'), c = r.createBot('C');
        const g = r.createGroup('room', [a.id, b.id]);
        const e = r.accept({
            to: a.id, text: 'work', key: 'k', route: {
                channelId: g.id, threadId: 'thread', senderId: 'user'
            }
        });
        await r.idle();
        assert.throws(() => r.sendToBot(e, c.id, 'leak', 'leak'), /channel/i);
    }
    finally {
        await r.close();
    }
});
test('I7: cancelled task cannot commit a new tool or peer effect', async () => {
    const { runtime: r } = fixture();
    try {
        const b = r.createBot('A');
        const e = r.accept({
            to: b.id, text: 'work', key: 'k'
        });
        await r.idle();
        r.accept({
            to: b.id, text: 'cancel', taskId: e.taskId, taskControl: 'cancel', key: 'cancel'
        });
        assert.throws(() => r.assertTaskCurrent(e), /cancelled/i);
    }
    finally {
        await r.close();
    }
});
test('I8: credential values remain inside the direct broker boundary', async () => {
    const b = new CredentialBroker();
    try {
        const scope = {
            botId: 'bot', taskId: 'task', tool: 'service'
        };
        const form = b.request(scope, 'Token');
        const ref = b.submit(form.requestId, scope, 'private-fixture-value');
        assert.ok(!JSON.stringify(b).includes('private-fixture-value'));
        assert.equal((await b.use(ref.reference, scope, async (value) => assert.equal(value, 'private-fixture-value'))).state, 'completed');
        await assert.rejects(b.use(ref.reference, scope, async () => {
        }));
    }
    finally {
        b.close();
    }
});
test('I9: loopback HTTP requires ownership and rejects forged Host or Origin', async () => {
    const d = await PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-auth-invariant-')), factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    const http = await listenHttp(d, {
        port: 0
    });
    try {
        assert.equal((await fetch(http.url + '/rpc', {
            method: 'POST', body: '{}'
        })).status, 401);
        assert.equal(await new Promise<number>(resolve => {
            const req = httpRequest(http.url + '/rpc', {
                method: 'POST', headers: {
                    host: 'evil.invalid', authorization: 'Bearer ' + http.token
                }
            }, res => {
                res.resume();
                resolve(res.statusCode!);
            });
            req.end('{}');
        }), 403);
        assert.equal((await fetch(http.url + '/rpc', {
            method: 'POST', headers: {
                origin: 'https://evil.invalid', authorization: 'Bearer ' + http.token
            }, body: '{}'
        })).status, 403);
    }
    finally {
        await http.close();
        await d.close();
    }
});
