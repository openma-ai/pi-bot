/**
 * Real-machine e2e for per-bot macOS desktops. DO NOT RUN until the Mac's displays are healthy
 * (Screen Sharing reconnected). Run on the Mac with the pi-computer-use helper, the companion,
 * pi-mac-vnc-server and cua-driver installed and granted.
 *
 * Covers: two bots with different stable serials and sizes alive at once; pre-existing
 * (Screen Sharing) displays still present; per-bot VNC capture with a real client (vncdotool);
 * per-pid input that does not move the real cursor; view-only vs takeover; destroy per bot.
 * Evidence: $OUT (default ~/pi-vd-evidence/run3). Docs: ~/pi-bot-vd-test (never ~/Documents).
 */
import { execFileSync, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { MacosVirtualDisplayHost, stableDisplayIds } from '../src/daemon/macos-virtual-display.ts';
import { MacosHelperClient } from '../src/daemon/macos-helper-client.ts';
import { probeMacosNativeCapabilities } from '../src/daemon/macos-computer-use.ts';

const home = homedir();
const OUT = process.env.OUT ?? join(home, 'pi-vd-evidence', 'run3');
const DOCS = join(home, 'pi-bot-vd-test');
const VNCDO = process.env.VNCDO ?? join(DOCS, 'venv', 'bin', 'vncdo');
mkdirSync(OUT, { recursive: true });
mkdirSync(DOCS, { recursive: true });
const log: any[] = [];
const step = (name: string, data: any = {}) => { const e = { t: new Date().toISOString(), name, ...data }; log.push(e); console.log(JSON.stringify(e)); writeFileSync(join(OUT, 'e2e-log.json'), JSON.stringify(log, null, 2)); };
const check = (name: string, ok: boolean, data: any = {}) => { step(`check:${name}`, { ok, ...data }); if (!ok) failed = true; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sh = (cmd: string, args: string[]) => new Promise<string>((res, rej) => execFile(cmd, args, { timeout: 30000 }, (e, o, se) => e ? rej(Object.assign(e, { stderr: se })) : res(o)));
/** Online displays as {id, w, h, main}. */
const displays = () => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e',
    'ObjC.import("AppKit");JSON.stringify(ObjC.unwrap($.NSScreen.screens).map(s=>({id:ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber")),w:s.frame.size.width,h:s.frame.size.height,name:ObjC.unwrap(s.localizedName)})))']).toString());
const cursor = () => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e',
    'ObjC.import("CoreGraphics");var p=$.CGEventGetLocation($.CGEventCreate(null));JSON.stringify({x:p.x,y:p.y})']).toString());

const helper = new MacosHelperClient();
const host = new MacosVirtualDisplayHost({ capacity: 4, helper, home, defaultSize: { width: 1280, height: 800 } });
const BOTS = ['bot-a', 'bot-b'] as const;
const SIZES: Record<string, string | undefined> = { 'bot-a': undefined, 'bot-b': '1600x900' };
const stamp = Date.now();
const MARK: Record<string, string> = { 'bot-a': `RUN3_A_${stamp}`, 'bot-b': `RUN3_B_${stamp}` };
const textEditWasRunning = (() => { try { execFileSync('pgrep', ['-x', 'TextEdit']); return true; } catch { return false; } })();
let failed = false;
const before = displays();

