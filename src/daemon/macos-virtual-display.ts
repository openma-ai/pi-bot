/**
 * macOS per-session desktop lifecycle mirroring Linux desktop-service + DesktopOwnership.
 *
 * Linux: one X11 :99, tiles of 1280×900, serial input, x11vnc -clip per tile.
 * macOS: one CGVirtualDisplay companion, one slot per session (slot = max tile size),
 *        each session's tile has its own configured size (default 1280×800),
 *        input serialized and gated on "focused window == the session's bound window",
 *        per-session localhost RFB endpoint (5901+screen) serving only that tile.
 *
 * Measured on macOS 27.2 (botty): only one third-party CGVirtualDisplay stays online at a
 * time — creating another evicts the previous one — so sessions tile one companion
 * instead of owning a display each.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { DesktopOwnership, type DesktopBinding } from './desktop-ownership.ts';
import jpeg from 'jpeg-js';
import { MacosHelperClient, createSerialQueue, type HelperFrame, type HelperWindow } from './macos-helper-client.ts';
import { RfbTileServer, type RgbaFrame } from './rfb-tile-server.ts';

export const MACOS_TILE_WIDTH = 1280;
export const MACOS_TILE_HEIGHT = 800;
/** Companion = capacity × slot; 2 × 1920×1080 = 3840×1080. A 7680-wide request never became ready on macOS 27.2. */
export const MACOS_VD_CAPACITY = 2;
export const MACOS_COMPANION_NAME = 'PiBot-Companion';

export type MacosDisplayBounds = HelperFrame;
export type MacosCompanionInfo = {
    displayID: number;
    width: number;
    height: number;
    bounds: MacosDisplayBounds;
    online?: boolean;
    active?: boolean;
    main?: boolean;
};

export const MACOS_SLOT_WIDTH = 1920;
export const MACOS_SLOT_HEIGHT = 1080;
export const MACOS_VNC_BASE_PORT = 5901;

export type DesktopSize = { width: number; height: number };
export type BoundWindow = { pid: number; windowId: number; windowRef?: string; title?: string };

export type MacosSessionBinding = DesktopBinding & {
    displayID: number;
    displayIndex: number;
    companionBounds: MacosDisplayBounds;
    window?: BoundWindow;
    vnc?: { endpoint: string; port: number; viewOnly: boolean };
};

/** "1600x900" → size; throws on garbage or sizes beyond the slot. */
export function parseDesktopSize(value: string | undefined, fallback: DesktopSize, max: DesktopSize = { width: MACOS_SLOT_WIDTH, height: MACOS_SLOT_HEIGHT }): DesktopSize {
    if (!value?.trim()) return fallback;
    const m = /^(\d{3,5})x(\d{3,5})$/.exec(value.trim());
    if (!m) throw Error(`Invalid desktop size ${value}; expected WIDTHxHEIGHT`);
    const size = { width: Number(m[1]), height: Number(m[2]) };
    if (size.width > max.width || size.height > max.height) throw Error(`Desktop size ${value} exceeds slot ${max.width}x${max.height}`);
    return size;
}

export class FocusMismatchError extends Error {
    code = 'focusMismatch';
    constructor(readonly expected: BoundWindow, readonly actual: { pid?: number; windowId?: number; windowTitle?: string }) {
        super(`Focused window ${actual.pid}/${actual.windowId} (${actual.windowTitle ?? '?'}) is not the bound window ${expected.pid}/${expected.windowId}; input aborted`);
    }
}

export type MacosVirtualDisplayStatus = {
    running: boolean;
    companion?: MacosCompanionInfo;
    binaryPath?: string;
    pid?: number;
    bindings: MacosSessionBinding[];
    reason: string;
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
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try { return JSON.parse(trimmed); } catch { return undefined; }
}

export function resolveMacosVirtualDisplayBinary(cwd = process.cwd(), home = homedir(), env: NodeJS.ProcessEnv = process.env): string | undefined {
    const candidates = [
        defaultBinaryPath(home, env),
        join(cwd, 'native/macos/pi-virtual-display-companion'),
        join(home, 'pi-bot/native/macos/pi-virtual-display-companion'),
    ];
    return candidates.find(path => existsSync(path));
}

