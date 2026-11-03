/**
 * macOS per-session desktop lifecycle mirroring Linux desktop-service + DesktopOwnership.
 *
 * Linux: one X11 :99, tiles of 1280×900, serial input, VNC clip per tile.
 * macOS: one CGVirtualDisplay companion (wide), tiles of TILE_W×TILE_H on that display,
 *        serial helper input (global cursor/focus — honest isolation gap vs Linux),
 *        viewer = per-tile screenshot stream (VNC unsupported).
 *
 * Concurrent extra CGVirtualDisplays often fail when Screen Sharing already occupies
 * virtual-display slots; tiling one companion matches the real Linux multi-bot model.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { DesktopOwnership, type DesktopBinding } from './desktop-ownership.ts';
import { MacosHelperClient, createSerialQueue, type HelperFrame, type HelperWindow } from './macos-helper-client.ts';

export const MACOS_TILE_WIDTH = 1280;
export const MACOS_TILE_HEIGHT = 800;
export const MACOS_VD_CAPACITY = 4;
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

export type MacosSessionBinding = DesktopBinding & {
    displayID: number;
    displayIndex: number;
    companionBounds: MacosDisplayBounds;
};

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
    owners = new DesktopOwnership(this.capacity);
    private child?: ChildProcessWithoutNullStreams;
    private companion?: MacosCompanionInfo;
    private displayIndex = -1;
    private starting?: Promise<MacosCompanionInfo>;
    private readonly serial = createSerialQueue();
    private readonly helper: MacosHelperClient;
    private stdoutBuf = '';

    constructor(
        public capacity = MACOS_VD_CAPACITY,
        readonly tileWidth = MACOS_TILE_WIDTH,
        readonly tileHeight = MACOS_TILE_HEIGHT,
        helper?: MacosHelperClient,
        readonly binaryPath = resolveMacosVirtualDisplayBinary(),
        private readonly home = homedir(),
    ) {
        this.helper = helper ?? new MacosHelperClient();
    }

    get status(): MacosVirtualDisplayStatus {
        const owned = !!this.child && !this.child.killed && this.child.exitCode == null;
        const adopted = !!this.companion && this.displayIndex >= 0 && !owned;
        const running = !!this.companion && (owned || adopted);
        return {
            running,
            companion: this.companion,
            binaryPath: this.binaryPath,
            pid: this.child?.pid,
            bindings: [...this.owners.bindings.values()].map(b => this.enrich(b)),
            reason: running
                ? (adopted
                    ? `Adopted orphan companion at index ${this.displayIndex} (${this.companion!.width}x${this.companion!.height}); hosts up to ${this.capacity} tiled sessions (logout clears orphan)`
                    : `Companion virtual display ${this.companion!.displayID} hosts up to ${this.capacity} tiled sessions`)
                : this.binaryPath
                    ? 'Companion virtual display is not running'
                    : 'pi-virtual-display-companion binary missing; run scripts/build-macos-virtual-display.sh',
        };
    }

    private enrich(b: DesktopBinding): MacosSessionBinding {
        return {
            ...b,
            displayID: this.companion?.displayID ?? 0,
            displayIndex: this.displayIndex,
            companionBounds: this.companion?.bounds ?? { x: 0, y: 0, w: 0, h: 0 },
        };
    }

    private companionPixelSize() {
        return { width: this.capacity * this.tileWidth, height: this.tileHeight };
    }

    /**
     * When CGVirtualDisplay create fails (Screen Sharing already consumed slots, or a prior
     * .permanently arrange left an orphan), adopt a matching online display by geometry.
     * Teardown cannot destroy an orphan we do not own — document that logout clears it.
     */
    async adoptExistingCompanion(): Promise<MacosCompanionInfo | undefined> {
        const { height } = this.companionPixelSize();
        try {
            const shot = await this.helper.captureDisplay(0, 64);
            // Prefer exact capacity width; else any non-main display whose width is N*tileWidth (N>=1)
            // and height matches — orphan keepers from earlier experiments may be smaller.
            const candidates = (shot.displays ?? []).filter(d => !d.isMain && d.frame && d.frame.h === height && d.frame.w >= this.tileWidth && d.frame.w % this.tileWidth === 0);
            if (!candidates.length) return undefined;
            const exact = candidates.find(d => d.frame!.w === this.capacity * this.tileWidth);
            const match = exact ?? candidates.sort((a, b) => b.frame!.w - a.frame!.w)[0];
            if (!match?.frame) return undefined;
            this.companion = {
                displayID: 0, // unknown without CGDirectDisplayID from helper; geometry is authoritative
                width: match.frame.w,
                height: match.frame.h,
                bounds: match.frame,
                online: true, active: true, main: false,
            };
            this.displayIndex = match.index;
            // Shrink usable tile capacity to what the adopted surface can host.
            const tilesFit = Math.max(1, Math.floor(match.frame.w / this.tileWidth));
            if (tilesFit < this.capacity) {
                this.capacity = tilesFit;
                if (this.owners.bindings.size === 0) {
                    this.owners = new DesktopOwnership(tilesFit);
                }
            }
            writeFileSync(join(stateDir(this.home), 'companion.json'), JSON.stringify({ ...this.companion, adopted: true, tilesFit, at: Date.now() }, null, 2));
            return this.companion;
        } catch {
            return undefined;
        }
    }

    async ensureCompanion(): Promise<MacosCompanionInfo> {
        if (this.companion && ((this.child && !this.child.killed && this.child.exitCode == null) || this.displayIndex >= 0)) return this.companion;
        if (this.starting) return this.starting;
        this.starting = (async () => {
            try {
                return await this.spawnCompanion();
            } catch (error: any) {
                const adopted = await this.adoptExistingCompanion();
                if (adopted) return adopted;
                throw error;
            }
        })().finally(() => { this.starting = undefined; });
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
        const match = displays.find(d => !d.isMain && d.frame?.w === this.companion?.bounds.w && d.frame?.h === this.companion?.bounds.h)
            ?? displays.find(d => !d.isMain && Math.abs((d.frame?.x ?? 0) - (this.companion?.bounds.x ?? 0)) < 2);
        if (!match) throw Object.assign(new Error('Companion display not visible to helper captureDisplay'), { code: 'ENOTFOUND' });
        this.displayIndex = match.index;
        if (this.companion && match.frame) this.companion.bounds = match.frame;
        return this.displayIndex;
    }

    async bind(botId: string, targetId = `macos:${botId}`, windowId = 0): Promise<MacosSessionBinding> {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(botId)) throw Error('Invalid bot ID');
        await this.ensureCompanion();
        await this.refreshDisplayIndex();
        if (this.owners.bindings.has(botId)) return this.enrich(this.owners.require(botId));
        // DesktopOwnership uses screen*1280 — override width/height to tile sizes after bind.
        const b = this.owners.bind(botId, targetId, windowId || (1000 + this.owners.bindings.size));
        b.width = this.tileWidth;
        b.height = this.tileHeight;
        // Place tile relative to companion origin (Linux places on :99 absolute coords).
        const cx = this.companion!.bounds.x;
        const cy = this.companion!.bounds.y;
        b.x = cx + b.screen * this.tileWidth;
        b.y = cy;
        writeFileSync(join(stateDir(this.home), 'bindings.json'), JSON.stringify([...this.owners.bindings.values()], null, 2));
        return this.enrich(b);
    }

    release(botId: string) {
        this.owners.bindings.delete(botId);
        this.owners.release(botId);
        writeFileSync(join(stateDir(this.home), 'bindings.json'), JSON.stringify([...this.owners.bindings.values()], null, 2));
        if (this.owners.bindings.size === 0) void this.shutdownCompanion();
    }

    async shutdownCompanion() {
        const child = this.child;
        const wasAdopted = !!this.companion && !child;
        this.child = undefined;
        this.companion = undefined;
        this.displayIndex = -1;
        if (!child || child.killed) {
            if (wasAdopted) {
                try { writeFileSync(join(stateDir(this.home), 'companion.json'), JSON.stringify({ stoppedAt: Date.now(), adoptedOrphanRemains: true, note: 'Logout/reboot clears a permanently arranged orphan VD' })); } catch { /* ignore */ }
            }
            return;
        }
        try { child.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`); } catch { /* ignore */ }
        await new Promise<void>(resolve => {
            const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } resolve(); }, 1500);
            child.once('exit', () => { clearTimeout(t); resolve(); });
        });
        try { writeFileSync(join(stateDir(this.home), 'companion.json'), JSON.stringify({ stoppedAt: Date.now() })); } catch { /* ignore */ }
    }

    /** Absolute tile frame in global macOS coordinates. */
    tileFrame(botId: string): HelperFrame {
        const b = this.owners.require(botId);
        return { x: b.x, y: b.y, w: b.width, h: b.height };
    }

    /** Map tile-local coords → global. */
    toGlobal(botId: string, x: number, y: number) {
        const t = this.tileFrame(botId);
        return { x: t.x + x, y: t.y + y };
    }

    async captureTile(botId: string, maxDimension = 1280) {
        this.owners.require(botId);
        if (this.displayIndex < 0) await this.refreshDisplayIndex();
        return this.serial(async () => {
            const shot = await this.helper.captureDisplay(this.displayIndex, Math.max(maxDimension, this.companionPixelSize().width));
            // Return full companion capture plus the bot's tile rect for clients to crop.
            return { ...shot, tile: this.tileFrame(botId), displayIndex: this.displayIndex, companion: this.companion };
        });
    }

    /**
     * Place a window into the bot's tile. AX setWindowFrame clamps negative X on some macOS
     * builds, so we drag via desktopInput (proven on botty) then resize.
     */
    async confineWindow(botId: string, pid: number, window: HelperWindow) {
        const tile = this.tileFrame(botId);
        return this.serial(async () => {
            const frame = window.framePoints ?? { x: 0, y: 0, w: 800, h: 600 };
            await this.helper.focusWindow(pid, window.windowRef, window.windowId);
            const startX = frame.x + frame.w / 2;
            const startY = frame.y + 12;
            const destX = tile.x + tile.w / 2;
            const destY = tile.y + 48;
            await this.helper.desktopInput('drag', {
                path: [
                    { x: startX, y: startY },
                    { x: (startX + destX) / 2, y: (startY + destY) / 2 },
                    { x: destX, y: destY },
                ],
            });
            await this.helper.setWindowFrame(pid, {
                x: tile.x + 20,
                y: tile.y + 40,
                w: Math.min(tile.w - 40, 1240),
                h: Math.min(tile.h - 60, 720),
            }, window.windowRef, window.windowId).catch(() => undefined);
            return this.tileFrame(botId);
        });
    }

    async typeInTile(botId: string, text: string) {
        this.owners.requireAgent(botId);
        return this.serial(async () => this.helper.desktopInput('type', { text }));
    }

    async clickInTile(botId: string, x: number, y: number) {
        this.owners.requireAgent(botId);
        const g = this.toGlobal(botId, x, y);
        return this.serial(async () => this.helper.desktopInput('click', { x: g.x, y: g.y }));
    }

    async keyInTile(botId: string, keys: string[]) {
        this.owners.requireAgent(botId);
        return this.serial(async () => this.helper.desktopInput('key', { keys }));
    }
}

/** Read last companion.json written by a live host (for probes without holding the child). */
export function readCompanionState(home = homedir()): MacosCompanionInfo | undefined {
    try {
        const raw = JSON.parse(readFileSync(join(stateDir(home), 'companion.json'), 'utf8'));
        if (raw?.displayID) return raw as MacosCompanionInfo;
    } catch { /* absent */ }
    return undefined;
}
