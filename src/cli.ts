import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from './runtime.ts';
import { piSessionFactory } from './pi.ts';
import type { Outbound } from './store.ts';
const dir = resolve(process.env.PI_BOT_DIR ?? '.pi-bot');
mkdirSync(dir, {
    recursive: true
});
const provider = process.env.PI_BOT_PROVIDER;
const modelId = process.env.PI_BOT_MODEL;
if (!provider || !modelId) {
    console.error('Set PI_BOT_PROVIDER and PI_BOT_MODEL plus the provider API key environment variable. For an offline demo: npm run demo');
    process.exitCode = 1;
}
else {
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false
    });
    const model = models.getModel(provider, modelId);
    if (!model)
        throw Error('Unknown model; select an installed Pi model ID');
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
        dir: join(dir, 'sessions'), modelRuntime: models, model
    }));
    const bot = runtime.listBots()[0] ?? runtime.createBot('main', 'Personal assistant');
    runtime.start();
    const print = async (o: Outbound) => {
        console.log(JSON.stringify({
            type: 'message', ...o
        }));
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    let closing = false;
    const rl = createInterface({
        input: process.stdin, crlfDelay: Infinity
    });
    console.log(JSON.stringify({
        type: 'ready', botId: bot.id, commands: ['/bots', '/new NAME', '/to BOT_ID TEXT', '/answer QUESTION_ID TEXT', '/state', '/quit'], note: 'Plain lines go to main bot. Outbox delivered means written to local console only.'
    }));
    timer = setInterval(() => {
        void runtime.deliver(print).catch(e => console.error(String(e)));
    }, 100);
    const stop = async () => {
        if (closing)
            return;
        closing = true;
        rl.close();
        clearInterval(timer);
        await runtime.idle();
        await runtime.deliver(print);
        for (const error of runtime.errors)
            console.error('RUNTIME', String(error));
        await runtime.close();
    };
    rl.on('line', line => {
        try {
            if (line === '/quit') {
                void stop();
                return;
            }
            if (line === '/bots') {
                console.log(JSON.stringify(runtime.listBots()));
                return;
            }
            if (line === '/state') {
                console.log(JSON.stringify(runtime.store.state(bot.id)));
                return;
            }
            if (line.startsWith('/new ')) {
                console.log(JSON.stringify(runtime.createBot(line.slice(5))));
                return;
            }
            if (line.startsWith('/answer ')) {
                const [, id, ...text] = line.split(' ');
                runtime.answer(id, text.join(' '), randomUUID());
                return;
            }
            let to = bot.id, text = line;
            if (line.startsWith('/to ')) {
                const [, id, ...rest] = line.split(' ');
                to = id;
                text = rest.join(' ');
            }
            const e = runtime.accept({
                to, text, key: randomUUID()
            });
            console.log(JSON.stringify({
                type: 'accepted', messageId: e.id, state: e.state
            }));
        }
        catch (error) {
            console.error(String(error));
        }
    });
    rl.on('close', () => {
        void stop();
    });
}