export class MacosVirtualDisplayHost {
    owners: DesktopOwnership;
    private child?: ChildProcessWithoutNullStreams;
    private companion?: MacosCompanionInfo;
    private displayIndex = -1;
    private starting?: Promise<MacosCompanionInfo>;
    private readonly serial = createSerialQueue();
    private readonly helper: MacosHelperClient;
    private stdoutBuf = '';
    private readonly windows = new Map<string, BoundWindow>();
    private readonly viewers = new Map<string, RfbTileServer>();
    readonly defaultSize: DesktopSize;

    constructor(
        public capacity = MACOS_VD_CAPACITY,
        readonly slotWidth = MACOS_SLOT_WIDTH,
        readonly slotHeight = MACOS_SLOT_HEIGHT,
        helper?: MacosHelperClient,
        readonly binaryPath = resolveMacosVirtualDisplayBinary(),
        private readonly home = homedir(),
        defaultSize?: DesktopSize,
        readonly vncBasePort = Number(process.env.PI_BOT_MACOS_VNC_BASE_PORT ?? MACOS_VNC_BASE_PORT),
    ) {
        this.helper = helper ?? new MacosHelperClient();
        this.owners = new DesktopOwnership(capacity);
        this.defaultSize = defaultSize ?? parseDesktopSize(process.env.PI_BOT_MACOS_DESKTOP_SIZE, { width: MACOS_TILE_WIDTH, height: MACOS_TILE_HEIGHT }, { width: slotWidth, height: slotHeight });
    }

    get status(): MacosVirtualDisplayStatus {
        const running = !!this.companion && !!this.child && !this.child.killed && this.child.exitCode == null;
        return {
            running,
            companion: this.companion,
            binaryPath: this.binaryPath,
            pid: this.child?.pid,
            bindings: [...this.owners.bindings.values()].map(b => this.enrich(b)),
            reason: running
                ? `Companion virtual display ${this.companion!.displayID} hosts up to ${this.capacity} sessions (slot ${this.slotWidth}x${this.slotHeight})`
                : this.binaryPath
                    ? 'Companion virtual display is not running'
                    : 'pi-virtual-display-companion binary missing; run scripts/build-macos-virtual-display.sh',
        };
    }

    private enrich(b: DesktopBinding): MacosSessionBinding {
        const v = this.viewers.get(b.botId);
        return {
            ...b,
            displayID: this.companion?.displayID ?? 0,
            displayIndex: this.displayIndex,
            companionBounds: this.companion?.bounds ?? { x: 0, y: 0, w: 0, h: 0 },
            window: this.windows.get(b.botId),
            vnc: v ? { endpoint: v.endpoint, port: v.port, viewOnly: v.viewOnly } : undefined,
        };
    }

    private companionPixelSize() {
        return { width: this.capacity * this.slotWidth, height: this.slotHeight };
    }

    async ensureCompanion(): Promise<MacosCompanionInfo> {
        if (this.companion && this.child && !this.child.killed && this.child.exitCode == null) return this.companion;
        if (this.starting) return this.starting;
        this.starting = this.spawnCompanion().finally(() => { this.starting = undefined; });
        return this.starting;
    }

