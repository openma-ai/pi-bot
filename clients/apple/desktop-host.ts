import { resolve } from 'node:path';
import { RuntimeManager } from '../../src/daemon/transports/runtime-manager.ts';
import { listenClientHost } from '../../src/daemon/transports/client-host.ts';

// Start only the GUI host. Enabling a runtime remains an explicit action in Settings.
// In particular, opening the desktop app must not provision a daemon credential.
const root = resolve(process.argv[2]);
const manager = new RuntimeManager({ file: resolve(root, 'client/client.json'), defaults: {
    local: { mode: 'local', dataDir: resolve(root, 'runtime') }, ssh: null,
} });
const host = await listenClientHost(manager, { port: 0, bind: '127.0.0.1', staticDir: resolve('dist/gui') });
process.stdout.write(host.url + '\n');
let stopping = false;
async function stop() {
    if (stopping) return;
    stopping = true;
    await manager.close();
    await host.close();
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
