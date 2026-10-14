import { createInterface } from 'node:readline';
import { connectAuto } from './transports/auto.ts';
export async function chat(options: {
    dataDir?: string;
    botId?: string;
} = {}) {
    const host = await connectAuto({
        dataDir: options.dataDir, clientInfo: {
            name: 'pi-bot-cli', version: '0.2.0'
        }, capabilities: {
            serverRequests: ['approval', 'question', 'credential'], streamingReplies: true
        }
    });
    const client = host.client;
    const bots = await client.bot.list({});
    let botId = options.botId ?? bots.bots[0]?.id;
    if (!botId)
        botId = (await client.bot.create({
            name: '助手'
        })).bot.id;
    const snapshot = await client.daemon.snapshot({});
    const rl = createInterface({
        input: process.stdin, output: process.stdout, crlfDelay: Infinity
    });
    await client.events.subscribe({
        after: snapshot.seq, filter: {
            botIds: [botId]
        }
    }, event => {
        const item = event.params.item;
        if (item?.type === 'agentMessage' && item.delivery === 'delivered')
            console.log(item.text);
    });
    console.error('Connected. /bots · /new NAME · /to ID TEXT · /quit');
    let stopping = false;
    const stop = async () => {
        if (stopping)
            return;
        stopping = true;
        rl.close();
        client.close();
        await host.close();
    };
    client.on('request', frame => {
        const request = frame.params.request;
        console.error('Pending ' + request.kind + ' ' + request.id + ': ' + JSON.stringify(request.params));
        console.error('Use /answer REQUEST_ID TEXT or /approve REQUEST_ID or /deny REQUEST_ID.');
    });
    rl.on('line', line => {
        void (async () => {
            try {
                if (line === '/quit')
                    return stop();
                if (line === '/bots') {
                    console.log(JSON.stringify(await client.bot.list({})));
                    return;
                }
                if (line.startsWith('/new ')) {
                    console.log(JSON.stringify(await client.bot.create({
                        name: line.slice(5)
                    })));
                    return;
                }
                if (line === '/state') {
                    console.log(JSON.stringify(await client.daemon.status({})));
                    return;
                }
                if (line.startsWith('/answer ')) {
                    const [, id, ...text] = line.split(' ');
                    await client.request.resolve({
                        requestId: id, response: {
                            text: text.join(' ')
                        }
                    });
                    return;
                }
                if (line.startsWith('/approve ') || line.startsWith('/deny ')) {
                    const [verb, id] = line.split(' ');
                    await client.request.resolve({
                        requestId: id, response: {
                            decision: verb === '/approve' ? 'approve' : 'deny'
                        }
                    });
                    return;
                }
                if (line.startsWith('/reconcile ')) {
                    await client.task.reconcile({
                        inputId: line.slice(11).trim()
                    });
                    return;
                }
                let to = botId!, text = line;
                if (line.startsWith('/to ')) {
                    const [, id, ...rest] = line.split(' ');
                    to = id;
                    text = rest.join(' ');
                }
                console.log(JSON.stringify(await client.turn.start({
                    botId: to, text, key: crypto.randomUUID()
                })));
            }
            catch (e) {
                console.error(e instanceof Error ? e.message : 'Request failed');
            }
        })();
    });
    rl.on('close', () => void stop());
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
}