    private spawnCompanion(): Promise<MacosCompanionInfo> {
        return new Promise((resolve, reject) => {
            if (!this.binaryPath || !existsSync(this.binaryPath)) {
                reject(Object.assign(new Error('pi-virtual-display-companion binary is not installed'), { code: 'ENOENT' }));
                return;
            }
            const { width, height } = this.companionPixelSize();
            const originX = -width;
            const child = spawn(this.binaryPath, [
                '--width', String(width),
                '--height', String(height),
                '--name', MACOS_COMPANION_NAME,
                '--origin-x', String(originX),
                '--origin-y', '0',
            ], { stdio: ['pipe', 'pipe', 'pipe'] });
            this.child = child;
            this.stdoutBuf = '';
            let settled = false;
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                try { child.kill('SIGTERM'); } catch { /* ignore */ }
                if (this.child === child) this.child = undefined;
                reject(error);
            };
            const succeed = (info: MacosCompanionInfo) => {
                if (settled) return;
                settled = true;
                this.companion = info;
                writeFileSync(join(stateDir(this.home), 'companion.json'), JSON.stringify({ ...info, pid: child.pid, at: Date.now() }, null, 2));
                resolve(info);
            };
            const onData = (chunk: Buffer | string) => {
                this.stdoutBuf += String(chunk);
                let idx: number;
                while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
                    const line = this.stdoutBuf.slice(0, idx);
                    this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
                    const msg = parseJsonLine(line);
                    if (!msg) continue;
                    if (msg.ok === true && msg.event === 'ready' && msg.display) {
                        succeed({
                            displayID: Number(msg.display.displayID),
                            width: Number(msg.display.width ?? width),
                            height: Number(msg.display.height ?? height),
                            bounds: msg.display.bounds,
                            online: msg.display.online,
                            active: msg.display.active,
                            main: msg.display.main,
                        });
                    } else if (msg.ok === false) {
                        fail(Object.assign(new Error(String(msg.error ?? 'companion failed')), { code: 'EIO' }));
                    }
                }
            };
            const cleanup = () => {
                child.stdout.off('data', onData);
                child.stderr.off('data', onData);
                child.off('error', onError);
                child.off('exit', onExit);
            };
            const onError = (error: Error) => fail(error);
            const onExit = (code: number | null) => {
                this.companion = undefined;
                this.displayIndex = -1;
                if (!settled) fail(Object.assign(new Error(`companion exited before ready (code ${code})`), { code: 'EPIPE' }));
            };
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);
            child.on('error', onError);
            child.on('exit', onExit);
            setTimeout(() => fail(Object.assign(new Error('companion ready timed out'), { code: 'ETIMEDOUT' })), 8000).unref?.();
        });
    }

    async refreshDisplayIndex(): Promise<number> {
        const capture = await this.helper.captureDisplay(0, 64);
        const displays = capture.displays ?? [];
        // helper reports no CGDirectDisplayID; match the companion's real bounds exactly.
        const c = this.companion?.bounds;
        const match = c && displays.find(d => !d.isMain && d.frame?.x === c.x && d.frame?.y === c.y && d.frame?.w === c.w && d.frame?.h === c.h);
        if (!match) throw Object.assign(new Error('Companion display not visible to helper captureDisplay'), { code: 'ENOTFOUND' });
        this.displayIndex = match.index;
        if (this.companion && match.frame) this.companion.bounds = match.frame;
        return this.displayIndex;
    }

    /** Bind a session to the next slot; size comes from config (default 1280x800) or the caller. */
    async bind(botId: string, options: { targetId?: string; size?: DesktopSize | string } = {}): Promise<MacosSessionBinding> {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(botId)) throw Error('Invalid bot ID');
        await this.ensureCompanion();
        await this.refreshDisplayIndex();
        if (this.owners.bindings.has(botId)) return this.enrich(this.owners.require(botId));
        const size = typeof options.size === 'string'
            ? parseDesktopSize(options.size, this.defaultSize, { width: this.slotWidth, height: this.slotHeight })
            : options.size ?? this.defaultSize;
        if (size.width > this.slotWidth || size.height > this.slotHeight) throw Error(`Desktop size ${size.width}x${size.height} exceeds slot ${this.slotWidth}x${this.slotHeight}`);
        const b = this.owners.bind(botId, options.targetId ?? `macos:${botId}`, -(1 + this.owners.bindings.size));
        b.width = size.width;
        b.height = size.height;
        b.x = this.companion!.bounds.x + b.screen * this.slotWidth;
        b.y = this.companion!.bounds.y;
        this.persist();
        return this.enrich(b);
    }

    private persist() {
        writeFileSync(join(stateDir(this.home), 'bindings.json'), JSON.stringify([...this.owners.bindings.values()].map(b => this.enrich(b)), null, 2));
    }

    async release(botId: string) {
        const viewer = this.viewers.get(botId);
        this.viewers.delete(botId);
        if (viewer) await viewer.close();
        this.windows.delete(botId);
        this.owners.release(botId);
        this.owners.bindings.delete(botId);
        this.persist();
        if (this.owners.bindings.size === 0) await this.shutdownCompanion();
    }

    async shutdownCompanion() {
        const child = this.child;
        this.child = undefined;
        this.companion = undefined;
        this.displayIndex = -1;
        if (!child || child.exitCode != null) return;
        try { child.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`); } catch { /* ignore */ }
        await new Promise<void>(resolve => {
            const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 7000);
            child.once('exit', () => { clearTimeout(t); resolve(); });
        });
        try { writeFileSync(join(stateDir(this.home), 'companion.json'), JSON.stringify({ stoppedAt: Date.now() })); } catch { /* ignore */ }
    }

    /** Absolute tile frame in global macOS coordinates. */
    tileFrame(botId: string): HelperFrame {
        const b = this.owners.require(botId);
        return { x: b.x, y: b.y, w: b.width, h: b.height };
    }

    /** Map tile-local coords → global; rejects points outside the session's tile. */
    toGlobal(botId: string, x: number, y: number) {
        const t = this.tileFrame(botId);
        if (x < 0 || y < 0 || x >= t.w || y >= t.h) throw Error(`Point ${x},${y} is outside the ${t.w}x${t.h} desktop`);
        return { x: t.x + x, y: t.y + y };
    }

    /** Tile pixels only (RGBA, tile size), cropped from a native-resolution companion capture. */
    async captureTile(botId: string): Promise<RgbaFrame & { tile: HelperFrame }> {
        const tile = this.tileFrame(botId);
        return this.serial(async () => {
            if (this.displayIndex < 0) await this.refreshDisplayIndex();
            const shot = await this.helper.captureDisplay(this.displayIndex, this.companionPixelSize().width);
            const decoded = jpeg.decode(Buffer.from(shot.image.jpegBase64, 'base64'), { useTArray: true, formatAsRGBA: true });
            return { ...cropFrame(decoded, this.companion!.bounds, tile), tile };
        });
    }

    /** Bind the exact window (pid + windowId + AX windowRef) the session owns. */
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

    /** Move the bound window into the session's tile and size it to the tile. */
    async confineWindow(botId: string, frameHint?: HelperFrame) {
        const tile = this.tileFrame(botId);
        const w = this.boundWindow(botId);
        return this.serial(async () => {
            await this.focusBound(botId);
            const frame = frameHint ?? { x: 0, y: 0, w: 800, h: 600 };
            const startX = frame.x + frame.w / 2;
            const startY = frame.y + 12;
            const destX = tile.x + Math.min(tile.w, frame.w) / 2;
            const destY = tile.y + 12;
            // AX setWindowFrame clamps negative X; drag the title bar first (re-verified focus above).
            await this.helper.desktopInput('drag', {
                path: [{ x: startX, y: startY }, { x: (startX + destX) / 2, y: (startY + destY) / 2 }, { x: destX, y: destY }],
            });
            await this.helper.setWindowFrame(w.pid, { x: tile.x, y: tile.y, w: tile.w, h: tile.h }, w.windowRef, w.windowId).catch(() => undefined);
            return this.tileFrame(botId);
        });
    }

    private async input(botId: string, human: boolean, op: () => Promise<unknown>) {
        if (human) {
            if (this.owners.control()?.botId !== botId) throw Error('Viewer input requires this session\'s takeover lease');
        } else this.owners.requireAgent(botId);
        return this.serial(async () => { await this.focusBound(botId); return op(); });
    }

    typeInTile(botId: string, text: string, human = false) {
        return this.input(botId, human, () => this.helper.desktopInput('type', { text }));
    }

    clickInTile(botId: string, x: number, y: number, human = false) {
        const g = this.toGlobal(botId, x, y);
        return this.input(botId, human, () => this.helper.desktopInput('click', { x: g.x, y: g.y }));
    }

    keyInTile(botId: string, keys: string[], human = false) {
        return this.input(botId, human, () => this.helper.desktopInput('key', { keys }));
    }

    /** AX read of the bound window's text areas (no screenshot OCR). */
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

    /** Linux parity: per-session RFB endpoint on 127.0.0.1:(base+screen), view-only until takeover. */
    async openViewer(botId: string) {
        const b = this.owners.require(botId);
        const existing = this.viewers.get(botId);
        if (existing) return this.enrich(b).vnc!;
        const server = new RfbTileServer(this.vncBasePort + b.screen, `pi-bot ${botId}`, { width: b.width, height: b.height },
            () => this.captureTile(botId), {
                click: (x, y) => this.clickInTile(botId, x, y, true),
                type: text => this.typeInTile(botId, text, true),
                key: keys => this.keyInTile(botId, keys, true),
            });
        await server.listen();
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
export function cropFrame(img: { width: number; height: number; data: Uint8Array }, companion: HelperFrame, tile: HelperFrame): RgbaFrame {
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
export function readCompanionState(home = homedir()): MacosCompanionInfo | undefined {
    try {
        const raw = JSON.parse(readFileSync(join(stateDir(home), 'companion.json'), 'utf8'));
        if (raw?.displayID) return raw as MacosCompanionInfo;
    } catch { /* absent */ }
    return undefined;
}
