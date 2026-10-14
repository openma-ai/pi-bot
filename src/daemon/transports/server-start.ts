import { existsSync, readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PROTOCOL_VERSION } from '../../sdk/protocol/version.ts';
export type ServerEndpoint = {
    url: string;
    host: string;
    token: string;
    close(): void;
};
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Start/reuse a separate server process. Never embed runtime in a GUI client. */
export async function ensureServer(options: {
    dataDir: string;
    agentDir?: string;
    projectDir: string;
    port?: number;
    node?: string;
    timeoutMs?: number;
}) {
    const dataDir = resolve(options.projectDir, options.dataDir), discoveryPath = join(dataDir, 'daemon.json');
    const inspect = async () => {
        if (!existsSync(discoveryPath))
            return;
        let d: any;
        try {
            d = JSON.parse(readFileSync(discoveryPath, 'utf8'));
            process.kill(d.pid, 0);
        }
        catch {
            return;
        }
        const url = new URL(d.http);
        if (d.protocolVersion !== PROTOCOL_VERSION || url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
            throw Error('Server protocol or listener incompatible');
        if (options.agentDir && d.agentDir !== resolve(options.agentDir))
            throw Error('Server is using another Pi directory');
        // Never follow an arbitrary tokenFile in discovery.
        if (resolve(d.tokenFile) !== join(dataDir, 'daemon.token'))
            throw Error('Invalid server discovery');
        try {
            if (!(await fetch(url + '/readyz', {
                signal: AbortSignal.timeout(1500)
            })).ok)
                return;
            return {
                url: url.origin, host: url.host, token: readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim(), close() {
                }
            };
        }
        catch {
            return;
        }
    };
    const existing = await inspect();
    if (existing)
        return existing;
    mkdirSync(dataDir, {
        recursive: true
    });
    const log = openSync(join(dataDir, 'server.log'), 'a', 0o600);
    const child = spawn(options.node ?? process.execPath, ['--import', 'tsx', 'src/daemon/main.ts', 'daemon', '--data-dir', dataDir, '--listen', 'http://127.0.0.1:' + (options.port ?? 4318), ...(options.agentDir ? ['--pi-dir', resolve(options.agentDir)] : [])], {
        cwd: options.projectDir, detached: true, stdio: ['ignore', log, log]
    });
    closeSync(log);
    let failed = false;
    child.on('error', () => {
        failed = true;
    });
    child.unref();
    const until = Date.now() + (options.timeoutMs ?? 20000);
    while (Date.now() < until && !failed) {
        const endpoint = await inspect();
        if (endpoint)
            return endpoint;
        if (child.exitCode !== null)
            break;
        await delay(100);
    }
    // Only the process started by this attempt; existing servers are never stopped.
    if (child.exitCode === null)
        child.kill('SIGTERM');
    throw Error('Server did not become ready');
}
