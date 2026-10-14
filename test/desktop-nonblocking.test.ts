import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { RequestBroker } from '../src/daemon/requests/request-broker.ts';
import { DesktopClient } from '../src/pi/desktop-client.ts';
import { piSessionFactory } from '../src/pi/session-factory.ts';
import type { Envelope, Job } from '../src/daemon/runtime/store.ts';
async function until(check: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > deadline) throw Error('timed out');
        await new Promise(r => setTimeout(r, 5));
    }
}
for (const tool of ['desktop_call', 'desktop_list'])
for (const variant of ['approve', 'deny', 'cancel', 'cancel-after-bind', 'restart'])
    test(`direct ${tool} approval is a scoped durable job: ${variant}`, { timeout: 10000 }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'pi-desktop-wait-'));
        let source = '', effects = 0, binds = 0;
        let release!: () => void;
        const gate = new Promise<void>(r => release = r);
        const contexts: string[] = [];
        const results: any[] = [];
        const desktop = new DesktopClient('http://127.0.0.1:1', 'DUMMY-NOT-A-CREDENTIAL');
        // Every transport call is replaced; no socket or real desktop is used.
        desktop.request = async path => {
            if (path === '/bind') {
                binds++;
                if (variant === 'cancel-after-bind') await gate;
                return new Response('{}');
            }
            if (path === '/call' || path === '/tools') effects++;
            return new Response(JSON.stringify({ content: [{ type: 'text', text: 'FIXTURE-DONE' }], details: {} }));
        };
        const faux = fauxProvider({ provider: 'desktop-fixture-' + variant, models: [{ id: 'test', contextWindow: 128000, maxTokens: 4096 }], tokensPerSecond: 1000000 });
        faux.setResponses([() => fauxAssistantMessage(fauxToolCall(tool, {
            ...(tool === 'desktop_call' ? { kind: 'browser', args: { action: 'fixture-no-side-effect' } } : {}), source_message_id: source
        }, { id: 'desktop-A' }), { stopReason: 'toolUse' }), ...Array.from({ length: 20 }, () => (ctx: any) => {
            contexts.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage('internal');
        })]);
        const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
        const factory = piSessionFactory({ dir, desktop, modelRuntime: models, model: faux.getModel(), extensions: [pi => {
            pi.registerProvider(faux.provider); pi.on('tool_result', e => { results.push(e); });
        }] });
        const runtime = new BotRuntime(join(dir, 'runtime.db'), factory);
        const broker = new RequestBroker(runtime, new Map());
        runtime.approvals = { request: input => broker.approval(input) };
        try {
            const bot = runtime.createBot('fixture');
            const a = runtime.accept({ to: bot.id, text: 'Operation A', key: 'A' }); source = a.id;
            await until(() => broker.list().some(r => r.status === 'pending'));
            runtime.accept({ to: bot.id, text: 'INDEPENDENT-B', key: 'B' });
            await until(() => contexts.some(context => context.includes('INDEPENDENT-B')));
            assert.equal(effects, 0); assert.equal(binds, 0);
            const job = runtime.store.list<Job>('jobs')[0]!;
            assert.equal(job.messageId, a.id); assert.equal(job.taskId, a.taskId);
            assert.ok(JSON.stringify(results).includes(job.id), 'direct call returns a receipt, never a false final result');
            const request = broker.list()[0]!;
            if (variant === 'cancel') {
                runtime.store.put('inbox', { ...runtime.store.get<Envelope>('inbox', a.id)!, triggerCancelled: true });
                assert.throws(() => broker.resolve(request.id, { decision: 'approve' }, 'fixture'), /cancelled/);
                broker.sweep();
            } else if (variant === 'restart') broker.close();
            else {
                const response = { decision: variant === 'deny' ? 'deny' : 'approve' };
                broker.resolve(request.id, response, 'fixture');
                broker.resolve(request.id, response, 'fixture');
                if (variant === 'cancel-after-bind') {
                    await until(() => binds === 1);
                    runtime.store.put('inbox', { ...runtime.store.get<Envelope>('inbox', a.id)!, triggerCancelled: true }); release();
                }
            }
            await runtime.idle();
            assert.equal(effects, variant === 'approve' ? 1 : 0);
            assert.equal(runtime.store.list<Job>('jobs').length, 1);
            assert.equal(runtime.store.get<Job>('jobs', job.id)!.state, variant === 'approve' ? 'completed' : 'failed');
            if (variant === 'cancel' || variant === 'restart')
                assert.throws(() => broker.resolve(request.id, { decision: 'approve' }, 'fixture'), /no longer pending/);
            if (variant === 'restart') {
                await runtime.close();
                const recovered = new BotRuntime(join(dir, 'runtime.db'), factory);
                const recoveredBroker = new RequestBroker(recovered, new Map());
                try {
                    assert.equal(recovered.store.get<Job>('jobs', job.id)!.state, 'failed');
                    assert.throws(() => recoveredBroker.resolve(request.id, { decision: 'approve' }, 'fixture'), /no longer pending/);
                    assert.equal(effects, 0);
                } finally { recoveredBroker.close(); await recovered.close(); }
            }
        } finally {
            release(); if (variant !== 'restart') broker.close(); await runtime.close(); await rm(dir, { recursive: true, force: true });
        }
    });
