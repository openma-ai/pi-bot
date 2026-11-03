import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { MacosVirtualDisplayHost, FocusMismatchError, parseDesktopSize, cropFrame, stableDisplayIds, PIBOT_VENDOR_ID } from '../src/daemon/macos-virtual-display.ts';
import { MacVncServer, macVncServerArgs } from '../src/daemon/macos-vnc-server.ts';
import { PidInput } from '../src/daemon/macos-pid-input.ts';
import { createSerialQueue } from '../src/daemon/macos-helper-client.ts';

/** In-process fake of the Swift companion's JSON-lines protocol (one display per bot). */
function fakeCompanion(log: any[]) {
    let nextId = 40;
    const child: any = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.killed = false; child.pid = 4242;
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
    const held = new Map<string, any>();
    const out = (m: any) => child.stdout.write(JSON.stringify(m) + '\n');
    let buf = '';
    child.stdin.on('data', (c: Buffer) => {
        buf += String(c);
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
            const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); log.push(m);
            if (m.cmd === 'create') {
                const id = nextId++;
                const d = { displayID: id, width: m.width, height: m.height, vendor: m.vendor, product: m.product, serial: m.serial, bounds: { x: -m.width * (id - 39), y: 0, w: m.width, h: m.height } };
                held.set(m.bot, d); out({ ok: true, event: 'created', bot: m.bot, display: d });
            } else if (m.cmd === 'destroy') { const d = held.get(m.bot); held.delete(m.bot); out({ ok: true, event: 'destroyed', bot: m.bot, displayID: d?.displayID, released: true, gone: true }); }
            else if (m.cmd === 'shutdown') { out({ ok: true, event: 'shutdown' }); child.exitCode = 0; child.emit('exit', 0); }
        }
    });
    setImmediate(() => out({ ok: true, event: 'ready', pid: 4242 }));
    return { child, held };
}

function fakeHost(front: { pid: number; windowId: number }, cua: any = null) {
    const calls: string[] = [];
    const log: any[] = [];
    let comp: ReturnType<typeof fakeCompanion>;
    const helper = {
        captureDisplay: async () => ({ image: { jpegBase64: '', width: 1, height: 1 }, displays: [] }),
        focusWindow: async (pid: number, _ref: string, id: number) => { calls.push(`focus ${pid}/${id}`); },
        getFrontmost: async () => front,
        desktopInput: async (action: string, args: any) => { calls.push(`${action} ${JSON.stringify(args)}`); },
        setWindowFrame: async (pid: number, f: any) => { calls.push(`frame ${pid} ${JSON.stringify(f)}`); },
    } as any;
    const host = new MacosVirtualDisplayHost({
        capacity: 4, helper, binaryPath: '/tmp/fixture-bin', home: '/tmp/pi-bot-vd-test-home', defaultSize: { width: 1280, height: 800 }, vncBasePort: 15901,
        spawnCompanion: () => { comp = fakeCompanion(log); return comp.child; }, cua,
    });
    return { host, calls, log, held: () => comp.held };
}

test('stable display ids: deterministic per bot, unique, non-zero, fixed vendor', () => {
    const a = stableDisplayIds('bot-a'), a2 = stableDisplayIds('bot-a'), b = stableDisplayIds('bot-b');
    assert.deepEqual(a, a2);
    assert.notEqual(a.serial, b.serial);
    assert.notEqual(a.product, b.product);
    for (const ids of [a, b]) { assert.ok(ids.serial > 0 && ids.product > 0); assert.equal(ids.vendor, PIBOT_VENDOR_ID); }
    assert.notEqual(stableDisplayIds('bot-a', 1).serial, a.serial);
});

test('serial queue runs operations one at a time', async () => {
    const serial = createSerialQueue();
    const order: number[] = [];
    await Promise.all([
        serial(async () => { order.push(1); await new Promise(r => setTimeout(r, 20)); order.push(2); }),
        serial(async () => { order.push(3); order.push(4); }),
    ]);
    assert.deepEqual(order, [1, 2, 3, 4]);
});

test('host status reports missing binary without spawning', () => {
    const host = new MacosVirtualDisplayHost({ binaryPath: '/tmp/pi-bot-vd-missing-binary-fixture', cua: null });
    assert.equal(host.status.running, false);
    assert.match(host.status.reason, /not running|missing/i);
});

