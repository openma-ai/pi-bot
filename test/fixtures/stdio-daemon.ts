import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiBotDaemon } from '../../src/daemon/core/daemon.ts';
import { listenStdio } from '../../src/daemon/transports/stdio.ts';
const daemon = await PiBotDaemon.create({
    dataDir: mkdtempSync(join(tmpdir(), 'pi-stdio-child-')), factory: async (_bot, host) => ({
        run: async (e) => {
            host.sendMessage(e, 'stdio result', 'reply');
        }, close: async () => {
        }
    })
});
listenStdio(daemon);
