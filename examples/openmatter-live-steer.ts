/**
 * Real end-to-end check of OpenMatter live steer on a Pi SDK session.
 * A coordinatorLoop delegates a long task to a worker backed by
 * makePiAgentDriver on DeepSeek Flash; while that worker Turn runs, a steer
 * Event arrives and must land inside the same Turn.
 *
 *   DEEPSEEK_API_KEY=... OPENMATTER=/path/to/OpenMatter node --import tsx examples/openmatter-live-steer.ts
 *
 * Needs an @openma/matter build that has AgentDriver.steer (after 0.2.7).
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Effect } from 'effect';
import type { WorkEvent } from '@openma/matter';
import { createOpenMatter } from '@openma/matter/runtime';
import { configureSmokeProvider } from '../src/evals/smoke-provider.ts';
import { makePiAgentDriver } from '../src/openmatter/pi-agent-driver.ts';

const om = process.env.OPENMATTER ?? '/workspace/OpenMatter';
const { makeMemoryStore } = await import(`${om}/packages/store-memory/dist/index.js`);
const { coordinatorLoop } = await import(`${om}/packages/orchestration/dist/index.js`);
const { makeMockAgentDriver } = await import(`${om}/packages/agent-mock/dist/index.js`);

const MODEL = 'deepseek-flash';
const dir = await mkdtemp(join(tmpdir(), 'om-live-steer-'));
const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
const model = configureSmokeProvider(models, MODEL);
await models.setRuntimeApiKey('pi-evaluation-deepseek', process.env.DEEPSEEK_API_KEY ?? '');

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
let toolStarted!: () => void;
const firstTool = new Promise<void>(r => (toolStarted = r));
const worker = makePiAgentDriver({
    id: 'pi',
    openSession: async () => {
        const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: models, model, sessionManager: SessionManager.inMemory(dir), tools: ['bash'] });
        session.subscribe((e: any) => {
            if (e.type === 'tool_execution_start') { log('[pi] tool start', e.toolName, JSON.stringify(e.args)); toolStarted(); }
            if (e.type === 'message_end' && e.message?.role === 'user') log('[pi] user message in context:', JSON.stringify(e.message.content).slice(0, 160));
        });
        return session;
    },
    content: context => context.items.filter(i => i.kind === 'event').map(i => String((i.value as any).payload?.text ?? '')).join('\n')
});
const coordinator = makeMockAgentDriver({ id: 'coordinator', output: 'noted' });
const store = makeMemoryStore();
const app = createOpenMatter({ store, integrations: {}, agents: { coordinator: coordinator.driver, worker } }).loop(coordinatorLoop({
    id: 'e2e', continuity: 'per-scope', agentId: 'coordinator', workerAgent: 'worker',
    sources: ['work.delegated', 'work.steered'], steerSources: ['work.steered'],
    associate: (work: any) => ({ scopeId: 'scope', thread: { kind: 'worker', id: work.event.payload.workerId } })
}));
const event = (id: string, type: string, text: string): WorkEvent => ({
    schemaVersion: '0.1', id, type, occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), idempotencyKey: `e2e:${id}`,
    source: { provider: 'e2e', authority: 'a', conversationId: 'c' }, payload: { workerId: 'w1', text }
});

log('delegate: long task');
const delegated = app.accept(event('d1', 'work.delegated', 'Run these bash commands one at a time, each in its own separate tool call, waiting for each: `sleep 4; echo step1`, `sleep 4; echo step2`, `sleep 4; echo step3`, `sleep 4; echo step4`. Then reply with the outputs.'));
await firstTool;
log('steer: mid-turn');
const steer = await app.accept(event('s1', 'work.steered', 'NEW INSTRUCTION FROM COORDINATOR: also run `echo pineapple > steered.txt` with bash, and end your final reply with the word PINEAPPLE.'));
log('steer reaction:', steer.reaction.status, steer.reaction.reason ?? '');
const steerItem = coordinator.turnInputs().flatMap((i: any) => i.context.items).find((i: any) => i.kind === 'coordinator-worker-steer');
log('coordinator saw:', JSON.stringify(steerItem?.value));
const done = await delegated;
log('delegate reaction:', done.reaction.status);
const workerTurn = (steerItem?.value as any)?.turnId;
const events: any[] = await Effect.runPromise(store.getAgentEvents(workerTurn)) as any[];
log(`worker Turn ${workerTurn} events:`);
for (const e of events as any[]) log(`  #${e.seq} ${e.type}`, JSON.stringify(e.data).slice(0, 200));
const turnsStarted = coordinator.turnInputs().length;
const result = { model: MODEL, steer: steerItem?.value, workerTurnId: workerTurn, steeredUserMessageInTurn: events.some((e: any) => e.type === 'user.message' && e.data?.steered), terminalCount: events.filter((e: any) => e.type.startsWith('turn.')).length, finalMentionsPineapple: /PINEAPPLE/i.test(JSON.stringify(events.at(-1)?.data)), coordinatorTurns: turnsStarted, dir };
await writeFile(join(dir, 'result.json'), JSON.stringify({ result, events }, null, 2));
log('RESULT', JSON.stringify(result));
process.exit(0);
