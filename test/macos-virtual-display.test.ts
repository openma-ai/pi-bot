import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopOwnership } from '../src/daemon/desktop-ownership.ts';
import { MACOS_TILE_WIDTH, MACOS_TILE_HEIGHT, MACOS_VD_CAPACITY, MacosVirtualDisplayHost, FocusMismatchError, parseDesktopSize, cropFrame } from '../src/daemon/macos-virtual-display.ts';
import { RfbTileServer } from '../src/daemon/rfb-tile-server.ts';
import { probeVnc } from '../src/daemon/desktop-capabilities.ts';
import { createSerialQueue } from '../src/daemon/macos-helper-client.ts';

test('macOS tile geometry mirrors Linux screen*1280 ownership layout', () => {
    const owners = new DesktopOwnership(MACOS_VD_CAPACITY);
    const a = owners.bind('bot-a', 'macos:bot-a', 1000);
    const b = owners.bind('bot-b', 'macos:bot-b', 1001);
    assert.equal(a.screen, 0);
    assert.equal(b.screen, 1);
    assert.equal(a.x, 0);
    assert.equal(b.x, MACOS_TILE_WIDTH);
    assert.equal(a.width, 1280);
    assert.equal(MACOS_TILE_HEIGHT, 800);
    assert.equal(MACOS_VD_CAPACITY, 2);
    assert.throws(() => owners.bind('bot-a', 'x', 9), /already bound/);
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
    const host = new MacosVirtualDisplayHost(4, 1280, 800, undefined, '/tmp/pi-bot-vd-missing-binary-fixture');
    assert.equal(host.status.running, false);
    assert.match(host.status.reason, /not running|missing/i);
    assert.equal(host.binaryPath, '/tmp/pi-bot-vd-missing-binary-fixture');
});

test('native probe canOpenView requires virtual-display binary when helper is ready', async () => {
    const { probeMacosNativeCapabilities } = await import('../src/daemon/macos-computer-use.ts');
    const discovery = {
        enabled: true,
        packageName: '@nredd/pi-computer-use',
        packageRoot: '/tmp/fixture',
        extensionPath: '/tmp/fixture/extensions/computer-use.ts',
        helperAppPath: '/tmp/fixture.app',
        helperExecutablePresent: true,
        reason: 'FIXTURE present',
    };
    const without = await probeMacosNativeCapabilities({
        platform: 'darwin',
        discovery,
        checkPermissions: async () => ({ accessibility: true, screenRecording: true }),
        virtualDisplayBinaryPresent: false,
    });
    assert.equal(without.computerUse.state, 'ready');
    assert.equal(without.canOpenView, false);
    assert.equal(without.vnc.state, 'unconfigured');
    const withBin = await probeMacosNativeCapabilities({
        platform: 'darwin',
        discovery,
        checkPermissions: async () => ({ accessibility: true, screenRecording: true }),
        virtualDisplayBinaryPresent: true,
    });
    assert.equal(withBin.canOpenView, true);
    assert.equal(withBin.vnc.state, 'unconfigured');
    const viewing = await probeMacosNativeCapabilities({ platform: 'darwin', discovery, checkPermissions: async () => ({ accessibility: true, screenRecording: true }), virtualDisplayBinaryPresent: true, vncPorts: () => [5901, 5902], vnc: async () => ({ state: 'ready', reason: 'FIXTURE', checkedAt: 0 }) });
    assert.equal(viewing.vnc.state, 'ready');
    assert.match(viewing.vnc.reason, /127\.0\.0\.1:5901, 127\.0\.0\.1:5902/);
});