test('each bot gets its own display with its own size and stable ids; destroy releases only that bot', async () => {
    const { host, log, held } = fakeHost({ pid: 1, windowId: 1 });
    const a = await host.bind('bot-a');
    const b = await host.bind('bot-b', { size: '1600x900' });
    assert.equal(log.filter(m => m.cmd === 'create').length, 2, 'one companion, two creates');
    assert.notEqual(a.display!.displayID, b.display!.displayID);
    assert.deepEqual([a.width, a.height], [1280, 800]);
    assert.deepEqual([b.width, b.height], [1600, 900]);
    assert.equal(log[0].serial, stableDisplayIds('bot-a').serial);
    assert.equal(log[1].serial, stableDisplayIds('bot-b').serial);
    assert.equal(held().size, 2, 'both alive at once');
    assert.throws(() => host.toGlobal('bot-a', 1280, 10), /outside/);
    assert.deepEqual(host.toGlobal('bot-b', 1599, 899), { x: b.display!.bounds.x + 1599, y: 899 });
    const r = await host.release('bot-a');
    assert.equal(r.event, 'destroyed');
    assert.deepEqual([...held().keys()], ['bot-b']);
    assert.equal(host.status.running, true, 'companion stays alive for remaining bots');
    await host.shutdownCompanion();
    assert.throws(() => parseDesktopSize('5000x900', { width: 1, height: 1 }), /outside/);
    assert.throws(() => parseDesktopSize('big', { width: 1, height: 1 }), /Invalid/);
});

test('agent input goes per-pid via cua-driver background delivery and never touches global HID', async () => {
    const cuaCalls: any[] = [];
    const { host, calls } = fakeHost({ pid: 50, windowId: 999 }, async (tool: string, args: any) => { cuaCalls.push([tool, args]); return { ok: true }; });
    await host.bind('bot-a');
    host.bindWindow('bot-a', { pid: 50, windowId: 7, windowRef: 'w-7' });
    await host.confineWindow('bot-a');
    await host.typeInTile('bot-a', 'MARKER');
    await host.clickInTile('bot-a', 10, 20);
    await host.keyInTile('bot-a', ['cmd', 'down']);
    assert.deepEqual(cuaCalls.map(c => c[0]), ['type_text', 'click', 'hotkey']);
    assert.ok(cuaCalls.every(c => c[1].pid === 50 && c[1].window_id === 7 && c[1].delivery_mode === 'background'));
    assert.deepEqual([cuaCalls[1][1].x, cuaCalls[1][1].y], [10, 20], 'window-local coordinates');
    assert.ok(!calls.some(c => /^(type|click|key|focus)/.test(c)), 'no focus steal / global input on the per-pid path');
    assert.equal(host.lastInput?.rung, 'cua-background');
    await host.shutdownCompanion();
});

test('global HID fallback is aborted unless the frontmost window is the bound window', async () => {
    const { host, calls } = fakeHost({ pid: 50, windowId: 999 }, async () => ({ isError: true, error: 'background did not land' }));
    await host.bind('bot-a');
    host.bindWindow('bot-a', { pid: 50, windowId: 7, windowRef: 'w-7' });
    await assert.rejects(host.typeInTile('bot-a', 'MARKER'), (e: any) => e instanceof FocusMismatchError && /input aborted/.test(e.message));
    assert.ok(!calls.some(c => c.startsWith('type')), 'nothing typed when focus mismatched');
    await host.bind('bot-b');
    assert.throws(() => host.bindWindow('bot-b', { pid: 50, windowId: 7 }), /ownership conflict/);
    await host.shutdownCompanion();
});

test('global HID fallback runs only after focus verification succeeds; takeover gates human input', async () => {
    const { host, calls } = fakeHost({ pid: 50, windowId: 7 }, null);
    await host.bind('bot-a');
    host.bindWindow('bot-a', { pid: 50, windowId: 7, windowRef: 'w-7' });
    const r = await host.typeInTile('bot-a', 'MARKER');
    assert.equal(r.rung, 'global-hid');
    assert.deepEqual(calls, ['focus 50/7', 'type {"text":"MARKER"}']);
    host.takeover('bot-a');
    await assert.rejects(host.typeInTile('bot-a', 'x'), /takeover/);
    await host.typeInTile('bot-a', 'y', true);
    await host.shutdownCompanion();
});

