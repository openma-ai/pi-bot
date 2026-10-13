import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { ProactiveService } from './proactive.ts';
import { createFileChangeDetector } from './proactive-detectors.ts';
import { createModelBackgroundWorker } from './proactive-model-worker.ts';
import { loadPiConfiguration } from './pi-config.ts';
import { OpenMatterTrigger } from './openmatter-trigger.ts';
import { BotRuntime } from './runtime.ts';
import { piSessionFactory } from './pi.ts';
import type { Outbound } from './store.ts';
const dir = resolve(process.env.PI_BOT_DIR ?? '.pi-bot');
mkdirSync(dir, {
    recursive: true
});
{
    const configuration = await loadPiConfiguration();
    const { models, model } = configuration;
    let proactive: ProactiveService | undefined;
    const proactiveOptions: ConstructorParameters<typeof ProactiveService>[1] = {
        detectors: process.env.PI_BOT_WATCH_FILE ? {
            file: createFileChangeDetector(resolve(process.env.PI_BOT_WATCH_FILE))
        } : {}, ...(process.env.PI_BOT_BACKGROUND_WORK === '1' ? {
            workers: {
                memory: createModelBackgroundWorker(models, model, 'memory'), research: createModelBackgroundWorker(models, model, 'research')
            }
        } : {})
    };
    const trigger = new OpenMatterTrigger(join(dir, 'triggers.db'));
    const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
        codingWorkers: true, dir: join(dir, 'sessions'), modelRuntime: models, model,
        ...(process.env.PI_BOT_PROACTIVE === '1' ? {
            proactive: (host: BotRuntime) => proactive ??= new ProactiveService(host, proactiveOptions)
        } : {}),
        ...(process.env.PI_BOT_BACKGROUND_TOOLS === '1' ? {
            backgroundTools: {}
        } : {})
    }), {
        activation: trigger, isolateConversations: true
    });
    trigger.bind(id => runtime.activateInbox(id));
    const bot = runtime.listBots()[0] ?? runtime.createBot('main', 'Personal assistant');
    runtime.start();
    if (process.env.PI_BOT_PROACTIVE === '1') {
        proactive ??= new ProactiveService(runtime, proactiveOptions);
        proactive.start();
    }
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
        type: 'ready', botId: bot.id, commands: ['/bots', '/new NAME', '/to BOT_ID TEXT', '/answer QUESTION_ID TEXT', '/reconcile INBOX_ID DELIVERED_OUTBOX_ID', '/state', '/quit'], note: 'Plain lines go to main bot. Outbox delivered means written to local console only.'
    }));
    timer = setInterval(() => {
        if (!runtime.store.db.isTransaction)
            trigger.flush();
        void runtime.deliver(print).catch(e => console.error(String(e)));
    }, 100);
    const stop = async () => {
        if (closing)
            return;
        closing = true;
        rl.close();
        clearInterval(timer);
        await proactive?.close();
        await runtime.idle();
        await runtime.deliver(print);
        for (const error of runtime.errors)
            console.error('RUNTIME', String(error));
        await runtime.close();
        trigger.close();
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
            if (line.startsWith('/reconcile ')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length !== 3)
                    throw Error('Expected inbox ID and delivered outbox ID');
                runtime.reconcileInbox(parts[1], {
                    outcome: 'processed', evidence: [parts[2]]
                });
                console.log(JSON.stringify({
                    type: 'reconciled', messageId: parts[1]
                }));
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
