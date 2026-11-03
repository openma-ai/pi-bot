/**
 * macOS per-bot desktop lifecycle mirroring Linux desktop-service (Xvfb :N per bot).
 *
 * Linux: each bot gets its own X display, x11vnc on 5901+screen (-localhost -viewonly).
 * macOS: ONE long-lived companion process holds ONE CGVirtualDisplay PER BOT, created on the
 *        companion's main thread with a stable, unique, non-zero vendor/product/serial derived
 *        from the bot id (fixed serial ⇒ no mirror/extend prompt; ActiveSpace b1ebdbf, Crisp
 *        VirtualDisplayService). Destroy = release that bot's object only.
 *        Per-bot VNC = mac-vnc-server pinned to the bot's CGDirectDisplayID on 127.0.0.1:5901+screen.
 *        Agent input = per-pid (cua-driver: AX → SLEventPostToPid → CGEvent.postToPid), global HID
 *        only as a last resort and only after the bound window is verified frontmost.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { DesktopOwnership, type DesktopBinding } from './desktop-ownership.ts';
import jpeg from 'jpeg-js';
import { MacosHelperClient, createSerialQueue, type HelperFrame } from './macos-helper-client.ts';
import { MacVncServer, resolveMacVncServerBinary } from './macos-vnc-server.ts';
import { CuaDriverClient, PidInput, resolveCuaDriverBinary, type CuaCall, type PidInputResult } from './macos-pid-input.ts';

export const MACOS_DESKTOP_WIDTH = 1280;
export const MACOS_DESKTOP_HEIGHT = 800;
export const MACOS_MAX_WIDTH = 3840;
export const MACOS_MAX_HEIGHT = 2160;
/** Concurrent bot displays (Linux desktop capacity analogue). */
export const MACOS_VD_CAPACITY = Number(process.env.PI_BOT_MACOS_VD_CAPACITY ?? 4);
export const MACOS_VNC_BASE_PORT = 5901;
export const PIBOT_VENDOR_ID = 0x5049424f; // "PIBO"

export type DesktopSize = { width: number; height: number };
export type BoundWindow = { pid: number; windowId: number; windowRef?: string; title?: string; frame?: HelperFrame };
export type MacosDisplayIds = { vendor: number; product: number; serial: number };
export type MacosBotDisplay = MacosDisplayIds & {
    bot: string; displayID: number; width: number; height: number; bounds: HelperFrame;
    online?: boolean; active?: boolean; main?: boolean;
};

export type MacosSessionBinding = DesktopBinding & {
    display?: MacosBotDisplay;
    window?: BoundWindow;
    vnc?: { endpoint: string; port: number; viewOnly: boolean };
};

/** FNV-1a 32-bit. */
function fnv1a(text: string) {
    let h = 0x811c9dc5;
    for (const ch of Buffer.from(text, 'utf8')) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
}

/** Stable, non-zero ids for one bot's monitor; same bot ⇒ same ids across daemon restarts. */
export function stableDisplayIds(botId: string, salt = 0): MacosDisplayIds {
    const h = fnv1a(salt ? `${botId}#${salt}` : botId);
    return { vendor: PIBOT_VENDOR_ID, product: 0x1000 + (h % 0xe000), serial: h === 0 ? 1 : h };
}

/** "1600x900" → size; throws on garbage or out-of-range sizes. */
export function parseDesktopSize(value: string | undefined, fallback: DesktopSize, max: DesktopSize = { width: MACOS_MAX_WIDTH, height: MACOS_MAX_HEIGHT }): DesktopSize {
    if (!value?.trim()) return fallback;
    const m = /^(\d{3,5})x(\d{3,5})$/.exec(value.trim());
    if (!m) throw Error(`Invalid desktop size ${value}; expected WIDTHxHEIGHT`);
    const size = { width: Number(m[1]), height: Number(m[2]) };
    if (size.width < 320 || size.height < 240 || size.width > max.width || size.height > max.height) throw Error(`Desktop size ${value} outside 320x240..${max.width}x${max.height}`);
    return size;
}

