import { PiBotDaemon } from '../../../../../src/daemon/core/daemon.ts';
import { listenHttp } from '../../../../../src/daemon/transports/http.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '../../../../../src/sdk/protocol/version.ts';
const daemon = await PiBotDaemon.create({
    dataDir: '/data/runtime', piOptions: {
        agentDir: '/data/empty-pi', cwd: '/data'
    }, factory: async (bot, host) => ({
        run: async (e) => {
            const ctx = host.fileContext!(e);
            for (const [i, input] of ctx.attachments.entries()) {
                const file = input as {
                    path: string;
                    mime: string;
                    untrusted: boolean;
                };
                if (file.untrusted !== true)
                    throw Error('Fixture expects untrusted uploaded data');
                const bytes = readFileSync(file.path);
                const mime = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mime) ? file.mime : 'application/octet-stream';
                const ext = ({
                    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif'
                } as Record<string, string>)[mime] || '.bin';
                const name = 'answer-' + i + ext;
                writeFileSync(join(ctx.outputDir, name), bytes);
                host.publishFile!(e, name, mime, 'answer:' + e.id + ':' + i);
            }
        }, close: async () => {
        }
    })
});
const host = process.env.PIBO_TEST_TAILNET_IP;
if (!host)
    throw Error('Explicit current test-node IP required');
const http = await listenHttp(daemon, {
    port: 4318, tailnet: {
        host, port: 4319, listenMode: 'serve-loopback', name: 'Pibo isolated direct test'
    }
});
writeFileSync(join(daemon.dataDir, 'daemon.json'), JSON.stringify({pid:process.pid,protocolVersion:PROTOCOL_VERSION,http:http.url,tokenFile:join(daemon.dataDir,'daemon.token'),startedAt:daemon.startedAt}),{mode:0o600});
console.log('Pibo isolated direct service ready; no model provider');
process.once('SIGTERM', async () => {
    await http.close();
    await daemon.close();
    process.exit(0);
});
