import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopOwnership } from '../src/daemon/desktop-ownership.ts';
import { MACOS_TILE_WIDTH, MACOS_TILE_HEIGHT, MACOS_VD_CAPACITY, MacosVirtualDisplayHost } from '../src/daemon/macos-virtual-display.ts';
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
    assert.equal(MACOS_VD_CAPACITY, 4);
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
    assert.match(without.vnc.reason, /screenshot|virtual-display|VNC/i);
    const withBin = await probeMacosNativeCapabilities({
        platform: 'darwin',
        discovery,
        checkPermissions: async () => ({ accessibility: true, screenRecording: true }),
        virtualDisplayBinaryPresent: true,
    });
    assert.equal(withBin.canOpenView, true);
    assert.match(withBin.vnc.reason, /screenshot stream|tiled/i);
});