export class FocusMismatchError extends Error {
    code = 'focusMismatch';
    constructor(readonly expected: BoundWindow, readonly actual: { pid?: number; windowId?: number; windowTitle?: string }) {
        super(`Focused window ${actual.pid}/${actual.windowId} (${actual.windowTitle ?? '?'}) is not the bound window ${expected.pid}/${expected.windowId}; input aborted`);
    }
}

export type MacosVirtualDisplayStatus = {
    running: boolean; binaryPath?: string; pid?: number; bindings: MacosSessionBinding[]; reason: string;
};

function defaultBinaryPath(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
    const explicit = env.PI_BOT_MACOS_VD_BIN?.trim();
    if (explicit) return isAbsolute(explicit) ? explicit : join(home, explicit);
    return join(home, 'Library', 'Application Support', 'pi-bot', 'bin', 'pi-virtual-display-companion');
}

function stateDir(home = homedir()) {
    const dir = join(home, 'Library', 'Caches', 'pi-bot', 'macos-virtual-display');
    mkdirSync(dir, { recursive: true });
    return dir;
}

function parseJsonLine(line: string): any | undefined {
    const t = line.trim();
    if (!t.startsWith('{')) return undefined;
    try { return JSON.parse(t); } catch { return undefined; }
}

export function resolveMacosVirtualDisplayBinary(cwd = process.cwd(), home = homedir(), env: NodeJS.ProcessEnv = process.env): string | undefined {
    return [defaultBinaryPath(home, env), join(cwd, 'native/macos/pi-virtual-display-companion'), join(home, 'pi-bot/native/macos/pi-virtual-display-companion')]
        .find(path => existsSync(path));
}

/** The companion process seam (tests inject a fake). */
export type CompanionSpawn = (binary: string) => ChildProcessWithoutNullStreams;

export type MacosHostOptions = {
    capacity?: number;
    helper?: MacosHelperClient;
    binaryPath?: string;
    home?: string;
    defaultSize?: DesktopSize;
    vncBasePort?: number;
    spawnCompanion?: CompanionSpawn;
    vncBinary?: string;
    createVnc?: (botId: string, displayID: number, port: number) => MacVncServer;
    cua?: CuaCall | null;
};

export class MacosVirtualDisplayHost {
    owners: DesktopOwnership;
    readonly capacity: number;
    readonly defaultSize: DesktopSize;
    readonly binaryPath?: string;
    readonly vncBasePort: number;
    private child?: ChildProcessWithoutNullStreams;
    private starting?: Promise<void>;
    private stdoutBuf = '';
    private readonly pending = new Map<string, Array<(msg: any) => void>>();
    private readonly displays = new Map<string, MacosBotDisplay>();
    private readonly windows = new Map<string, BoundWindow>();
    private readonly viewers = new Map<string, MacVncServer>();
    private readonly serial = createSerialQueue();
    private readonly helper: MacosHelperClient;
    private readonly home: string;
    private readonly pidInput: PidInput;
    private cuaClient?: CuaDriverClient;
    lastInput?: PidInputResult;

    constructor(private readonly opts: MacosHostOptions = {}) {
        this.capacity = opts.capacity ?? MACOS_VD_CAPACITY;
        this.helper = opts.helper ?? new MacosHelperClient();
        this.binaryPath = 'binaryPath' in opts ? opts.binaryPath : resolveMacosVirtualDisplayBinary();
        this.home = opts.home ?? homedir();
        this.vncBasePort = opts.vncBasePort ?? Number(process.env.PI_BOT_MACOS_VNC_BASE_PORT ?? MACOS_VNC_BASE_PORT);
        this.owners = new DesktopOwnership(this.capacity);
        this.defaultSize = opts.defaultSize ?? parseDesktopSize(process.env.PI_BOT_MACOS_DESKTOP_SIZE, { width: MACOS_DESKTOP_WIDTH, height: MACOS_DESKTOP_HEIGHT });
        let cua: CuaCall | undefined;
        if (opts.cua !== undefined) cua = opts.cua ?? undefined;
        else {
            const bin = resolveCuaDriverBinary(this.home);
            if (bin) { this.cuaClient = new CuaDriverClient(bin); cua = this.cuaClient.call; }
        }
        this.pidInput = new PidInput(cua, (action, args) => this.globalInput(action, args));
    }