try {
    step('displays-before', { displays: before });
    if (textEditWasRunning) throw Error('TextEdit already running; quit it first so only our windows are touched');

    // 1. Two bots, two displays, both alive, distinct stable serials and sizes.
    const bound: any = {};
    for (const bot of BOTS) {
        bound[bot] = await host.bind(bot, { size: SIZES[bot] });
        step('bind', { bot, display: bound[bot].display, width: bound[bot].width, height: bound[bot].height });
    }
    const mid = displays();
    step('displays-both-alive', { displays: mid, status: host.status });
    const da = bound['bot-a'].display, db = bound['bot-b'].display;
    check('distinct-display-ids', da.displayID !== db.displayID, { a: da.displayID, b: db.displayID });
    check('stable-serials', da.serial === stableDisplayIds('bot-a').serial && db.serial === stableDisplayIds('bot-b').serial && da.serial !== db.serial, { a: da.serial, b: db.serial });
    check('sizes', da.width === 1280 && da.height === 800 && db.width === 1600 && db.height === 900);
    check('both-online', [da.displayID, db.displayID].every(id => mid.some((d: any) => d.id === id)));
    check('pre-existing-displays-kept', before.every((d: any) => mid.some((m: any) => m.id === d.id)), { before: before.map((d: any) => d.id), mid: mid.map((d: any) => d.id) });

    // 2. One TextEdit doc per bot, exact window bind, move it onto its bot's display.
    for (const bot of BOTS) writeFileSync(join(DOCS, `${bot}.txt`), `${bot} session\n`);
    for (const bot of BOTS) { execFileSync('open', ['-a', 'TextEdit', join(DOCS, `${bot}.txt`)]); await sleep(1500); }
    const pid = Number(execFileSync('pgrep', ['-x', 'TextEdit']).toString().trim().split('\n')[0]);
    const raw: any = await helper.listWindows(pid);
    const windows: any[] = Array.isArray(raw) ? raw : raw.windows;
    for (const bot of BOTS) {
        const m = windows.filter(w => w.title === `${bot}.txt`);
        if (m.length !== 1) throw Error(`expected exactly one ${bot}.txt window, found ${m.length}`);
        host.bindWindow(bot, { pid, windowId: m[0].windowId, windowRef: m[0].windowRef, title: m[0].title });
        await host.confineWindow(bot);
    }
    const after: any = await helper.listWindows(pid);
    step('window-frames', { windows: (Array.isArray(after) ? after : after.windows).map((w: any) => ({ id: w.windowId, title: w.title, frame: w.framePoints })), tiles: Object.fromEntries(BOTS.map(b => [b, host.tileFrame(b)])) });

    // 3. Per-pid input; the real cursor must not move and nothing else may be typed into.
    const c0 = cursor();
    for (const bot of ['bot-a', 'bot-b', 'bot-a']) {
        await host.clickInTile(bot, 200, 200);
        await host.typeInTile(bot, ` ${MARK[bot]}`);
        step('typed', { bot, rung: host.lastInput?.rung, error: host.lastInput?.error });
        check(`per-pid-rung-${bot}`, host.lastInput?.rung === 'cua-background', { rung: host.lastInput?.rung });
    }
    const c1 = cursor();
    check('cursor-not-moved', Math.abs(c0.x - c1.x) < 1 && Math.abs(c0.y - c1.y) < 1, { c0, c1 });
    const ax: Record<string, string> = {};
    for (const bot of BOTS) ax[bot] = (await host.readWindowText(bot)).join('');
    writeFileSync(join(OUT, 'ax-read.json'), JSON.stringify(ax, null, 2));
    check('ax-isolation', ax['bot-a'].includes(MARK['bot-a']) && !ax['bot-a'].includes(MARK['bot-b']) && ax['bot-b'].includes(MARK['bot-b']) && !ax['bot-b'].includes(MARK['bot-a']), { ax });

    // 4. Screenshots follow each bot's size.
    for (const bot of BOTS) {
        const f = await host.captureTile(bot);
        writeFileSync(join(OUT, `display-${bot}.jpg`), jpeg.encode({ width: f.width, height: f.height, data: Buffer.from(f.data) }, 85).data);
        check(`screenshot-size-${bot}`, f.width === host.tileFrame(bot).w && f.height === host.tileFrame(bot).h, { w: f.width, h: f.height });
    }

    // 5. Per-bot VNC (mac-vnc-server pinned to each display id), real client capture.
    const vnc: any = {};
    for (const bot of BOTS) vnc[bot] = await host.openViewer(bot);
    const caps = await probeMacosNativeCapabilities({ platform: 'darwin', virtualDisplayBinaryPresent: true, vncPorts: () => host.vncPorts() });
    step('vnc-open', { vnc, capability: caps.vnc });
    check('vnc-ready', caps.vnc.state === 'ready');
    check('vnc-localhost-only', BOTS.every(b => !execFileSync('lsof', ['-nP', `-iTCP:${vnc[b].port}`, '-sTCP:LISTEN']).toString().split('\n').slice(1).some(l => l && !l.includes('127.0.0.1'))));
    for (const bot of BOTS) {
        const file = join(OUT, `vnc-${bot}.png`);
        await sh(VNCDO, ['-s', `127.0.0.1::${vnc[bot].port}`, 'capture', file]);
        const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString();
        const w = Number(/pixelWidth: (\d+)/.exec(dims)?.[1]), h = Number(/pixelHeight: (\d+)/.exec(dims)?.[1]);
        check(`vnc-capture-size-${bot}`, w === host.tileFrame(bot).w && h === host.tileFrame(bot).h, { w, h, file });
    }
    // View-only drops input; takeover makes only bot-b interactive (global HID by the VNC server).
    await sh(VNCDO, ['-s', `127.0.0.1::${vnc['bot-b'].port}`, 'type', 'VIEWONLY']);
    host.takeover('bot-b');
    await sh(VNCDO, ['-s', `127.0.0.1::${vnc['bot-b'].port}`, 'move', '300', '300', 'click', '1', 'type', 'VNCIN']);
    await sleep(1500);
    host.releaseControl('bot-b');
    const axV = { a: (await host.readWindowText('bot-a')).join(''), b: (await host.readWindowText('bot-b')).join('') };
    check('vnc-view-only', !axV.b.includes('VIEWONLY') && !axV.a.includes('VIEWONLY'));
    check('vnc-takeover', axV.b.includes('VNCIN') && !axV.a.includes('VNCIN'), { axV });
    check('pre-existing-displays-kept-after-input', before.every((d: any) => displays().some((m: any) => m.id === d.id)));

    // 6. Destroy bot-a only; bot-b stays; then destroy bot-b.
    const ra = await host.release('bot-a');
    await sleep(1000);
    const afterA = displays();
    step('release-a', { result: ra, displays: afterA });
    check('bot-b-survives-a-destroy', afterA.some((d: any) => d.id === db.displayID));
    check('bot-a-gone', !afterA.some((d: any) => d.id === da.displayID), { note: 'macOS 27.2 may keep a released display listed until the next create; record either way' });
    const rb = await host.release('bot-b');
    await sleep(1000);
    step('release-b', { result: rb, displays: displays() });
} catch (error: any) {
    failed = true;
    step('error', { message: error?.message, code: error?.code, stack: error?.stack?.split('\n').slice(0, 4) });
} finally {
    for (const bot of BOTS) { try { await host.release(bot); } catch { /* not bound */ } }
    await host.shutdownCompanion();
    await sleep(1000);
    const end = displays();
    step('end', { displays: end, preExistingKept: before.every((d: any) => end.some((m: any) => m.id === d.id)) });
    if (!textEditWasRunning) { try { execFileSync('pkill', ['-x', 'TextEdit']); } catch { /* none */ } }
    step('done', { failed, out: OUT, exists: existsSync(OUT) });
    process.exit(failed ? 1 : 0);
}
