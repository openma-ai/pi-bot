/**
 * Minimal unix-socket client for the @nredd/pi-computer-use helper bridge.
 * Credential-free; never calls registerPermissions. Used by the macOS virtual-display host.
 */
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type HelperFrame = { x: number; y: number; w: number; h: number };
export type HelperWindow = {
    title?: string;
    windowId?: number;
    windowRef?: string;
    pid?: number;
    framePoints?: HelperFrame;
    [key: string]: unknown;
};

const DEFAULT_SOCKET = () => process.env.PI_CU_SOCKET_PATH ?? join(homedir(), 'Library', 'Caches', 'pi-computer-use', 'bridge.sock');

export class MacosHelperClient {
    constructor(readonly socketPath = DEFAULT_SOCKET(), readonly defaultTimeoutMs = 15000) {}

    command<T = any>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = this.defaultTimeoutMs): Promise<T> {
        return new Promise((resolve, reject) => {
            const socket = connect(this.socketPath);
            let buffer = '';
            let done = false;
            const finish = (err?: Error, value?: T) => {
                if (done) return;
                done = true;
                clearTimeout(deadline);
                socket.destroy();
                if (err) reject(err);
                else resolve(value as T);
            };
            const deadline = setTimeout(() => finish(Object.assign(new Error(`helper ${cmd} timed out`), { code: 'ETIMEDOUT' })), timeoutMs);
            socket.setEncoding('utf8');
            socket.on('connect', () => {
                const id = `pibo_${cmd}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
                socket.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
            });
            socket.on('data', chunk => {
                buffer += chunk;
                const newline = buffer.indexOf('\n');
                if (newline < 0) return;
                try {
                    const parsed = JSON.parse(buffer.slice(0, newline));
                    if (parsed.ok !== true) {
                        finish(Object.assign(new Error(parsed?.error?.message ?? `${cmd} failed`), { code: parsed?.error?.code ?? 'EPERM', details: parsed?.error }));
                        return;
                    }
                    finish(undefined, (parsed.result ?? parsed) as T);
                } catch (error) {
                    finish(error instanceof Error ? error : new Error(String(error)));
                }
            });
            socket.on('error', error => {
                const code = (error as NodeJS.ErrnoException).code;
                finish(Object.assign(error instanceof Error ? error : new Error(String(error)), { code: code ?? 'ECONNREFUSED' }));
            });
            socket.on('end', () => finish(Object.assign(new Error('helper closed before answering'), { code: 'ECONNRESET' })));
        });
    }

    checkPermissions() {
        return this.command<{ accessibility: boolean; screenRecordingCapturable?: boolean; screenRecordingPreflight?: boolean }>('checkPermissions');
    }
    listRoots() { return this.command('listRoots'); }
    listWindows(pid: number) { return this.command<HelperWindow[] | { windows: HelperWindow[] }>('listWindows', { pid }); }
    listApps() { return this.command('listApps'); }
    captureDisplay(display: number, maxDimension = 1280) {
        return this.command<{ image: { jpegBase64: string; width: number; height: number }; displays: Array<{ index: number; isMain: boolean; frame: HelperFrame }> }>('captureDisplay', { display, maxDimension });
    }
    focusWindow(pid: number, windowRef?: string, windowId?: number) {
        return this.command('focusWindow', { pid, windowRef, windowId });
    }
    setWindowFrame(pid: number, frame: HelperFrame, windowRef?: string, windowId?: number) {
        return this.command('setWindowFrame', { pid, frame, windowRef, windowId });
    }
    desktopInput(action: string, args: Record<string, unknown> = {}) {
        return this.command('desktopInput', { action, ...args });
    }
}

/** Serialize concurrent helper input — macOS has one global cursor/focus. */
export function createSerialQueue() {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
        const next = tail.then(fn, fn);
        tail = next.then(() => undefined, () => undefined);
        return next;
    };
}