    get status(): MacosVirtualDisplayStatus {
        const running = this.companionAlive();
        return {
            running, binaryPath: this.binaryPath, pid: this.child?.pid,
            bindings: [...this.owners.bindings.values()].map(b => this.enrich(b)),
            reason: running
                ? `Companion holds ${this.displays.size} per-bot virtual display(s) (capacity ${this.capacity})`
                : this.binaryPath ? 'Companion is not running' : 'pi-virtual-display-companion binary missing; run scripts/build-macos-virtual-display.sh',
        };
    }

    private companionAlive() { return !!this.child && !this.child.killed && this.child.exitCode == null; }

    private enrich(b: DesktopBinding): MacosSessionBinding {
        const v = this.viewers.get(b.botId);
        return { ...b, display: this.displays.get(b.botId), window: this.windows.get(b.botId), vnc: v ? { endpoint: v.endpoint, port: v.port, viewOnly: v.viewOnly } : undefined };
    }

    private async ensureCompanion() {
        if (this.companionAlive()) return;
        if (this.starting) return this.starting;
        this.starting = this.spawnCompanion().finally(() => { this.starting = undefined; });
        return this.starting;
    }

    private spawnCompanion(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.binaryPath || (!this.opts.spawnCompanion && !existsSync(this.binaryPath))) {
                reject(Object.assign(new Error('pi-virtual-display-companion binary is not installed'), { code: 'ENOENT' }));
                return;
            }
            const child = this.opts.spawnCompanion?.(this.binaryPath) ?? spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
            this.child = child;
            this.stdoutBuf = '';
            let ready = false;
            const timer = setTimeout(() => { if (!ready) { try { child.kill('SIGTERM'); } catch { /* */ } reject(Object.assign(new Error('companion ready timed out'), { code: 'ETIMEDOUT' })); } }, 8000);
            timer.unref?.();
            child.stdout.on('data', (chunk: Buffer | string) => {
                this.stdoutBuf += String(chunk);
                let idx: number;
                while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
                    const msg = parseJsonLine(this.stdoutBuf.slice(0, idx));
                    this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
                    if (!msg) continue;
                    if (msg.event === 'ready' && !ready) { ready = true; clearTimeout(timer); this.persist(); resolve(); continue; }
                    if (msg.event === 'warning') continue;
                    const key = msg.bot ?? `#${msg.event}`;
                    const q = this.pending.get(key);
                    const cb = q?.shift();
                    if (cb) cb(msg);
                }
            });
            child.on('error', e => { if (!ready) { clearTimeout(timer); reject(e); } });
            child.on('exit', code => {
                if (this.child === child) this.child = undefined;
                this.displays.clear();
                for (const [, q] of this.pending) for (const cb of q.splice(0)) cb({ ok: false, error: `companion exited (${code})` });
                if (!ready) { clearTimeout(timer); reject(Object.assign(new Error(`companion exited before ready (code ${code})`), { code: 'EPIPE' })); }
            });
        });
    }

    private request(key: string, payload: Record<string, unknown>, timeoutMs = 10000): Promise<any> {
        return new Promise((resolve, reject) => {
            const q = this.pending.get(key) ?? [];
            this.pending.set(key, q);
            const t = setTimeout(() => { const i = q.indexOf(done); if (i >= 0) q.splice(i, 1); reject(Object.assign(new Error(`companion ${payload.cmd} timed out`), { code: 'ETIMEDOUT' })); }, timeoutMs);
            const done = (msg: any) => { clearTimeout(t); resolve(msg); };
            q.push(done);
            this.child!.stdin.write(`${JSON.stringify(payload)}\n`);
        });
    }

    private idsFor(botId: string): MacosDisplayIds {
        for (let salt = 0; salt < 16; salt++) {
            const ids = stableDisplayIds(botId, salt);
            const clash = [...this.displays.values()].some(d => d.bot !== botId && (d.serial === ids.serial || d.product === ids.product));
            if (!clash) return ids;
        }
        throw Error(`Could not derive unique display ids for ${botId}`);
    }

    /** Create (or reuse) this bot's own display at its configured size (default 1280x800). */
    async bind(botId: string, options: { targetId?: string; size?: DesktopSize | string } = {}): Promise<MacosSessionBinding> {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(botId)) throw Error('Invalid bot ID');
        if (this.owners.bindings.has(botId) && this.displays.has(botId)) return this.enrich(this.owners.require(botId));
        const size = typeof options.size === 'string' ? parseDesktopSize(options.size, this.defaultSize) : options.size ?? this.defaultSize;
        parseDesktopSize(`${size.width}x${size.height}`, size);
        await this.ensureCompanion();
        const b = this.owners.bindings.get(botId) ?? this.owners.bind(botId, options.targetId ?? `macos:${botId}`, -(1 + this.owners.bindings.size));
        const ids = this.idsFor(botId);
        const msg = await this.request(botId, { cmd: 'create', bot: botId, width: size.width, height: size.height, ...ids, name: `PiBot ${botId}` });
        if (!msg?.ok || !msg.display?.displayID) {
            this.owners.bindings.delete(botId);
            throw Object.assign(new Error(`Virtual display create failed for ${botId}: ${msg?.error ?? 'unknown'}`), { code: 'EIO' });
        }
        const d: MacosBotDisplay = { ...ids, ...msg.display, bot: botId, displayID: Number(msg.display.displayID), width: size.width, height: size.height };
        this.displays.set(botId, d);
        b.width = size.width; b.height = size.height; b.x = d.bounds.x; b.y = d.bounds.y;
        this.persist();
        return this.enrich(b);
    }

    private persist() {
        try {
            writeFileSync(join(stateDir(this.home), 'companion.json'), JSON.stringify({ pid: this.child?.pid, at: Date.now(), displays: [...this.displays.values()] }, null, 2));
            writeFileSync(join(stateDir(this.home), 'bindings.json'), JSON.stringify([...this.owners.bindings.values()].map(b => this.enrich(b)), null, 2));
        } catch { /* best effort */ }
    }

    /** Destroy = stop the bot's VNC server and release only that bot's display object. */
    async release(botId: string) {
        const viewer = this.viewers.get(botId);
        this.viewers.delete(botId);
        if (viewer) await viewer.close();
        this.windows.delete(botId);
        this.owners.release(botId);
        this.owners.bindings.delete(botId);
        let result: any;
        if (this.displays.has(botId) && this.companionAlive()) {
            result = await this.request(botId, { cmd: 'destroy', bot: botId });
        }
        this.displays.delete(botId);
        this.persist();
        return result;
    }

    async shutdownCompanion() {
        for (const id of [...this.viewers.keys()]) { await this.viewers.get(id)!.close(); this.viewers.delete(id); }
        const child = this.child;
        this.child = undefined;
        this.displays.clear();
        this.cuaClient?.close();
        if (!child || child.exitCode != null) return;
        await new Promise<void>(res => {
            const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } res(); }, 7000);
            child.once('exit', () => { clearTimeout(t); res(); });
            try { child.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`); } catch { /* ignore */ }
        });
        this.persist();
    }

    display(botId: string) {
        const d = this.displays.get(botId);
        if (!d) throw Error(`No virtual display for ${botId}`);
        return d;
    }

    /** The bot's desktop frame in global points (its own display). */
    tileFrame(botId: string): HelperFrame {
        const d = this.display(botId);
        return { x: d.bounds.x, y: d.bounds.y, w: d.width, h: d.height };
    }

    toGlobal(botId: string, x: number, y: number) {
        const t = this.tileFrame(botId);
        if (x < 0 || y < 0 || x >= t.w || y >= t.h) throw Error(`Point ${x},${y} is outside the ${t.w}x${t.h} desktop`);
        return { x: t.x + x, y: t.y + y };
    }

    /** helper captureDisplay index of this bot's display (matched by exact bounds). */
    async displayIndex(botId: string): Promise<number> {
        const f = this.tileFrame(botId);
        const shot = await this.helper.captureDisplay(0, 64);
        const m = (shot.displays ?? []).find(d => d.frame?.x === f.x && d.frame?.y === f.y && d.frame?.w === f.w && d.frame?.h === f.h);
        if (!m) throw Object.assign(new Error(`Display of ${botId} not visible to helper captureDisplay`), { code: 'ENOTFOUND' });
        return m.index;
    }

    /** Screenshot of the bot's whole display, scaled to the configured desktop size. */
    async captureTile(botId: string) {
        const tile = this.tileFrame(botId);
        return this.serial(async () => {
            const index = await this.displayIndex(botId);
            const shot = await this.helper.captureDisplay(index, Math.max(tile.w, tile.h));
            const decoded = jpeg.decode(Buffer.from(shot.image.jpegBase64, 'base64'), { useTArray: true, formatAsRGBA: true });
            return { ...cropFrame(decoded, tile, { ...tile }), tile };
        });
    }

    bindWindow(botId: string, window: BoundWindow) {
        const b = this.owners.require(botId);
        for (const [other, w] of this.windows) {
            if (other !== botId && w.pid === window.pid && w.windowId === window.windowId) throw Error('Window ownership conflict');
        }
        this.windows.set(botId, window);
        b.windowId = window.windowId;
        b.targetId = `macos:${window.pid}:${window.windowId}`;
        this.persist();
        return this.enrich(b);
    }

    boundWindow(botId: string) {
        const w = this.windows.get(botId);
        if (!w) throw Error('No window is bound to this session');
        return w;
    }

    /** Focus the bound window and verify the frontmost window is exactly it. Must run inside serial(). */
    private async focusBound(botId: string) {
        const w = this.boundWindow(botId);
        await this.helper.focusWindow(w.pid, w.windowRef, w.windowId);
        let front: any;
        for (let i = 0; i < 5; i++) {
            front = await this.helper.getFrontmost();
            if (front?.pid === w.pid && front?.windowId === w.windowId) return w;
            await new Promise(r => setTimeout(r, 80));
        }
        throw new FocusMismatchError(w, front ?? {});
    }

    private inputBot?: string;
    /** Last rung only: global HID after the focus check (drag/canvas apps). */
    private async globalInput(action: 'click' | 'type' | 'key', args: Record<string, unknown>) {
        await this.focusBound(this.inputBot!);
        return this.helper.desktopInput(action, args);
    }

    /** Move the bound window onto the bot's own display and size it to the display (AX setWindowFrame). */
    async confineWindow(botId: string) {
        const tile = this.tileFrame(botId);
        const w = this.boundWindow(botId);
        return this.serial(async () => {
            await this.helper.setWindowFrame(w.pid, { x: tile.x, y: tile.y, w: tile.w, h: tile.h }, w.windowRef, w.windowId);
            w.frame = { ...tile };
            return tile;
        });
    }

    private async input(botId: string, human: boolean, op: (t: BoundWindow) => Promise<PidInputResult>) {
        if (human) {
            if (this.owners.control()?.botId !== botId) throw Error('Viewer input requires this session\'s takeover lease');
        } else this.owners.requireAgent(botId);
        const w = this.boundWindow(botId);
        return this.serial(async () => {
            this.inputBot = botId;
            try { this.lastInput = await op(w); return this.lastInput; } finally { this.inputBot = undefined; }
        });
    }

    typeInTile(botId: string, text: string, human = false) {
        return this.input(botId, human, w => this.pidInput.type(w, text));
    }

    /** x/y are desktop-local (0..width, 0..height of the bot's display). */
    clickInTile(botId: string, x: number, y: number, human = false) {
        const g = this.toGlobal(botId, x, y);
        return this.input(botId, human, w => {
            const f = w.frame ?? this.tileFrame(botId);
            return this.pidInput.click(w, { x: g.x - f.x, y: g.y - f.y }, g);
        });
    }

    keyInTile(botId: string, keys: string[], human = false) {
        return this.input(botId, human, w => this.pidInput.key(w, keys));
    }

    async readWindowText(botId: string): Promise<string[]> {
        const w = this.boundWindow(botId);
        const look = await this.helper.look(w.pid, w.windowId);
        const out: string[] = [];
        const walk = (n: any) => {
            if (!n) return;
            if (n.role === 'AXTextArea' || n.role === 'AXTextField') out.push(String(n.value ?? ''));
            for (const c of n.children ?? []) walk(c);
        };
        if (look?.window?.windowId !== undefined && look.window.windowId !== w.windowId) throw Error('AX look returned a different window');
        walk(look?.outline);
        return out;
    }

    /** Linux parity: per-bot VNC on 127.0.0.1:(base+screen) showing only that bot's display; view-only until takeover. */
    async openViewer(botId: string) {
        const b = this.owners.require(botId);
        const existing = this.viewers.get(botId);
        if (existing?.running) return this.enrich(b).vnc!;
        const d = this.display(botId);
        const port = this.vncBasePort + b.screen;
        let server: MacVncServer;
        if (this.opts.createVnc) server = this.opts.createVnc(botId, d.displayID, port);
        else {
            const bin = this.opts.vncBinary ?? resolveMacVncServerBinary(this.home);
            if (!bin) throw Object.assign(new Error('pi-mac-vnc-server missing; run scripts/build-macos-vnc-server.sh'), { code: 'ENOENT' });
            server = new MacVncServer(botId, d.displayID, port, bin, stateDir(this.home));
        }
        await server.start();
        server.setViewOnly(this.owners.control()?.botId !== botId);
        this.viewers.set(botId, server);
        this.persist();
        return this.enrich(b).vnc!;
    }

    vncPorts(botId?: string) {
        return [...this.viewers.entries()].filter(([id]) => !botId || id === botId).map(([, v]) => v.port);
    }

    takeover(botId: string, ms?: number) {
        const lease = this.owners.takeover(botId, ms);
        this.viewers.get(botId)?.setViewOnly(false);
        return lease;
    }

    releaseControl(botId: string) {
        this.owners.release(botId);
        this.viewers.get(botId)?.setViewOnly(true);
    }
}

/** Crop the tile (global points) out of a companion capture whose pixels may be scaled. */
export function cropFrame(img: { width: number; height: number; data: Uint8Array }, companion: HelperFrame, tile: HelperFrame): { width: number; height: number; data: Uint8Array } {
    const sx = img.width / companion.w, sy = img.height / companion.h;
    const out = new Uint8Array(tile.w * tile.h * 4);
    for (let y = 0; y < tile.h; y++) {
        const srcY = Math.min(img.height - 1, Math.floor((tile.y - companion.y + y) * sy));
        for (let x = 0; x < tile.w; x++) {
            const srcX = Math.min(img.width - 1, Math.floor((tile.x - companion.x + x) * sx));
            const s = (srcY * img.width + srcX) * 4, d = (y * tile.w + x) * 4;
            out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = 255;
        }
    }
    return { width: tile.w, height: tile.h, data: out };
}

/** Read last companion.json written by a live host (for probes without holding the child). */
export function readCompanionState(home = homedir()): { pid?: number; displays?: MacosBotDisplay[] } | undefined {
    try {
        const raw = JSON.parse(readFileSync(join(stateDir(home), 'companion.json'), 'utf8'));
        if (raw?.pid) return raw;
    } catch { /* absent */ }
    return undefined;
}
