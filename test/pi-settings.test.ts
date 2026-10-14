import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const path = '../src/daemon/pi-settings.ts';
const loaded = await import(path).catch(() => undefined);
test('GUI login uses native Pi auth storage and model settings without exposing entered values', async () => {
    assert.ok(loaded?.PiSettings, 'GUI Pi settings service must exist');
    const dir = mkdtempSync(join(tmpdir(), 'pi-settings-'));
    const settings = await loaded.PiSettings.create({
        agentDir: dir, cwd: dir
    });
    try {
        const initial = await settings.state();
        const provider = initial.providers.find((p: any) => p.id === 'deepseek');
        assert.ok(provider.methods.includes('api_key'));
        const flow = settings.startLogin('deepseek', 'api_key');
        let status: any;
        for (let i = 0; i < 100; i++) {
            status = settings.loginState(flow.id);
            if (status.prompt)
                break;
            await new Promise(r => setTimeout(r, 1));
        }
        assert.equal(status.prompt.type, 'secret');
        settings.answer(flow.id, status.prompt.id, 'fixture-key-not-real');
        for (let i = 0; i < 100; i++) {
            status = settings.loginState(flow.id);
            if (status.status !== 'pending')
                break;
            await new Promise(r => setTimeout(r, 1));
        }
        assert.equal(status.status, 'complete');
        assert.equal(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')).deepseek.key, 'fixture-key-not-real');
        assert.ok(!JSON.stringify(await settings.state()).includes('fixture-key-not-real'));
        assert.ok(!JSON.stringify(status).includes('fixture-key-not-real'));
        await settings.selectModel('deepseek', provider.models[0].id, 'high');
        const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
        assert.equal(saved.defaultProvider, 'deepseek');
        assert.equal(saved.defaultModel, provider.models[0].id);
        assert.equal(saved.defaultThinkingLevel, 'high');
    }
    finally {
        settings.close();
    }
});
test('model reconfiguration waits for active Pi work and keeps saved inbox history', async () => {
    const { BotRuntime } = await import('../src/daemon/runtime/runtime.ts');
    const dir = mkdtempSync(join(tmpdir(), 'pi-reconfigure-'));
    let finish!: () => void;
    let closed = 0;
    const runtime = new BotRuntime(join(dir, 'runtime.db'), async () => ({
        async run() {
            await new Promise<void>(r => finish = r);
        }, async close() {
            closed++;
        }
    }) as any);
    try {
        const bot = runtime.createBot('worker');
        runtime.accept({
            to: bot.id, text: 'work', key: 'first'
        });
        for (let i = 0; i < 100 && !finish; i++)
            await new Promise(r => setTimeout(r, 1));
        assert.ok(finish);
        assert.equal(await runtime.reconfigure(async () => ({
            async run() {
            }, async close() {
            }
        }) as any), false);
        assert.equal(closed, 0);
        finish();
        await runtime.idle();
        assert.equal(await runtime.reconfigure(async () => ({
            async run() {
            }, async close() {
            }
        }) as any), true);
        assert.equal(closed, 1);
        assert.equal(runtime.store.list('inbox').length, 1);
    }
    finally {
        finish?.();
        await runtime.close();
    }
});
test('private GUI auth requires authentication and keeps secrets out of RPC, snapshots and events', async () => {
    const { PiBotDaemon } = await import('../src/daemon/core/daemon.ts');
    const { listenHttp } = await import('../src/daemon/transports/http.ts');
    const dir = mkdtempSync(join(tmpdir(), 'pi-auth-http-'));
    const d = await PiBotDaemon.create({
        dataDir: join(dir, 'data'), piOptions: {
            agentDir: join(dir, 'pi'), cwd: dir
        }, factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    const http = await listenHttp(d, {
        port: 0
    });
    const headers = {
        'Authorization': 'Bearer ' + http.token, 'content-type': 'application/json'
    };
    try {
        assert.equal((await fetch(http.url + '/pi/config')).status, 401);
        const config = await fetch(http.url + '/pi/config', {
            headers
        });
        assert.equal(config.status, 200);
        const flow = await (await fetch(http.url + '/pi/login', {
            method: 'POST', headers, body: JSON.stringify({
                provider: 'deepseek', type: 'api_key'
            })
        })).json();
        let status: any;
        for (let i = 0; i < 100; i++) {
            status = await (await fetch(http.url + '/pi/login/' + flow.id, {
                headers
            })).json();
            if (status.prompt)
                break;
            await new Promise(r => setTimeout(r, 1));
        }
        assert.equal(status.prompt.type, 'secret');
        const sent = await fetch(http.url + '/pi/login/' + flow.id + '/input', {
            method: 'POST', headers, body: JSON.stringify({
                promptId: status.prompt.id, value: 'fixture-http-secret'
            })
        });
        assert.equal(sent.status, 200);
        for (let i = 0; i < 100; i++) {
            status = await (await fetch(http.url + '/pi/login/' + flow.id, {
                headers
            })).json();
            if (status.status === 'complete')
                break;
            await new Promise(r => setTimeout(r, 1));
        }
        assert.equal(status.status, 'complete');
        assert.ok(!JSON.stringify({
            status, snapshot: d.snapshot(), events: d.log.read(0)
        }).includes('fixture-http-secret'));
        assert.equal((await fetch(http.url + '/pi/login', {
            method: 'POST', headers: {
                ...headers, Origin: 'https://outside.test'
            }, body: '{}'
        })).status, 403);
    }
    finally {
        await http.close();
        await d.close();
    }
});
test('routines retain their owning bot and reject groups that do not contain it', async () => {
    const { PiBotDaemon } = await import('../src/daemon/core/daemon.ts');
    const d = await PiBotDaemon.create({
        dataDir: mkdtempSync(join(tmpdir(), 'pi-routine-owner-')), factory: async () => ({
            run: async () => {
            }, close: async () => {
            }
        })
    });
    try {
        const a = d.runtime.createBot('A'), b = d.runtime.createBot('B'), c = d.runtime.createBot('C');
        const group = d.runtime.createGroup('AB', [a.id, b.id]);
        const schedule = d.createRoutine({
            kind: 'schedule', botId: a.id, prompt: 'A schedule', key: 'a', at: Date.now() + 3600000, timezone: 'Asia/Shanghai'
        });
        const monitor = d.createRoutine({
            kind: 'monitor', botId: b.id, prompt: 'B monitor', key: 'b', deadline: Date.now() + 3600000, intervalMs: 60000
        });
        assert.equal(schedule.botId, a.id);
        assert.equal(monitor.botId, b.id);
        assert.deepEqual(d.snapshot([a.id]).routines.map((r: any) => r.botId), [a.id]);
        assert.throws(() => d.createRoutine({
            kind: 'schedule', botId: c.id, groupId: group.id, prompt: 'bad', at: Date.now() + 3600000
        }), (e: any) => e.reason === 'forbidden');
        await d.routineAction('pause', schedule.id);
        assert.equal(d.snapshot([a.id]).routines[0].state, 'paused');
        assert.equal(d.snapshot([b.id]).routines[0].botId, b.id);
    }
    finally {
        await d.close();
    }
});
test('streaming replies retain their thread ownership for GUI filtering', async () => {
    const { applyEvent, stateFromSnapshot } = await import('../src/sdk/state/reducer.ts');
    const state = stateFromSnapshot({
        seq: 0, status: 'ready', bots: [], groups: [], threads: [], turns: [], items: [], requests: [], routines: [], jobs: []
    } as any);
    const next = applyEvent(state, {
        seq: null, at: 1, method: 'item/agentMessage/delta', params: {
            threadId: 'thread-a', turnId: 'turn-a', toolCallId: 'call-a', textDelta: 'preview'
        }
    });
    assert.equal(next.streamingScopes['call-a'], 'thread-a');
    const final = applyEvent(next, {
        seq: 1, at: 2, method: 'item/completed', params: {
            item: {
                id: 'reply', type: 'agentMessage', threadId: 'thread-a', toolCallId: 'call-a'
            }
        }
    });
    assert.equal(final.streamingScopes['call-a'], undefined);
});
test('native Pi model changes apply to the live daemon without a provider request or history reset', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { PiBotDaemon } = await import('../src/daemon/core/daemon.ts');
    const dir = mkdtempSync(join(tmpdir(), 'pi-model-switch-')), agentDir = join(dir, 'pi');
    mkdirSync(agentDir);
    const model = (id: string) => ({
        id, name: id, reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 2048, cost: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0
        }
    });
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
        providers: {
            'local-fixture': {
                baseUrl: 'https://example.invalid', api: 'openai-completions', models: [model('one'), model('two')]
            }
        }
    }));
    writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
        'local-fixture': {
            type: 'api_key', key: 'fixture-local-auth'
        }
    }));
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
        defaultProvider: 'local-fixture', defaultModel: 'one'
    }));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'gui-budget.json'), JSON.stringify({
        requests: 32, inputReserved: 384000, expiresAt: 1
    }));
    const d = await PiBotDaemon.create({
        dataDir: join(dir, 'data'), piOptions: {
            agentDir, cwd: dir
        }
    });
    try {
        const bot = d.runtime.createBot('kept');
        assert.equal(d.live!.model, 'one');
        await d.piSettings!.selectModel('local-fixture', 'two', 'high');
        assert.deepEqual(await d.requestPiReload(), {
            pending: false, applied: true
        });
        assert.equal(d.live!.model, 'two');
        assert.equal(d.runtime.listBots()[0].id, bot.id);
        assert.equal(d.live!.budget, undefined);
        assert.equal(JSON.parse(readFileSync(join(dir, 'data', 'gui-budget.json'), 'utf8')).expiresAt, 1);
        assert.ok(d.log.read(0).some(e => e.method === 'daemon/configurationChanged'));
    }
    finally {
        await d.close();
    }
});
test('native OAuth interaction bridges links, prompts and cancellation without returning tokens', async () => {
    const { fauxProvider } = await import('@earendil-works/pi-ai');
    const dir = mkdtempSync(join(tmpdir(), 'pi-oauth-'));
    const service = await loaded.PiSettings.create({
        agentDir: dir, cwd: dir
    });
    const faux = fauxProvider({
        provider: 'oauth-fixture'
    });
    (service as any).models.registerNativeProvider({
        ...faux.provider, auth: {
            oauth: {
                name: 'Fixture OAuth', async login(interaction: any) {
                    interaction.notify({
                        type: 'auth_url', url: 'https://example.invalid/login', instructions: 'Fixture only'
                    });
                    const selected = await interaction.prompt({
                        type: 'select', message: 'Account', options: [{
                                id: 'one', label: 'One'
                            }]
                    });
                    assert.equal(selected, 'one');
                    await interaction.prompt({
                        type: 'manual_code', message: 'Code'
                    });
                    return {
                        type: 'oauth', refresh: 'fixture-refresh-token', access: 'fixture-access-token', expires: Date.now() + 3600000
                    };
                }, async refresh(credential: any) {
                    return credential;
                }, async toAuth() {
                    return {
                        apiKey: 'fixture-access-token'
                    };
                }
            }
        }
    });
    const wait = async (id: string, check: (s: any) => boolean) => {
        for (let i = 0; i < 100; i++) {
            const state = service.loginState(id);
            if (check(state))
                return state;
            await new Promise(r => setTimeout(r, 1));
        }
        assert.fail('Auth step did not advance');
    };
    try {
        let flow = service.startLogin('oauth-fixture', 'oauth');
        let state = await wait(flow.id, s => !!s.prompt);
        assert.equal(state.events[0].type, 'auth_url');
        service.answer(flow.id, state.prompt.id, 'one');
        state = await wait(flow.id, s => s.prompt?.type === 'manual_code');
        service.cancel(flow.id);
        assert.equal(service.loginState(flow.id).status, 'cancelled');
        await new Promise(r => setTimeout(r, 1));
        flow = service.startLogin('oauth-fixture', 'oauth');
        state = await wait(flow.id, s => !!s.prompt);
        service.answer(flow.id, state.prompt.id, 'one');
        state = await wait(flow.id, s => s.prompt?.type === 'manual_code');
        service.answer(flow.id, state.prompt.id, 'fixture-code');
        state = await wait(flow.id, s => s.status === 'complete');
        assert.ok(!JSON.stringify({
            state, config: await service.state()
        }).includes('fixture-access-token'));
    }
    finally {
        service.close();
    }
});
