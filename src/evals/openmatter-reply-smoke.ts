/**
 * Real-model smoke for the OpenMatter reply path (pi-bot.message.reply).
 * DeepSeek Flash only; key from DEEPSEEK_API_KEY. Prints receipts and call records, no secrets.
 *   node --import tsx src/evals/openmatter-reply-smoke.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from '../daemon/runtime/runtime.ts';
import { piSessionFactory } from '../pi/session-factory.ts';
import { configureSmokeProvider, SMOKE_PROVIDER } from './smoke-provider.ts';
import type { Outbound } from '../daemon/runtime/store.ts';
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw Error('DEEPSEEK_API_KEY required');
const dir = await mkdtemp(join(tmpdir(), 'pi-bot-om-real-'));
const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
});
const model = configureSmokeProvider(models, 'deepseek-flash');
await models.setRuntimeApiKey(SMOKE_PROVIDER, key);
const runtime = new BotRuntime(join(dir, 'bot.db'), piSessionFactory({ dir: join(dir, 'sessions'), modelRuntime: models, model, preemptInference: false }));
const route = { channelId: 'alpha', threadId: 'main', senderId: 'alice' };
const calls = () => (runtime.store.db.prepare('SELECT data FROM om_operation_calls ORDER BY rowid').all() as { data: string }[]).map(r => {
    const c = JSON.parse(r.data);
    return { callId: c.callId, op: `${c.integrationId}.${c.operation}`, text: c.input?.text, sourceMessageId: c.input?.sourceMessageId, checkedAtRevision: c.conversation?.revision ?? null, result: c.result };
});
const log = (label: string, value: unknown) => console.log(`\n## ${label}\n` + JSON.stringify(value, null, 2));
try {
    const bot = runtime.createBot('main', 'Reply to the user with send_message.', 'alpha');
    // 1. Message in -> reply out through OpenMatter, with a receipt.
    const first = runtime.accept({ to: bot.id, text: 'Reply using send_message with exactly: OM-REPLY-OK', key: 'q1', route });
    await runtime.idle();
    await runtime.deliver(async o => { console.log(`[channel delivery] ${o.id} -> ${o.route?.channelId}/${o.route?.threadId}: ${o.text}`); });
    log('scenario 1 inbound', { id: first.id, text: first.text });
    log('scenario 1 OpenMatter call records', calls());
    // 2. The user corrects themselves while the agent is deciding: the first reply is stale.
    let injected = '';
    const original = runtime.replyThroughOpenMatter.bind(runtime);
    (runtime as any).replyThroughOpenMatter = (source: any, text: string, k: string, opts: any) => {
        if (!injected && source.text.includes('OM-STALE')) {
            injected = runtime.accept({ to: bot.id, text: 'Correction: reply with exactly OM-CORRECTED instead.', key: 'q2-correction', route }).id;
            console.log(`[injected user correction ${injected} before the reply call]`);
        }
        const r = original(source, text, k, opts);
        console.log(`[send_message -> pi-bot.message.reply] key=${k} text=${JSON.stringify(text)} status=${r.status}`);
        return r;
    };
    const before = calls().length;
    runtime.accept({ to: bot.id, text: 'Reply using send_message with exactly: OM-STALE-ORIGINAL', key: 'q2', route });
    await runtime.idle();
    await runtime.deliver(async o => { console.log(`[channel delivery] ${o.id} -> ${o.route?.channelId}/${o.route?.threadId}: ${o.text}`); });
    log('scenario 2 OpenMatter call records', calls().slice(before));
    log('outbox (what the user sees)', runtime.store.list<Outbound>('outbox').map(o => ({ id: o.id, text: o.text, state: o.state, replyTo: o.replyTo })));
}
finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
}
