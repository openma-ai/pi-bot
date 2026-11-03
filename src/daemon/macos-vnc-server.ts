/**
 * Per-bot VNC endpoint on macOS: one PabloZaiden/mac-vnc-server (MIT, ScreenCaptureKit) process
 * per bot display, pinned to that display's CGDirectDisplayID, bound to 127.0.0.1, view-only by
 * default. Takeover flips a control file to "interactive" (Linux: x11vnc -R noviewonly).
 * Built by scripts/build-macos-vnc-server.sh (pinned rev + native/macos/vendor/mac-vnc-server-pibot.patch).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { probeVnc } from './desktop-capabilities.ts';

export function resolveMacVncServerBinary(home = homedir(), env: NodeJS.ProcessEnv = process.env): string | undefined {
    const p = env.PI_BOT_MACOS_VNC_BIN?.trim() || join(home, 'Library', 'Application Support', 'pi-bot', 'bin', 'pi-mac-vnc-server');
    return existsSync(p) ? p : undefined;
}

export type VncSpawn = (bin: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
export type VncProbe = (port: number) => Promise<{ state: string; reason?: string }>;

export function macVncServerArgs(port: number) {
    // --display 1 is ignored by the patched server when MAC_VNC_DISPLAY_ID pins the display.
    return ['run', '--bind', '127.0.0.1', '--port', String(port), '--display', '1', '--no-password', '--insecure-allow-no-auth', '--no-adaptive'];
}

export class MacVncServer {
    private child?: ChildProcess;
    readonly controlFile: string;
    viewOnly = true;

    constructor(
        readonly botId: string,
        readonly displayID: number,
        readonly port: number,
        readonly binary: string,
        stateDir: string,
        private readonly spawnFn: VncSpawn = (bin, args, env) => spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }),
        private readonly probe: VncProbe = probeVnc,
    ) {
        mkdirSync(stateDir, { recursive: true });
        this.controlFile = join(stateDir, `vnc-${botId}.control`);
    }

    get endpoint() { return `vnc://127.0.0.1:${this.port}`; }
    get running() { return !!this.child && this.child.exitCode == null && !this.child.killed; }

    async start(timeoutMs = 8000) {
        this.setViewOnly(true);
        this.child = this.spawnFn(this.binary, macVncServerArgs(this.port), {
            ...process.env,
            MAC_VNC_DISPLAY_ID: String(this.displayID),
            MAC_VNC_VIEW_ONLY: '1',
            MAC_VNC_CONTROL_FILE: this.controlFile,
        });
        const deadline = Date.now() + timeoutMs;
        let last = 'not started';
        while (Date.now() < deadline) {
            if (this.child.exitCode != null) throw Error(`mac-vnc-server exited (${this.child.exitCode}) for ${this.botId}`);
            const r = await this.probe(this.port).catch(e => ({ state: 'error', reason: String(e) }));
            if (r.state === 'ready') return this;
            last = `${r.state} ${r.reason ?? ''}`;
            await new Promise(res => setTimeout(res, 200));
        }
        await this.close();
        throw Error(`mac-vnc-server on 127.0.0.1:${this.port} not ready (${last})`);
    }

    setViewOnly(viewOnly: boolean) {
        this.viewOnly = viewOnly;
        writeFileSync(this.controlFile, viewOnly ? 'view-only\n' : 'interactive\n');
    }

    async close() {
        const c = this.child;
        this.child = undefined;
        if (!c || c.exitCode != null) return;
        await new Promise<void>(res => {
            const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } res(); }, 3000);
            c.once('exit', () => { clearTimeout(t); res(); });
            try { c.kill('SIGTERM'); } catch { clearTimeout(t); res(); }
        });
    }
}