function fakeHost(front: { pid: number; windowId: number }) {
    const calls: string[] = [];
    const helper = {
        captureDisplay: async () => ({ image: { jpegBase64: '', width: 1, height: 1 }, displays: [{ index: 1, isMain: false, frame: { x: -3840, y: 0, w: 3840, h: 1080 } }] }),
        focusWindow: async (pid: number, _ref: string, id: number) => { calls.push(`focus ${pid}/${id}`); },
        getFrontmost: async () => front,
        desktopInput: async (action: string, args: any) => { calls.push(`${action} ${JSON.stringify(args)}`); },
    } as any;
    const host = new MacosVirtualDisplayHost(2, 1920, 1080, helper, '/tmp/fixture-bin', '/tmp/pi-bot-vd-test-home', { width: 1280, height: 800 }, 15901);
    (host as any).companion = { displayID: 42, width: 3840, height: 1080, bounds: { x: -3840, y: 0, w: 3840, h: 1080 } };
    (host as any).child = { killed: false, exitCode: null };
    return { host, calls };
}

test('per-session desktop sizes: default from config, override per bind, slots never overlap', async () => {
    const { host } = fakeHost({ pid: 1, windowId: 1 });
    const a = await host.bind('bot-a');
    const b = await host.bind('bot-b', { size: '1600x900' });
    assert.deepEqual([a.width, a.height, a.x], [1280, 800, -3840]);
    assert.deepEqual([b.width, b.height, b.x], [1600, 900, -3840 + 1920]);
    assert.throws(() => host.toGlobal('bot-a', 1280, 10), /outside/);
    assert.deepEqual(host.toGlobal('bot-b', 1599, 899), { x: -3840 + 1920 + 1599, y: 899 });
    assert.throws(() => parseDesktopSize('4000x900', { width: 1, height: 1 }), /exceeds slot/);
    assert.throws(() => parseDesktopSize('big', { width: 1, height: 1 }), /Invalid/);
});

test('input is aborted unless the frontmost window is the bound window', async () => {
    const { host, calls } = fakeHost({ pid: 50, windowId: 999 });
    await host.bind('bot-a');
    host.bindWindow('bot-a', { pid: 50, windowId: 7, windowRef: 'w-7' });
    await assert.rejects(host.typeInTile('bot-a', 'MARKER'), (e: any) => e instanceof FocusMismatchError && /input aborted/.test(e.message));
    assert.ok(!calls.some(c => c.startsWith('type')), 'nothing typed when focus mismatched');
    await host.bind('bot-b');
    assert.throws(() => host.bindWindow('bot-b', { pid: 50, windowId: 7 }), /ownership conflict/);
});

test('input reaches the helper only after focus verification succeeds', async () => {
    const { host, calls } = fakeHost({ pid: 50, windowId: 7 });
    await host.bind('bot-a');
    host.bindWindow('bot-a', { pid: 50, windowId: 7, windowRef: 'w-7' });
    await host.typeInTile('bot-a', 'MARKER');
    assert.deepEqual(calls, ['focus 50/7', 'type {"text":"MARKER"}']);
    host.takeover('bot-a');
    await assert.rejects(host.typeInTile('bot-a', 'x'), /takeover/);
    await host.typeInTile('bot-a', 'y', true);
});

test('cropFrame returns only the tile pixels from a scaled companion capture', () => {
    const companion = { x: -40, y: 0, w: 40, h: 10 };
    const img = { width: 20, height: 5, data: new Uint8Array(20 * 5 * 4) };
    for (let x = 10; x < 20; x++) for (let y = 0; y < 5; y++) img.data[(y * 20 + x) * 4] = 200; // right half red
    const right = cropFrame(img, companion, { x: -20, y: 0, w: 20, h: 10 });
    assert.equal(right.width, 20);
    assert.ok([...right.data].filter((_, i) => i % 4 === 0).every(v => v === 200));
    const left = cropFrame(img, companion, { x: -40, y: 0, w: 20, h: 10 });
    assert.ok([...left.data].filter((_, i) => i % 4 === 0).every(v => v === 0));
});

test('RFB tile server completes the Linux probeVnc handshake on localhost', async () => {
    const server = new RfbTileServer(15999, 'fixture', { width: 64, height: 32 }, async () => ({ width: 64, height: 32, data: new Uint8Array(64 * 32 * 4) }));
    await server.listen();
    try {
        const cap = await probeVnc(15999, 1500);
        assert.equal(cap.state, 'ready');
        assert.equal(server.endpoint, 'vnc://127.0.0.1:15999');
    } finally { await server.close(); }
});
