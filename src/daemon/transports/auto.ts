import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PiBotClient, type ConnectOptions } from '../../sdk/client.ts';
import { PROTOCOL_VERSION } from '../../sdk/protocol/version.ts';
import { PiBotDaemon } from '../core/daemon.ts';
import { PiBotError } from '../core/errors.ts';
export async function connectAuto(options: ConnectOptions & {
    dataDir?: string;
} = {}) {
    const dir = resolve(options.dataDir ?? process.env.PI_BOT_DIR ?? 'work/gui/demo'), file = join(dir, 'daemon.json');
    if (existsSync(file)) {
        const discovery = JSON.parse(readFileSync(file, 'utf8'));
        let alive = true;
        try {
            process.kill(discovery.pid, 0);
        }
        catch (e: any) {
            if (e.code === 'ESRCH')
                alive = false;
            else if (e.code !== 'EPERM')
                throw e;
        }
        if (!alive)
            unlinkSync(file);
        else {
            if (discovery.protocolVersion !== PROTOCOL_VERSION)
                throw new PiBotError('invalidRequest', 'Daemon protocol version mismatch');
            const url = new URL(discovery.http);
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
                throw new PiBotError('forbidden', 'Discovery endpoint must be loopback');
            let ready = false;
            try {
                ready = (await fetch(url + '/readyz', {
                    signal: AbortSignal.timeout(2000)
                })).ok;
            }
            catch {
            }
            if (!ready)
                throw new PiBotError('invalidRequest', 'Existing daemon is not ready');
            const token = readFileSync(discovery.tokenFile, 'utf8');
            return {
                client: await PiBotClient.connect({
                    ...options, transport: {
                        http: discovery.http, token
                    }, auth: async () => ({
                        token: readFileSync(discovery.tokenFile, 'utf8')
                    })
                }), embedded: false, close: async () => {
                }
            };
        }
    }
    let daemon: PiBotDaemon;
    try {
        daemon = await PiBotDaemon.create({
            dataDir: dir
        });
    }
    catch (e: any) {
        if (/lock|owned/i.test(e.message))
            throw new PiBotError('conflict', 'Database is owned by a daemon without HTTP; start pi-bot daemon explicitly');
        throw e;
    }
    return {
        client: await PiBotClient.connect({
            ...options, transport: {
                inProcess: daemon
            }
        }), embedded: true, close: () => daemon.close()
    };
}
