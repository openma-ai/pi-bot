import { resolve, join } from 'node:path';
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PiBotDaemon } from './core/daemon.ts';
import { listenHttp } from './transports/http.ts';
import { listenStdio } from './transports/stdio.ts';
import { connectAuto } from './transports/auto.ts';
import { PROTOCOL_VERSION } from '../sdk/protocol/version.ts';
export async function main(args = process.argv.slice(2)) {
    const option = (name: string) => {
        const i = args.indexOf(name);
        return i < 0 ? undefined : args[i + 1];
    };
    const command = args[0] ?? 'daemon';
    const dataDir = resolve(option('--data-dir') ?? process.env.PI_BOT_DIR ?? 'work/gui/demo');
    if (command === 'status' || command === 'stop') {
        if (!existsSync(join(dataDir, 'daemon.json')))
            throw Error('No running daemon was discovered');
        const host = await connectAuto({
            dataDir
        });
        try {
            if (command === 'status')
                console.log(JSON.stringify(await host.client.daemon.status({})));
            else
                await host.client.daemon.shutdown({});
        }
        finally {
            host.client.close();
            await host.close();
        }
        return;
    }
    if (command === 'chat') {
        const { chat } = await import('./cli.ts');
        return chat({
            dataDir, botId: option('--bot')
        });
    }
    if (command !== 'daemon')
        throw Error('Usage: pi-bot daemon|status|stop|chat');
    const listen = option('--listen') ?? 'http://127.0.0.1:' + Number(process.env.PI_BOT_GUI_PORT ?? 4317);
    const daemon = await PiBotDaemon.create({
        dataDir, approvalRequired: args.includes('--approval-required'), drainTimeoutMs: Number(option('--drain-timeout') ?? 30000)
    });
    let transport: {
        close(): Promise<void> | void;
    } | undefined;
    if (listen === 'stdio')
        transport = listenStdio(daemon);
    else if (listen !== 'off') {
        const url = new URL(listen);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
            throw Error('Only a loopback HTTP listener is supported');
        transport = await listenHttp(daemon, {
            port: Number(url.port), staticDir: option('--static')
        });
        const http = transport as Awaited<ReturnType<typeof listenHttp>>;
        writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({
            pid: process.pid, protocolVersion: PROTOCOL_VERSION, http: http.url, tokenFile: join(dataDir, 'daemon.token'), startedAt: daemon.startedAt
        }), {
            mode: 0o600
        });
        console.error('Pi Bot daemon: ' + http.url);
    }
    let stopping = false;
    const stop = async () => {
        if (stopping)
            return;
        stopping = true;
        await daemon.close();
        await transport?.close();
        if (listen === 'off')
            process.stdin.pause();
        const file = join(dataDir, 'daemon.json');
        if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).pid === process.pid)
            unlinkSync(file);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
    if (listen === 'off')
        process.stdin.resume();
    const check = setInterval(() => {
        if (daemon.status === 'stopped') {
            clearInterval(check);
            void stop();
        }
    }, 100);
    check.unref();
    return {
        daemon, close: stop
    };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    await main();
