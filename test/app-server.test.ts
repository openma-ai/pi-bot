import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const modulePath = '../src/daemon/core/daemon.ts';
const loaded = await import(modulePath).catch(() => undefined);
test('app-server handshake, validation and idempotent native inbox use one protocol', async () => {
    assert.ok(loaded?.PiBotDaemon, 'App-server daemon must exist');
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-rpc-')), factory: async (_b: any, host: any) => ({
            run: async (e: any) => {
                host.sendMessage(e, 'result', 'reply');
            }, close: async () => {
            }
        })
    });
    const c = d.connect('in-process');
    const call = (method: string, params: any = {}) => c.request({
        id: 1, method, params
    });
    try {
        assert.equal((await call('bot/list')).error.data.reason, 'notInitialized');
        assert.equal((await call('initialize', {
            clientInfo: {
                name: 'test', version: '1'
            }, protocolVersion: 'wrong'
        })).error.data.reason, 'invalidRequest');
        const init = await call('initialize', {
            clientInfo: {
                name: 'test', version: '1'
            }, protocolVersion: '2026-10-13'
        });
        assert.ok(init.result.connectionId);
        assert.equal((await call('bot/list')).error.data.reason, 'notInitialized');
        await c.request({
            method: 'initialized'
        });
        assert.equal((await call('initialize', {
            clientInfo: {
                name: 'test', version: '1'
            }, protocolVersion: '2026-10-13'
        })).error.data.reason, 'alreadyInitialized');
        assert.equal((await call('bot/create', {
            name: ''
        })).error.data.reason, 'invalidParams');
        assert.ok((await call('bot/create', {
            name: ''
        })).error.data.details.paths.length);
        const bot = (await call('bot/create', {
            name: 'A'
        })).result.bot;
        const one = (await call('turn/start', {
            botId: bot.id, text: 'work', key: 'same'
        })).result;
        const two = (await call('turn/start', {
            botId: bot.id, text: 'work', key: 'same'
        })).result;
        assert.equal(one.inputId, two.inputId);
        assert.equal((await call('turn/start', {
            botId: bot.id, text: 'changed', key: 'same'
        })).error.data.reason, 'conflict');
        await d.runtime.idle();
        await d.runtime.deliver(async () => {
        });
        const snapshot = (await call('daemon/snapshot')).result;
        assert.ok(!JSON.stringify(snapshot).includes('token'));
        assert.ok(snapshot.turns.some((t: any) => t.status === 'completed'));
        assert.ok(snapshot.items.some((i: any) => i.type === 'agentMessage' && i.text === 'result'));
    }
    finally {
        c.close();
        await d.close();
    }
});
test('durable event transactions roll back, replay without gaps and survive restart', async () => {
    assert.ok(loaded?.PiBotDaemon);
    const dataDir = mkdtempSync(join(tmpdir(), 'pi-events-'));
    const factory = async () => ({
        run: async () => {
        }, close: async () => {
        }
    });
    let d = await loaded.PiBotDaemon.create({
        dataDir, factory
    });
    try {
        const seq = d.log.seq, seen: any[] = [];
        const sub = d.log.subscribe(seq, (e: any) => seen.push(e));
        assert.throws(() => d.runtime.store.transaction(() => {
            d.runtime.createBot('rollback');
            throw Error('rollback');
        }));
        assert.equal(d.log.seq, seq);
        assert.equal(seen.length, 0);
        d.runtime.store.transaction(() => {
            d.runtime.createBot('A');
            d.runtime.createBot('B');
        });
        assert.deepEqual(seen.map(e => e.seq), [seq + 1, seq + 2]);
        sub.close();
        const before = d.log.seq;
        await d.close();
        d = await loaded.PiBotDaemon.create({
            dataDir, factory
        });
        const replay: any[] = [];
        const next = d.log.subscribe(before, (e: any) => replay.push(e));
        d.runtime.createBot('after restart');
        assert.equal(replay.at(-1).seq, d.log.seq);
        assert.deepEqual(replay.map(e => e.seq), Array.from({
            length: d.log.seq - before
        }, (_, i) => before + i + 1));
        next.close();
        d.log.compact(Date.now() + 8 * 86400000, 7 * 86400000, 1);
        assert.throws(() => d.log.read(before), (e: any) => e.reason === 'cursorExpired');
    }
    finally {
        await d.close();
    }
});
test('shared reducer reproduces committed snapshots for 200 generated operation sequences', async () => {
    const path = '../src/sdk/state/reducer.ts';
    const reducer = await import(path).catch(() => undefined);
    assert.ok(reducer?.createDaemonStore, 'Shared reducer must exist');
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-reducer-')), factory: async (_b: any, host: any) => ({
            run: async (e: any) => host.sendMessage(e, 'verified', 'reply-' + e.id), close: async () => {
            }
        })
    });
    try {
        let seed = 17;
        const random = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        for (let i = 0; i < 200; i++) {
            const initial = d.snapshot();
            const state = reducer.createDaemonStore(initial);
            const sub = d.log.subscribe(initial.seq, (e: any) => state.apply(e));
            const bots = d.runtime.listBots();
            let bot = bots[Math.floor(random() * bots.length)];
            if (!bot || (random() < .08 && bots.length < 16))
                bot = d.runtime.createBot('bot-' + i);
            const e = d.runtime.accept({
                to: bot.id, text: 'task ' + i, key: 'k' + i
            });
            await d.runtime.idle();
            await d.runtime.deliver(async () => {
            });
            if (random() < .2)
                await d.runtime.unloadThread(d.runtime.tracker.ensure(e).id);
            sub.close();
            assert.deepEqual(state.get(), reducer.createDaemonStore(d.snapshot()).get());
        }
    }
    finally {
        await d.close();
    }
});
test('HTTP bearer and browser cookie/CSRF transport enforce the same protocol', async () => {
    const path = '../src/daemon/transports/http.ts';
    const http = await import(path).catch(() => undefined);
    assert.ok(http?.listenHttp, 'HTTP RPC transport must exist');
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-http-')), factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    const server = await http.listenHttp(d, {
        port: 0
    });
    try {
        const url = server.url;
        assert.equal((await fetch(url + '/rpc', {
            method: 'POST', body: '{}'
        })).status, 401);
        assert.equal((await fetch(url + '/readyz', {
            headers: {
                origin: 'https://evil.invalid'
            }
        })).status, 403);
        const index = await fetch(url + '/');
        const html = await index.text();
        const cookie = index.headers.get('set-cookie')!.split(';')[0];
        const csrf = html.match(/name="pibot-csrf" content="([^"]+)"/)![1];
        const frame = {
            id: 1, method: 'initialize', params: {
                clientInfo: {
                    name: 'http', version: '1'
                }, protocolVersion: '2026-10-13'
            }
        };
        assert.equal((await fetch(url + '/rpc', {
            method: 'POST', headers: {
                cookie
            }, body: JSON.stringify(frame)
        })).status, 403);
        assert.equal((await fetch(url + '/rpc', {
            method: 'POST', headers: {
                cookie, 'x-pibot-csrf': csrf, origin: 'https://evil.invalid'
            }, body: JSON.stringify(frame)
        })).status, 403);
        const init = await fetch(url + '/rpc', {
            method: 'POST', headers: {
                cookie, 'x-pibot-csrf': csrf
            }, body: JSON.stringify(frame)
        });
        assert.equal(init.status, 200);
        const { result } = await init.json();
        const active = await fetch(url + '/rpc', {
            method: 'POST', headers: {
                cookie, 'x-pibot-csrf': csrf, 'x-pibot-connection': result.connectionId
            }, body: JSON.stringify({
                method: 'initialized'
            })
        });
        assert.equal(active.status, 204);
        const { PiBotClient } = await import('../src/sdk/client.ts');
        const client = await PiBotClient.connect({
            transport: {
                http: url, token: server.token
            }
        });
        const snapshot = await client.daemon.snapshot({});
        assert.ok(!JSON.stringify(snapshot).includes(server.token));
        const events: any[] = [];
        await client.events.subscribe({
            after: snapshot.seq
        }, e => events.push(e));
        await client.bot.create({
            name: 'remote'
        });
        await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(Error('SSE event missing')), 1000);
            const check = () => {
                if (events.some(e => e.method === 'bot/created')) {
                    clearTimeout(deadline);
                    resolve();
                }
                else
                    setTimeout(check, 10);
            };
            check();
        });
        client.close();
    }
    finally {
        await server.close();
        await d.close();
    }
});
test('draining rejects new work and timeout preserves uncertain effects without replay', async () => {
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-drain-')), factory: async () => ({
            run: async () => new Promise<void>(() => {
            }), close: async () => {
            }
        })
    });
    const c = d.connect('in-process');
    await c.request({
        id: 1, method: 'initialize', params: {
            clientInfo: {
                name: 'test', version: '1'
            }, protocolVersion: '2026-10-13'
        }
    });
    await c.request({
        method: 'initialized'
    });
    const bot = d.runtime.createBot('hung');
    d.runtime.accept({
        to: bot.id, text: 'work', key: 'hung'
    });
    await new Promise(r => setTimeout(r, 5));
    const closing = d.close(20);
    assert.equal((await c.request({
        id: 2, method: 'turn/start', params: {
            botId: bot.id, text: 'new', key: 'new'
        }
    })).error.data.reason, 'shuttingDown');
    await Promise.race([closing, new Promise((_, reject) => setTimeout(() => reject(Error('Drain did not time out')), 500))]);
    assert.equal(d.status, 'stopped');
    let runs = 0;
    const next = await loaded.PiBotDaemon.create({
        dataDir: d.dataDir, factory: async () => ({
            run: async () => {
                runs++;
            }, close: async () => {
            }
        })
    });
    try {
        assert.equal(next.runtime.store.list('inbox')[0].state, 'uncertain');
        assert.equal(runs, 0);
    }
    finally {
        await next.close();
    }
});
test('persistent requests resolve once across clients and preserve questions across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-requests-'));
    let d = await loaded.PiBotDaemon.create({
        dataDir: dir, factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    const bot = d.runtime.createBot('ask');
    const e = d.runtime.accept({
        to: bot.id, text: 'question task', key: 'task'
    });
    await d.runtime.idle();
    d.runtime.askUser(e, 'Which value?', 'question');
    const req = d.broker.list().find((r: any) => r.kind === 'question');
    assert.ok(req);
    await d.close();
    d = await loaded.PiBotDaemon.create({
        dataDir: dir, factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    try {
        const restored = d.broker.list().find((r: any) => r.id === req.id);
        assert.equal(restored.status, 'pending');
        const first = d.broker.resolve(req.id, {
            text: '42'
        }, 'A');
        assert.equal(d.broker.resolve(req.id, {
            text: '42'
        }, 'B').id, first.id);
        assert.throws(() => d.broker.resolve(req.id, {
            text: '43'
        }, 'B'), (e: any) => e.reason === 'conflict');
        await d.runtime.idle();
        assert.equal(d.runtime.store.list('inbox').filter((e: any) => e.kind === 'answer').length, 1);
    }
    finally {
        await d.close();
    }
});
test('safe thread unload blocks every active dependency and archive refuses new turns', async () => {
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-threads-')), factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    const { PiBotClient } = await import('../src/sdk/client.ts');
    const c = await PiBotClient.connect({
        transport: {
            inProcess: d
        }
    });
    try {
        const { bot } = await c.bot.create({
            name: 'thread'
        });
        const input = await c.turn.start({
            botId: bot.id, text: 'work', key: 'first'
        });
        await d.runtime.idle();
        const thread = d.runtime.store.get('threads', input.threadId);
        assert.equal(thread.status, 'loaded');
        const source = d.runtime.store.get('inbox', input.inputId);
        let release: () => void = () => {
        };
        const job = d.runtime.startJob(source, 'slow', {}, 'slow', () => new Promise(resolve => {
            release = () => resolve({
                ok: true
            });
        }));
        await new Promise(r => setTimeout(r, 1));
        assert.ok((await c.thread.unload({
            threadId: thread.id
        })).blockedBy?.includes('runningJob'));
        release();
        await d.runtime.idle();
        const pending = d.broker.create('approval', source, {}, Date.now() + 60000);
        assert.ok((await c.thread.unload({
            threadId: thread.id
        })).blockedBy?.includes('pendingRequest'));
        d.broker.finish(pending, 'cancelled', undefined, 'test');
        assert.equal((await c.thread.unload({
            threadId: thread.id
        })).unloaded, true);
        await c.thread.archive({
            threadId: thread.id
        });
        await assert.rejects(c.turn.start({
            botId: bot.id, threadId: thread.id, text: 'new', key: 'new'
        }), (e: any) => e.reason === 'threadArchived');
        await c.thread.unarchive({
            threadId: thread.id
        });
        await c.turn.start({
            botId: bot.id, threadId: thread.id, text: 'new', key: 'new'
        });
        await d.runtime.idle();
    }
    finally {
        c.close();
        await d.close();
    }
});
test('plugin tool observations and usage are public but secrets and reasoning text are not', async () => {
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-plugin-events-')), factory: async (bot: any, host: any) => ({
            run: async (e: any) => {
                assert.ok(host.events, 'EventSink is required');
                host.events.emit(bot.id, {
                    type: 'toolStarted', toolCallId: 'native', tool: 'read', args: {
                        password: 'MUST_NOT_APPEAR'
                    }
                });
                host.events.emit(bot.id, {
                    type: 'toolCompleted', toolCallId: 'native', result: {
                        content: [{
                                type: 'thinking', text: 'PRIVATE_REASONING'
                            }, {
                                type: 'text', text: 'verified'
                            }]
                    }, isError: false
                });
                host.events.emit(bot.id, {
                    type: 'usage', input: 10, output: 5, cacheRead: 2, reasoning: 3, totalTokens: 17, costUsd: .01
                });
                host.sendMessage(e, 'result', 'reply');
            }, close: async () => {
            }
        })
    });
    try {
        const bot = d.runtime.createBot('native');
        d.runtime.accept({
            to: bot.id, text: 'work', key: 'work'
        });
        await d.runtime.idle();
        const snapshot = d.snapshot();
        assert.equal(snapshot.turns[0].usage.reasoning, 3);
        assert.equal(snapshot.usage.totalTokens, 17);
        assert.ok(snapshot.items.some((i: any) => i.toolCallId === 'native' && i.status === 'completed'));
        const log = JSON.stringify(d.log.read(0));
        assert.ok(!log.includes('MUST_NOT_APPEAR'));
        assert.ok(!log.includes('PRIVATE_REASONING'));
    }
    finally {
        await d.close();
    }
});
test('credential forms submit directly, never through RPC or persisted event payloads', async () => {
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-form-')), factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    try {
        assert.ok(d.credentials, 'Daemon must expose the native host credential port');
        const bot = d.runtime.createBot('credential');
        const e = d.runtime.accept({
            to: bot.id, text: 'needs credential', key: 'task'
        });
        await d.runtime.idle();
        const form = d.credentials.request({
            botId: bot.id, taskId: e.taskId, tool: 'external'
        }, 'Service token');
        const req = d.broker.list().find((r: any) => r.kind === 'credential');
        assert.ok(req.params.formUrl);
        assert.throws(() => d.broker.resolve(req.id, {
            submitted: true
        }, 'forged'), (e: any) => e.reason === 'invalidRequest');
        const submitted = d.credentials.submit(form.requestId, form.scope, 'fixture-private-value');
        assert.ok(submitted.reference);
        assert.equal(d.broker.list().find((r: any) => r.id === req.id).status, 'resolved');
        assert.ok(!JSON.stringify(d.log.read(0)).includes('fixture-private-value'));
        assert.throws(() => d.broker.resolve(req.id, {
            secret: 'anything'
        }, 'bad'), (e: any) => e.reason === 'conflict' || e.reason === 'invalidParams');
    }
    finally {
        await d.close();
    }
});
test('migration preserves existing message history without fabricating historical events', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'pi-migrate-'));
    const db = new DatabaseSync(join(dir, 'runtime.db'));
    const bot = {
        id: 'legacy', name: 'Legacy', description: '', sessionFile: null, sessionFiles: {
            dca009a9415c94730a27cab5: 'legacy-session.jsonl'
        }, createdAt: 1
    };
    const input = {
        id: 'old-input', from: 'user', to: bot.id, text: 'old task', key: 'old', taskId: 'old-task', kind: 'user', state: 'processed', createdAt: 2, replyTo: null, hop: 0
    };
    const output = {
        id: 'old-output', botId: bot.id, taskId: 'old-task', replyTo: input.id, key: 'reply', text: 'old result', state: 'delivered', createdAt: 3, deliveredAt: 4
    };
    for (const [name, record] of [['bots', bot], ['inbox', input], ['outbox', output]] as const) {
        db.exec(`CREATE TABLE ${name}(id TEXT PRIMARY KEY,data TEXT NOT NULL)`);
        db.prepare(`INSERT INTO ${name} VALUES(?,?)`).run(record.id, JSON.stringify(record));
    }
    db.close();
    let runs = 0;
    const d = await loaded.PiBotDaemon.create({
        dataDir: dir, factory: async () => ({
            run: async () => {
                runs++;
            }, close: async () => {
            }
        })
    });
    try {
        const snapshot = d.snapshot();
        assert.deepEqual(snapshot.items.filter((i: any) => i.type === 'inputMessage' || i.type === 'agentMessage').map((i: any) => i.text), ['old task', 'old result']);
        assert.equal(runs, 0);
        assert.ok(!d.log.read(0).some((e: any) => e.method === 'item/completed' && ['inbox:old-input', 'outbox:old-output'].includes(e.params.item?.id)));
    }
    finally {
        await d.close();
    }
});
test('approval decisions and expiry gate effects and are observable to matching clients', async () => {
    let executions = 0;
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-approval-')), approvalRequired: true, approvalTimeoutMs: 30, factory: async (_b: any, host: any) => ({
            run: async (e: any) => {
                host.startJob(e, 'effect', {}, 'effect:' + e.id, async () => {
                    executions++;
                    return 'ok';
                }, {
                    quiet: true
                });
            }, close: async () => {
            }
        })
    });
    const { PiBotClient } = await import('../src/sdk/client.ts');
    const c = await PiBotClient.connect({
        transport: {
            inProcess: d
        }, capabilities: {
            serverRequests: ['approval']
        }
    });
    try {
        const { bot } = await c.bot.create({
            name: 'approve'
        });
        await c.events.subscribe({
            after: d.log.seq, filter: {
                botIds: [bot.id]
            }
        }, () => {
        });
        const requests: any[] = [];
        c.on('request', r => requests.push(r));
        await c.turn.start({
            botId: bot.id, text: 'work', key: 'approved'
        });
        await new Promise(r => setTimeout(r, 5));
        assert.equal(executions, 0);
        assert.ok(requests.length);
        await c.request.resolve({
            requestId: requests[0].params.request.id, response: {
                decision: 'approve'
            }
        });
        await d.runtime.idle();
        assert.equal(executions, 1);
        await c.turn.start({
            botId: bot.id, text: 'second', key: 'expired'
        });
        await new Promise(r => setTimeout(r, 40));
        d.broker.sweep();
        await d.runtime.idle();
        assert.equal(executions, 1);
        assert.ok(d.broker.list().some((r: any) => r.status === 'expired'));
    }
    finally {
        c.close();
        await d.close();
    }
});
test('native Pi thread unload reloads the same persisted context and continues through send_message', async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const { fauxProvider, fauxAssistantMessage: msg, fauxToolCall: call, InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
    const { piSessionFactory } = await import('../src/pi/session-factory.ts');
    const dir = mkdtempSync(join(tmpdir(), 'pi-reload-'));
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const faux = fauxProvider({
        provider: 'reload-fixture', models: [{
                id: 'fixture', contextWindow: 128000, maxTokens: 2048
            }], tokensPerSecond: 1000000
    });
    faux.setResponses([msg('First native context retained'), ctx => {
            assert.ok(JSON.stringify(ctx).includes('PERSISTED_CONTEXT_SENTINEL'));
            const source = ctx.messages.filter((m: any) => m.role === 'user').flatMap((m: any) => m.content).filter((b: any) => b.type === 'text').map((b: any) => {
                try {
                    return JSON.parse(b.text);
                }
                catch {
                    return undefined;
                }
            }).filter((e: any) => e?.type === 'inbox').at(-1);
            assert.ok(source?.messageId);
            return msg(call('send_message', {
                text: 'native resumed', key: 'resume', source_message_id: source.messageId
            }), {
                stopReason: 'toolUse'
            });
        }, msg('done')]);
    const d = await loaded.PiBotDaemon.create({
        dataDir: dir, factory: piSessionFactory({
            dir: join(dir, 'sessions'), modelRuntime: models, model: faux.getModel(), extensions: [pi => pi.registerProvider(faux.provider)]
        })
    });
    const { PiBotClient } = await import('../src/sdk/client.ts');
    const c = await PiBotClient.connect({
        transport: {
            inProcess: d
        }
    });
    try {
        const { bot } = await c.bot.create({
            name: 'native'
        });
        const first = await c.turn.start({
            botId: bot.id, text: 'PERSISTED_CONTEXT_SENTINEL', key: 'first'
        });
        await d.runtime.idle();
        const session = d.runtime.store.get('bots', bot.id).sessionFiles;
        assert.equal((await c.thread.unload({
            threadId: first.threadId
        })).unloaded, true);
        await c.turn.start({
            botId: bot.id, threadId: first.threadId, text: 'continue', key: 'second'
        });
        await d.runtime.idle();
        assert.deepEqual(d.runtime.store.get('bots', bot.id).sessionFiles, session);
        assert.ok(d.runtime.store.list('outbox').some((o: any) => o.text === 'native resumed'), JSON.stringify({
            errors: d.runtime.errors.map(String), inbox: d.runtime.store.list('inbox')
        }));
    }
    finally {
        c.close();
        await d.close();
    }
});
test('slow event transport retains frames until accepted and replay honors subscription scope', async () => {
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-slow-events-')), factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    const c = d.connect();
    try {
        const a = d.runtime.createBot('A'), b = d.runtime.createBot('B');
        c.push({
            seq: 1, at: 1, method: 'example', params: {}
        });
        const blocked = c.attach(() => false);
        blocked();
        const seen: any[] = [];
        c.attach((frame: any) => {
            seen.push(frame);
            return true;
        });
        assert.equal(seen[0].seq, 1);
        seen.length = 0;
        c.subscribe(d.log.seq, {
            botIds: [a.id]
        });
        const after = d.log.seq;
        d.runtime.store.transaction(() => d.log.append('bot/updated', {
            bot: {
                ...b, name: 'B2'
            }
        }, {
            botId: b.id
        }));
        seen.length = 0;
        c.replay(after);
        assert.ok(!seen.some(e => e.params.bot?.id === b.id));
        assert.ok(seen.some(e => e.method === 'events/watermark'));
    }
    finally {
        c.close();
        await d.close();
    }
});
test('desktop control accepts the released null lease through the SDK result schema', async () => {
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-desktop-rpc-')), factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    d.desktop = {
        request: async (_path: string, p: any) => ({
            json: async () => p.take ? {
                botId: p.botId, expiresAt: Date.now() + 60000
            } : null
        })
    } as any;
    const { PiBotClient } = await import('../src/sdk/client.ts');
    const c = await PiBotClient.connect({
        transport: {
            inProcess: d
        }
    });
    try {
        const { bot } = await c.bot.create({
            name: 'desktop'
        });
        assert.equal((await c.desktop.control({
            botId: bot.id, take: true
        }))!.botId, bot.id);
        assert.equal(await c.desktop.control({
            botId: bot.id, take: false
        }), null);
    }
    finally {
        c.close();
        await d.close();
    }
});
test('native Pi preserves a host budget refusal as budgetExhausted without calling the provider', async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const { fauxProvider, InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
    const { piSessionFactory } = await import('../src/pi/session-factory.ts');
    const hostModule = await import('../src/pi/host.ts');
    assert.ok(hostModule.ProviderRequestGuardError, 'Host guard reason must be represented separately from provider failures');
    const dir = mkdtempSync(join(tmpdir(), 'pi-guard-'));
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const faux = fauxProvider({
        provider: 'guard-fixture'
    });
    const d = await loaded.PiBotDaemon.create({
        dataDir: dir, factory: piSessionFactory({
            dir: join(dir, 'sessions'), modelRuntime: models, model: faux.getModel(), extensions: [pi => pi.registerProvider(faux.provider)], beforeProviderRequest() {
                throw new hostModule.ProviderRequestGuardError('budgetExhausted', 'Finite model reservation exhausted');
            }
        })
    });
    try {
        const bot = d.runtime.createBot('guard');
        d.runtime.accept({
            to: bot.id, text: 'work', key: 'one'
        });
        await d.runtime.idle();
        assert.equal(d.snapshot().turns[0].error.reason, 'budgetExhausted');
        assert.equal(faux.state.callCount, 0);
        assert.equal(d.runtime.store.list('outbox').length, 0);
    }
    finally {
        await d.close();
    }
});
test('native internal text requires debug capability and thinking never enters durable events', async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const { fauxProvider, fauxAssistantMessage: msg, fauxThinking, fauxText, InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
    const { piSessionFactory } = await import('../src/pi/session-factory.ts');
    const dir = mkdtempSync(join(tmpdir(), 'pi-debug-'));
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const faux = fauxProvider({
        provider: 'debug-fixture', tokensPerSecond: 1000000
    });
    faux.setResponses([msg([fauxThinking('THINKING_MUST_STAY_PRIVATE'), fauxText('Internal diagnostic text. '.repeat(20))])]);
    const d = await loaded.PiBotDaemon.create({
        dataDir: dir, factory: piSessionFactory({
            dir: join(dir, 'sessions'), modelRuntime: models, model: faux.getModel(), extensions: [pi => pi.registerProvider(faux.provider)]
        })
    });
    const { PiBotClient } = await import('../src/sdk/client.ts');
    const normal = await PiBotClient.connect({
        transport: {
            inProcess: d
        }
    }), debug = await PiBotClient.connect({
        transport: {
            inProcess: d
        }, capabilities: {
            debugInternal: true
        }
    });
    const one: any[] = [], two: any[] = [];
    try {
        await normal.events.subscribe({
            after: d.log.seq
        }, e => one.push(e));
        await debug.events.subscribe({
            after: d.log.seq
        }, e => two.push(e));
        const bot = d.runtime.createBot('debug');
        await normal.turn.start({
            botId: bot.id, text: 'go', key: 'one'
        });
        await d.runtime.idle();
        assert.ok(two.some(e => e.method === 'item/internal/delta'));
        assert.ok(!one.some(e => e.method === 'item/internal/delta'));
        assert.ok(!JSON.stringify(d.log.read(0)).includes('THINKING_MUST_STAY_PRIVATE'));
        assert.equal(d.runtime.store.list('outbox').length, 0);
    }
    finally {
        normal.close();
        debug.close();
        await d.close();
    }
});
test('loaded thread LRU unloads the oldest idle native session at the configured capacity', async () => {
    const d = await loaded.PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-lru-')), maxLoadedThreads: 1, idleUnloadMs: 3600000, factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    try {
        const a = d.runtime.createBot('A'), b = d.runtime.createBot('B');
        d.runtime.accept({
            to: a.id, text: 'one', key: 'a'
        });
        await d.runtime.idle();
        await new Promise(r => setTimeout(r, 2));
        d.runtime.accept({
            to: b.id, text: 'two', key: 'b'
        });
        await d.runtime.idle();
        for (let i = 0; i < 100 && d.snapshot().threads.filter((t: any) => t.status === 'loaded').length > 1; i++)
            await new Promise(r => setTimeout(r, 5));
        assert.equal(d.snapshot().threads.find((t: any) => t.botId === a.id).status, 'stored');
        assert.equal(d.snapshot().threads.find((t: any) => t.botId === b.id).status, 'loaded');
    }
    finally {
        await d.close();
    }
});
test('ending a yielded turn clears its unfinished reply preview without clearing another turn', async () => {
    const { applyEvent, stateFromSnapshot } = await import('../src/sdk/state/reducer.ts');
    let state = stateFromSnapshot({
        seq: 0, status: 'ready', bots: [], groups: [], threads: [], turns: [], items: [], requests: [], routines: [], jobs: []
    } as any);
    for (const [call, turn, thread] of [['old', 'old-turn', 'old-thread'], ['other', 'other-turn', 'other-thread']])
        state = applyEvent(state, {
            seq: null, at: 1, method: 'item/agentMessage/delta', params: {
                toolCallId: call, turnId: turn, threadId: thread, textDelta: 'unfinished'
            }
        });
    state = applyEvent(state, {
        seq: 1, at: 2, method: 'turn/completed', params: {
            turn: {
                id: 'old-turn', threadId: 'old-thread', status: 'yielded'
            }
        }
    });
    assert.equal(state.streaming.old, undefined);
    assert.equal(state.streamingScopes.old, undefined);
    assert.equal(state.streaming.other, 'unfinished');
});
