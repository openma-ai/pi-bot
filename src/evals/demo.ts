import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage as msg, fauxToolCall as call, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from '../daemon/runtime/runtime.ts';
import { piSessionFactory } from '../pi/session-factory.ts';
import { delayTool } from '../../examples/safe-tools.ts';
import type { Question, Job } from '../daemon/runtime/store.ts';
const dir = await mkdtemp(join(tmpdir(), 'pi-bot-demo-'));
const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false
});
const provider = fauxProvider({
    provider: 'demo', models: [{
            id: 'demo', contextWindow: 32000, maxTokens: 2000
        }], tokensPerSecond: 1000000
});
const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
    dir: join(dir, 'sessions'), modelRuntime: models, model: provider.getModel(), extensions: [pi => pi.registerProvider(provider.provider)], tools: [delayTool], allowTools: ['demo_delay']
}));
try {
    const bot = runtime.createBot('main', 'Coordinate user requests');
    provider.setResponses([msg([call('start_job', {
                tool: 'demo_delay', args: {
                    label: 'safe local work', ms: 80
                }, key: 'demo-job'
            }), call('ask_user', {
                question: 'Choose blue or green?', key: 'demo-question'
            })]), msg(call('send_message', {
            text: 'The job and question are pending; I am free for new input.', key: 'receipt'
        })), msg('Waiting by ending turn.'), msg(call('send_message', {
            text: 'Background completion received.', key: 'complete'
        })), msg('Done.')]);
    runtime.accept({
        to: bot.id, text: 'Start a job and ask a question.', key: 'demo-input'
    });
    await runtime.idle();
    await runtime.deliver(async (o) => console.log('USER OUTBOX', o.id, o.text));
    const q = runtime.store.list<Question>('questions')[0];
    console.log('QUESTION pending while model idle:', q.id);
    provider.setResponses([msg(call('send_message', {
            text: 'Answer blue received through correlated inbox.', key: 'answer-reply'
        })), msg('Done.')]);
    runtime.answer(q.id, 'blue', 'demo-answer');
    await runtime.idle();
    await runtime.deliver(async (o) => console.log('USER OUTBOX', o.id, o.text));
    console.log('JOBS', runtime.store.list<Job>('jobs').map(j => ({
        id: j.id, state: j.state
    })));
    console.log('DONE: real Pi SDK, deterministic faux provider, SQLite inbox/outbox, no API key or external calls.');
    if (runtime.errors.length)
        throw new AggregateError(runtime.errors, 'Demo errors');
}
finally {
    await runtime.close();
    await rm(dir, {
        recursive: true, force: true
    });
}
