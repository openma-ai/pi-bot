/**
 * Real-machine e2e for the macOS virtual-display host (run on a Mac with the helper running).
 * Writes evidence to $OUT (default ~/pi-vd-evidence/run2). Test docs live in ~/pi-bot-vd-test
 * (never ~/Documents, so no TCC folder prompt). Only TextEdit windows opened here are touched.
 */
import { execFileSync, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { MacosVirtualDisplayHost } from '../src/daemon/macos-virtual-display.ts';
import { MacosHelperClient } from '../src/daemon/macos-helper-client.ts';
import { probeMacosNativeCapabilities } from '../src/daemon/macos-computer-use.ts';

const home = homedir();
const OUT = process.env.OUT ?? join(home, 'pi-vd-evidence', 'run2');
const DOCS = join(home, 'pi-bot-vd-test');
const VENV = process.env.VNCDO ?? join(DOCS, 'venv', 'bin', 'vncdo');
mkdirSync(OUT, { recursive: true });
const log: any[] = [];
const step = (name: string, data: any = {}) => { const e = { t: new Date().toISOString(), name, ...data }; log.push(e); console.log(JSON.stringify(e)); writeFileSync(join(OUT, 'e2e-log.json'), JSON.stringify(log, null, 2)); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const lsd = () => execFileSync(join(DOCS, 'lsd')).toString().trim().split('\n');
const sh = (cmd: string, args: string[]) => new Promise<string>((res, rej) => execFile(cmd, args, { timeout: 30000 }, (e, o, se) => e ? rej(Object.assign(e, { stderr: se })) : res(o)));

const helper = new MacosHelperClient();
const host = new MacosVirtualDisplayHost(2, 1920, 1080, helper, undefined, home, { width: 1280, height: 800 });
const stamp = Date.now();
const MARK = { 'bot-a': `RUN2_A_${stamp}`, 'bot-b': `RUN2_B_${stamp}` };
const SIZES: Record<string, string | undefined> = { 'bot-a': undefined, 'bot-b': '1600x900' };
const textEditWasRunning = (() => { try { execFileSync('pgrep', ['-x', 'TextEdit']); return true; } catch { return false; } })();
let failed = false;

try {
    step('displays-before', { displays: lsd() });
    for (const bot of ['bot-a', 'bot-b']) {
        const b = await host.bind(bot, { size: SIZES[bot] });
        step('bind', { bot, screen: b.screen, x: b.x, y: b.y, width: b.width, height: b.height, displayID: b.displayID, displayIndex: b.displayIndex, companionBounds: b.companionBounds });
    }
    step('displays-after-create', { displays: lsd(), companion: host.status.companion, pid: host.status.pid });

    // Open one fresh doc per bot (outside ~/Documents), then bind its exact window.
    for (const bot of ['bot-a', 'bot-b']) writeFileSync(join(DOCS, `${bot}.txt`), `${bot} session\n`);
    for (const bot of ['bot-a', 'bot-b']) { execFileSync('open', ['-a', 'TextEdit', join(DOCS, `${bot}.txt`)]); await sleep(1500); }
    const pid = Number(execFileSync('pgrep', ['-x', 'TextEdit']).toString().trim().split('\n')[0]);
    const raw: any = await helper.listWindows(pid);
    const windows: any[] = Array.isArray(raw) ? raw : raw.windows;
    for (const bot of ['bot-a', 'bot-b']) {
        const matches = windows.filter(w => w.title === `${bot}.txt`);
        if (matches.length !== 1) throw Error(`expected exactly one ${bot}.txt window, found ${matches.length}`);
        const w = matches[0];
        host.bindWindow(bot, { pid, windowId: w.windowId, windowRef: w.windowRef, title: w.title });
        await host.confineWindow(bot, w.framePoints);
        step('bind-window', { bot, pid, windowId: w.windowId, windowRef: w.windowRef, tile: host.tileFrame(bot) });
    }
    const after: any = await helper.listWindows(pid);
    step('window-frames', { windows: (Array.isArray(after) ? after : after.windows).map((w: any) => ({ id: w.windowId, title: w.title, frame: w.framePoints })) });

    // Distinct markers, interleaved, each gated on focused-window == bound window.
    for (const bot of ['bot-a', 'bot-b', 'bot-a']) {
        await host.keyInTile(bot, ['cmd', 'down']);
        await host.typeInTile(bot, ` ${MARK[bot as 'bot-a']}`);
        const front = await helper.getFrontmost();
        step('typed', { bot, marker: MARK[bot as 'bot-a'], frontmost: front });
    }

    // Screenshots: each tile (cropped), the full companion, and the main display.
    const shots: any = {};
    for (const bot of ['bot-a', 'bot-b']) {
        const f = await host.captureTile(bot);
        writeFileSync(join(OUT, `tile-${bot}.jpg`), jpeg.encode({ width: f.width, height: f.height, data: Buffer.from(f.data) }, 85).data);
        shots[bot] = { width: f.width, height: f.height, tile: f.tile };
    }
    const comp = await helper.captureDisplay(host.status.bindings[0].displayIndex, 3840);
    writeFileSync(join(OUT, 'companion-full.jpg'), Buffer.from(comp.image.jpegBase64, 'base64'));
    const main = await helper.captureDisplay(0, 1920);
    writeFileSync(join(OUT, 'main-display.jpg'), Buffer.from(main.image.jpegBase64, 'base64'));
    step('screenshots', { shots, companion: { w: comp.image.width, h: comp.image.height }, main: { w: main.image.width, h: main.image.height } });

    // AX read of each bound window.
    const ax: Record<string, string[]> = {};
    for (const bot of ['bot-a', 'bot-b']) ax[bot] = await host.readWindowText(bot);
    writeFileSync(join(OUT, 'ax-read.json'), JSON.stringify(ax, null, 2));
    const okA = ax['bot-a'].join('').includes(MARK['bot-a']) && !ax['bot-a'].join('').includes(MARK['bot-b']);
    const okB = ax['bot-b'].join('').includes(MARK['bot-b']) && !ax['bot-b'].join('').includes(MARK['bot-a']);
    step('ax-read', { ax, okA, okB });
    if (!okA || !okB) failed = true;

    // Per-session VNC: open, probe capability, capture with a real client.
    const vnc: any = {};
    for (const bot of ['bot-a', 'bot-b']) vnc[bot] = await host.openViewer(bot);
    const caps = await probeMacosNativeCapabilities({ platform: 'darwin', virtualDisplayBinaryPresent: true, vncPorts: () => host.vncPorts() });
    step('vnc-open', { vnc, capability: caps.vnc, canOpenView: caps.canOpenView });
    for (const bot of ['bot-a', 'bot-b']) {
        const file = join(OUT, `vnc-${bot}.png`);
        await sh(VENV, ['-s', `127.0.0.1::${vnc[bot].port}`, 'capture', file]);
        const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString();
        step('vnc-capture', { bot, file, dims: dims.replace(/\s+/g, ' ').trim() });
    }
    // View-only refuses input; takeover makes this session's endpoint interactive.
    await sh(VENV, ['-s', `127.0.0.1::${vnc['bot-b'].port}`, 'type', 'VIEWONLY']);
    host.takeover('bot-b');
    await sh(VENV, ['-s', `127.0.0.1::${vnc['bot-b'].port}`, 'type', 'VNCIN']);
    await sleep(1500);
    host.releaseControl('bot-b');
    const axAfterVnc = { 'bot-a': await host.readWindowText('bot-a'), 'bot-b': await host.readWindowText('bot-b') };
    writeFileSync(join(OUT, 'ax-read-after-vnc.json'), JSON.stringify(axAfterVnc, null, 2));
    step('vnc-input', { axAfterVnc, viewOnlyIgnored: !axAfterVnc['bot-b'].join('').includes('VIEWONLY'), takeoverTyped: axAfterVnc['bot-b'].join('').includes('VNCIN'), botAUntouched: !axAfterVnc['bot-a'].join('').includes('VNCIN') });
} catch (error: any) {
    failed = true;
    step('error', { message: error?.message, code: error?.code, stack: error?.stack?.split('\n').slice(0, 4) });
} finally {
    const display = host.status.companion?.displayID;
    for (const bot of ['bot-a', 'bot-b']) { try { await host.release(bot); } catch { /* not bound */ } }
    await sleep(1000);
    const list = lsd();
    step('released', { displayID: display, status: host.status, displays: list, companionListed: list.some(l => l.startsWith(`id=${display} `)) });
    if (!textEditWasRunning) { try { execFileSync('pkill', ['-x', 'TextEdit']); step('closed-own-textedit'); } catch { /* none */ } }
    step('done', { failed, out: OUT, exists: existsSync(OUT) });
    process.exit(failed ? 1 : 0);
}
