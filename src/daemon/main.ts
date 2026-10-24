import { resolve, join } from 'node:path';
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PiBotDaemon } from './core/daemon.ts';
import { listenHttp } from './transports/http.ts';
import { tailnetListenerOptions } from './transports/tailnet-listener.ts';
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
    if (command === 'service-password' || command === 'tailnet-pair' || command === 'tailnet-devices' || command === 'tailnet-revoke' || command === 'tailnet-cancel') {
        const info = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8'));
        const url = new URL(info.http);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || !url.port || url.username || url.password || url.search || url.hash)
            throw Error('Only local daemon control is supported');
        const token = readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim();
        const action = ({
            'service-password':'password', 'tailnet-pair': 'pair', 'tailnet-devices': 'list', 'tailnet-revoke': 'revoke', 'tailnet-cancel': 'cancel'
        } as const)[command];
        const response = await fetch(new URL('/tailnet/admin', url), {
            method: 'POST', headers: {
                authorization: 'Bearer ' + token, 'content-type': 'application/json'
            }, body: JSON.stringify({
                action, id: option('--device'), ...(command==='service-password'?{password:await (await import('./service-password-cli.ts')).readServicePassword()}:{})
            }), signal: AbortSignal.timeout(5000)
        });
        if (!response.ok)
            throw Error('Local Tailnet administration failed: ' + response.status);
        console.log(JSON.stringify(await response.json()));
        return;
    }
    if (command === 'ensure') {
        const { ensureServer } = await import('./transports/server-start.ts');
        const endpoint = await ensureServer({
            dataDir, projectDir: process.cwd(), port: Number(new URL(option('--listen') ?? 'http://127.0.0.1:4318').port)
        });
        // Private SSH bootstrap output, consumed in memory by the client launcher.
        process.stdout.write('PI_BOT_SERVER=' + JSON.stringify({
            url: endpoint.url, token: endpoint.token
        }) + '\n');
        return;
    }
    if (command === 'client') {
        const { RuntimeManager } = await import('./transports/runtime-manager.ts');
        const { listenClientHost } = await import('./transports/client-host.ts');
        const manager = new RuntimeManager({
            file: resolve(option('--client-dir') ?? 'work/gui/client', 'client.json'), defaults: {
                local: {
                    mode: 'local', dataDir
                }, ssh: null
            }
        });
        const bind = option('--bind') ?? '127.0.0.1';
        if (!['127.0.0.1', '0.0.0.0'].includes(bind))
            throw Error('Client bind must be loopback or an explicit container listener');
        const host = await listenClientHost(manager, {
            port: Number(option('--port') ?? 4317), staticDir: option('--static'), bind: bind as '127.0.0.1' | '0.0.0.0'
        });
        console.error('Pi Bot client: ' + host.url);
        // Local is the first-run default. Connection failures leave Settings accessible.
        try {
            await manager.connect(manager.initialProfile());
        }
        catch (e) {
            console.error((e as Error).message);
        }
        const close = async () => {
            await manager.close();
            await host.close();
        };
        process.once('SIGINT', () => void close());
        process.once('SIGTERM', () => void close());
        return {
            close
        };
    }
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
        throw Error('Usage: pi-bot daemon|client|status|stop|chat');
    const listen = option('--listen') ?? 'http://127.0.0.1:' + Number(process.env.PI_BOT_GUI_PORT ?? 4317);
    const tailnet = tailnetListenerOptions(args);
    if (tailnet && (listen === 'stdio' || listen === 'off'))
        throw Error('Tailnet ingress requires the local HTTP runtime listener');
    const daemon = await PiBotDaemon.create({
        dataDir, piOptions: option('--pi-dir') ? {
            agentDir: resolve(option('--pi-dir')!)
        } : undefined, approvalRequired: args.includes('--approval-required'), drainTimeoutMs: Number(option('--drain-timeout') ?? 30000)
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
            port: Number(url.port), staticDir: option('--static'), ...(tailnet ? {
                tailnet: {
                    ...tailnet, name: option('--name')
                }
            } : {})
        });
        const http = transport as Awaited<ReturnType<typeof listenHttp>>;
        writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({
            pid: process.pid, agentDir: option('--pi-dir') ? resolve(option('--pi-dir')!) : undefined, protocolVersion: PROTOCOL_VERSION, http: http.url, tokenFile: join(dataDir, 'daemon.token'), startedAt: daemon.startedAt
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