test('PidInput maps single keys to press_key and chords to hotkey', async () => {
    const seen: any[] = [];
    const pi = new PidInput(async (tool, args) => { seen.push([tool, args]); return {}; }, async () => { throw Error('no global'); });
    await pi.key({ pid: 1, windowId: 2 }, ['return']);
    await pi.key({ pid: 1, windowId: 2 }, ['cmd', 's']);
    assert.deepEqual(seen.map(s => s[0]), ['press_key', 'hotkey']);
    assert.equal(seen[0][1].key, 'return');
    assert.deepEqual(seen[1][1].keys, ['cmd', 's']);
});

test('per-bot VNC: mac-vnc-server pinned to the bot display id, localhost, view-only until takeover', async () => {
    const spawned: any[] = [];
    const created: MacVncServer[] = [];
    const { host } = fakeHost({ pid: 1, windowId: 1 });
    (host as any).opts.createVnc = (botId: string, displayID: number, port: number) => {
        const s = new MacVncServer(botId, displayID, port, '/bin/fake-vnc', '/tmp/pi-bot-vd-test-home/vnc',
            (bin, args, env) => { spawned.push({ bin, args, env }); const c: any = new EventEmitter(); c.exitCode = null; c.kill = () => { c.exitCode = 0; c.emit('exit', 0); return true; }; return c; },
            async () => ({ state: 'ready' }));
        created.push(s); return s;
    };
    const a = await host.bind('bot-a');
    const b = await host.bind('bot-b', { size: '1600x900' });
    const va = await host.openViewer('bot-a');
    const vb = await host.openViewer('bot-b');
    assert.deepEqual([va.port, vb.port], [15901, 15902]);
    assert.equal(va.viewOnly, true);
    assert.equal(spawned[0].env.MAC_VNC_DISPLAY_ID, String(a.display!.displayID));
    assert.equal(spawned[1].env.MAC_VNC_DISPLAY_ID, String(b.display!.displayID));
    assert.equal(spawned[0].env.MAC_VNC_VIEW_ONLY, '1');
    assert.deepEqual(spawned[0].args.slice(0, 5), ['run', '--bind', '127.0.0.1', '--port', '15901']);
    host.takeover('bot-b');
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(created[1].controlFile, 'utf8').trim(), 'interactive');
    assert.equal(readFileSync(created[0].controlFile, 'utf8').trim(), 'view-only');
    host.releaseControl('bot-b');
    assert.equal(readFileSync(created[1].controlFile, 'utf8').trim(), 'view-only');
    assert.deepEqual(host.vncPorts(), [15901, 15902]);
    await host.release('bot-a');
    assert.deepEqual(host.vncPorts(), [15902]);
    await host.shutdownCompanion();
    assert.deepEqual(macVncServerArgs(5901).slice(1, 3), ['--bind', '127.0.0.1']);
});

test('native probe canOpenView requires virtual-display binary when helper is ready', async () => {
    const { probeMacosNativeCapabilities } = await import('../src/daemon/macos-computer-use.ts');
    const discovery = { enabled: true, packageName: '@nredd/pi-computer-use', packageRoot: '/tmp/fixture', extensionPath: '/tmp/fixture/extensions/computer-use.ts', helperAppPath: '/tmp/fixture.app', helperExecutablePresent: true, reason: 'FIXTURE present' };
    const without = await probeMacosNativeCapabilities({ platform: 'darwin', discovery, checkPermissions: async () => ({ accessibility: true, screenRecording: true }), virtualDisplayBinaryPresent: false });
    assert.equal(without.canOpenView, false);
    assert.equal(without.vnc.state, 'unconfigured');
    const viewing = await probeMacosNativeCapabilities({ platform: 'darwin', discovery, checkPermissions: async () => ({ accessibility: true, screenRecording: true }), virtualDisplayBinaryPresent: true, vncPorts: () => [5901, 5902], vnc: async () => ({ state: 'ready', reason: 'FIXTURE', checkedAt: 0 }) });
    assert.equal(viewing.vnc.state, 'ready');
    assert.match(viewing.vnc.reason, /127\.0\.0\.1:5901, 127\.0\.0\.1:5902/);
});

test('cropFrame scales a capture down to the configured desktop size', () => {
    const img = { width: 20, height: 5, data: new Uint8Array(20 * 5 * 4).fill(200) };
    const out = cropFrame(img, { x: 0, y: 0, w: 40, h: 10 }, { x: 0, y: 0, w: 40, h: 10 });
    assert.equal(out.width, 40);
    assert.ok([...out.data].filter((_, i) => i % 4 === 0).every(v => v === 200));
});
