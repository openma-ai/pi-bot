/**
 * Per-pid input that does not move the real cursor, via trycua/cua cua-driver (MIT).
 * cua-driver's background delivery already implements the ladder
 *   AX action (AXPress / AXSetValue) → SkyLight SLEventPostToPid → CGEvent.postToPid
 * with no activation and no cursor warp. pi-bot only adds the last rung — global HID through
 * the pi-computer-use helper — and only after the caller re-verified focus on the bound window.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PidTarget = { pid: number; windowId: number };
export type PidInputResult = { ok: boolean; rung: 'cua-background' | 'global-hid'; detail?: unknown; error?: string };
export type CuaCall = (tool: string, args: Record<string, unknown>) => Promise<any>;

export function resolveCuaDriverBinary(home = homedir(), env: NodeJS.ProcessEnv = process.env): string | undefined {
    const p = env.PI_BOT_CUA_DRIVER_BIN?.trim() || join(home, 'Library', 'Application Support', 'pi-bot', 'bin', 'cua-driver');
    return existsSync(p) ? p : undefined;
}

/** Long-lived `cua-driver serve --socket` plus one-shot `cua-driver call` per action. */
export class CuaDriverClient {
    private daemon?: ChildProcess;
    readonly socket: string;
    constructor(readonly binary: string, stateDir = join(homedir(), 'Library', 'Caches', 'pi-bot', 'cua')) {
        mkdirSync(stateDir, { recursive: true });
        this.socket = join(stateDir, 'cua-driver.sock');
    }

    private ensureDaemon() {
        if (this.daemon && this.daemon.exitCode == null) return;
        this.daemon = spawn(this.binary, ['serve', '--socket', this.socket], { stdio: 'ignore' });
    }

    call: CuaCall = (tool, args) => {
        this.ensureDaemon();
        return new Promise((resolve, reject) => {
            execFile(this.binary, ['call', '--socket', this.socket, tool, JSON.stringify(args)], { timeout: 15000 }, (err, stdout, stderr) => {
                if (err) return reject(Object.assign(err, { stderr }));
                try { resolve(JSON.parse(stdout)); } catch { resolve({ raw: stdout }); }
            });
        });
    };

    close() { try { this.daemon?.kill('SIGTERM'); } catch { /* gone */ } this.daemon = undefined; }
}

function failed(r: any) {
    return !r || r.isError === true || r.ok === false || r.error;
}

export class PidInput {
    constructor(
        private readonly cua: CuaCall | undefined,
        /** Global HID fallback; MUST verify the bound window is frontmost before posting. */
        private readonly globalFallback: (action: 'click' | 'type' | 'key', args: Record<string, unknown>) => Promise<unknown>,
    ) {}

    private async ladder(tool: string, cuaArgs: Record<string, unknown>, action: 'click' | 'type' | 'key', globalArgs: Record<string, unknown>): Promise<PidInputResult> {
        let error: string | undefined;
        if (this.cua) {
            try {
                const r = await this.cua(tool, { ...cuaArgs, delivery_mode: 'background' });
                if (!failed(r)) return { ok: true, rung: 'cua-background', detail: r };
                error = JSON.stringify(r.error ?? r).slice(0, 300);
            } catch (e: any) { error = String(e?.stderr || e?.message || e).slice(0, 300); }
        } else error = 'cua-driver not installed';
        const detail = await this.globalFallback(action, globalArgs);
        return { ok: true, rung: 'global-hid', detail, error };
    }

    /** x/y are window-local points (cua-driver window screenshot space at scale 1). */
    click(t: PidTarget, local: { x: number; y: number }, global: { x: number; y: number }) {
        return this.ladder('click', { pid: t.pid, window_id: t.windowId, x: local.x, y: local.y }, 'click', global);
    }
    type(t: PidTarget, text: string) {
        return this.ladder('type_text', { pid: t.pid, window_id: t.windowId, text }, 'type', { text });
    }
    key(t: PidTarget, keys: string[]) {
        const key = keys[keys.length - 1];
        const modifiers = keys.slice(0, -1);
        const tool = modifiers.length ? 'hotkey' : 'press_key';
        const args = modifiers.length ? { pid: t.pid, window_id: t.windowId, keys } : { pid: t.pid, window_id: t.windowId, key };
        return this.ladder(tool, args, 'key', { keys });
    }
}
