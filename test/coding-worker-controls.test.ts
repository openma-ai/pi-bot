import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runCodingWorker, type CodingWorkerControls } from '../src/pi/coding-worker.ts';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { piSessionFactory } from '../src/pi/session-factory.ts';
import type { Job } from '../src/daemon/runtime/store.ts';
mkdirSync('work/worker-tests', { recursive: true });
const setup = async (responses: unknown[]) => {
    const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider();
    faux.setResponses(responses as any);
    models.registerNativeProvider(faux.provider);
    return { models, model: faux.getModel(), dir: mkdtempSync(resolve('work/worker-tests/case-')) };
};
test('parent can steer a running worker through plugin foreground controls', async () => {
    let controls: CodingWorkerControls | undefined;
    const { models, model, dir } = await setup([
        () => { void controls!.steer('STEER-MARKER use value 99'); return fauxAssistantMessage(fauxToolCall('ls', { path: '.' }), { stopReason: 'toolUse' }); },
        (ctx: any) => fauxAssistantMessage(JSON.stringify(ctx).includes('STEER-MARKER') ? 'saw steer 99' : 'no steer')
    ]);
    const r = await runCodingWorker({ dir, modelRuntime: models, model, assertCurrent() { }, onControls: c => controls = c }, 'list files', { taskId: 't' });
    assert.equal(r.text, 'saw steer 99');
});
test('parent can interrupt a running worker', async () => {
    let controls: CodingWorkerControls | undefined;
    const { models, model, dir } = await setup([
        () => { setTimeout(() => controls!.stop('parent interrupt'), 300); return fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 20' }), { stopReason: 'toolUse' }); },
        () => fauxAssistantMessage('should not finish')
    ]);
    await assert.rejects(runCodingWorker({ dir, modelRuntime: models, model, assertCurrent() { }, onControls: c => controls = c }, 'hang', { taskId: 't' }), /interrupted by parent/);
});
test('finished worker session can be resumed with its retained context', async () => {
    const { models, model, dir } = await setup([
        () => fauxAssistantMessage('FIRST-ANSWER 41'),
        (ctx: any) => fauxAssistantMessage(JSON.stringify(ctx).includes('FIRST-ANSWER 41') ? 'resumed with 42' : 'lost context')
    ]);
    const first = await runCodingWorker({ dir, modelRuntime: models, model, assertCurrent() { } }, 'first', { taskId: 't' });
    assert.ok(first.sessionFile);
    const second = await runCodingWorker({ dir, modelRuntime: models, model, assertCurrent() { }, resumeSessionFile: first.sessionFile }, 'add one', { taskId: 't' });
    assert.equal(second.text, 'resumed with 42');
});
test('bot fans out parallel workers that run concurrently', { timeout: 20000 }, async () => {
    let started = 0, release!: () => void, both!: () => void;
    const gate = new Promise<void>(r => release = r), bothRunning = new Promise<void>(r => both = r);
    let dispatched = false;
    const response = async (ctx: any) => {
        const text = JSON.stringify(ctx);
        if (text.includes('isolated Pi coding worker')) {
            if (++started === 2) both();
            await gate;
            return fauxAssistantMessage(text.includes('PART-A') ? 'done A' : 'done B');
        }
        if (!dispatched) {
            dispatched = true;
            return fauxAssistantMessage(fauxToolCall('subagent', { tasks: ['PART-A', 'PART-B'], key: 'fan' }), { stopReason: 'toolUse' });
        }
        return fauxAssistantMessage('Waiting');
    };
    const { models, model, dir } = await setup(Array(30).fill(response));
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({ dir: join(dir, 'sessions'), modelRuntime: models, model, codingWorkers: true }));
    try {
        const bot = runtime.createBot('owner', 'Handle tasks');
        runtime.accept({ to: bot.id, from: 'user', kind: 'user', text: 'Do A and B', key: 'req' });
        await bothRunning;
        assert.equal(runtime.store.list<Job>('jobs').filter(j => j.tool === 'pi-coding-agent' && j.state === 'running').length, 2);
        release();
        await runtime.idle();
        const jobs = runtime.store.list<Job>('jobs').filter(j => j.tool === 'pi-coding-agent');
        assert.deepEqual(jobs.map(j => j.state), ['completed', 'completed']);
        assert.deepEqual(jobs.map(j => JSON.parse(runtime.jobResult(bot.id, j.id)!.text!).text).sort(), ['done A', 'done B']);
    }
    finally {
        release();
        await runtime.close();
    }
});
test('maxCodingWorkers rejects invalid caps', () => {
    assert.throws(() => piSessionFactory({ dir: 'x', modelRuntime: {} as any, model: {} as any, maxCodingWorkers: 0 }), /maxCodingWorkers/);
});
