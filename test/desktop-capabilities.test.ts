import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capability, unconfiguredDesktopCapabilities, unavailableDesktopCapabilities, type DesktopCapabilities } from '../src/pi/desktop-capabilities.ts';
import { computerDoctorCapability, probeDesktopCapabilities, probeVnc, type DesktopProbeDependencies } from '../src/daemon/desktop-capabilities.ts';
import { DesktopClient, createDesktopExtension } from '../src/pi/desktop-client.ts';
import { PiBotDaemon } from '../src/daemon/core/daemon.ts';
import { PiBotClient } from '../src/sdk/client.ts';
import { applyEvent, stateFromSnapshot } from '../src/sdk/state/reducer.ts';

const doctor = { readiness: { can_query_windows: true, can_focus_windows: true, can_send_development_input: true, can_build_accessibility_tree: true, can_capture_screenshots: false, screenshot_capture_status: 'unverified' } };
const dependencies = (patch: Partial<DesktopProbeDependencies> = {}): DesktopProbeDependencies => ({
    platform: 'linux', doctor: async () => doctor, cdp: async () => ({ product: 'Chromium/FIXTURE' }), capture: async () => true, viewer: async () => true, input: async () => true, vncPorts: () => [], ...patch
});
const ready = async () => probeDesktopCapabilities(dependencies());

test('configuration and doctor route discovery alone never establish screenshot or VNC readiness', async () => {
    const report = await probeDesktopCapabilities(dependencies({ capture: async () => false }));
    assert.equal(report.computerUse.state, 'ready');
    assert.equal(report.screenCapture.state, 'unknown');
    assert.equal(report.vnc.state, 'unconfigured');
    assert.equal(report.canOpenView, false);
    assert.ok(!report.availableTools.computer.includes('screenshot'));
    assert.ok(!report.availableTools.computer.includes('get_app_state'));
    assert.ok(report.availableTools.computer.includes('click'));
    assert.deepEqual(report.availableTools.browser, ['navigate', 'evaluate', 'screenshot']);
    const absent = unconfiguredDesktopCapabilities('darwin');
    assert.equal(absent.computerUse.state, 'unsupported');
    assert.equal(absent.screenCapture.state, 'unknown');
    assert.equal(absent.canOpenView, false);
    assert.match(absent.screenCapture.reason, /have not been probed/);
});

test('doctor requires positive operation evidence and distinguishes denial, missing setup and unknown', () => {
    assert.equal(computerDoctorCapability({}).state, 'unknown');
    assert.equal(computerDoctorCapability({ readiness: { can_register_mcp_tools: true } }).state, 'unknown');
    assert.equal(computerDoctorCapability({ readiness: { ...doctor.readiness, can_send_development_input: false } }).state, 'unconfigured');
    assert.equal(computerDoctorCapability({ readiness: { ...doctor.readiness, can_query_windows: false } }).state, 'unreachable');
    const denied = computerDoctorCapability({ readiness: { ...doctor.readiness, can_send_development_input: false }, input: { uinput: { ok: false, detail: 'Permission denied at PRIVATE_PATH' } } });
    assert.equal(denied.state, 'permission-required');
    assert.ok(!JSON.stringify(denied).includes('PRIVATE_PATH'));
});

test('pixel-only desktops expose verified coordinate tools without advertising semantic accessibility', async () => {
    const report = await probeDesktopCapabilities(dependencies({ doctor: async () => ({ readiness: { ...doctor.readiness, can_build_accessibility_tree: false } }) }));
    assert.equal(report.computerUse.state, 'ready');
    assert.match(report.computerUse.reason, /semantic tools are unavailable/);
    assert.ok(report.availableTools.computer.includes('click'));
    assert.ok(report.availableTools.computer.includes('screenshot'));
    assert.ok(!report.availableTools.computer.includes('set_value'));
    assert.ok(!report.availableTools.computer.includes('perform_action'));
    assert.ok(!report.availableTools.computer.includes('get_app_state'));
    const client = new DesktopClient('http://127.0.0.1:1', 'FIXTURE-NOT-A-CREDENTIAL');
    const paths: string[] = [];
    client.request = async path => { paths.push(path); return Response.json(report); };
    await assert.rejects(client.call('bot', { kind: 'computer', tool: 'click', args: { role: 'button', name: 'Save' } }), /Accessibility selectors are unavailable/);
    assert.deepEqual(paths, ['/capabilities']);
});

test('a positive doctor report cannot substitute for a live input/display handshake', async () => {
    const report = await probeDesktopCapabilities(dependencies({ input: async () => false }));
    assert.equal(report.computerUse.state, 'unreachable');
    assert.equal(report.canOpenView, false);
    assert.equal(report.screenCapture.state, 'ready');
    assert.deepEqual(report.availableTools.computer, []);
});

test('probe timeout is bounded, and VNC success does not imply Computer Use success', async () => {
    const started = Date.now();
    const report = await probeDesktopCapabilities(dependencies({ timeoutMs: 25, doctor: () => new Promise(() => {}), vncPorts: () => [5901], vnc: async () => capability('ready', 'FIXTURE RFB handshake') }));
    assert.ok(Date.now() - started < 500);
    assert.equal(report.computerUse.state, 'unreachable');
    assert.equal(report.vnc.state, 'ready');
    assert.deepEqual(report.availableTools.computer, []);
    assert.equal(report.browser.state, 'ready');
    const offPlatform = await probeDesktopCapabilities(dependencies({ platform: 'darwin', doctor: async () => { throw Error('must not run'); } }));
    assert.equal(offPlatform.computerUse.state, 'unsupported');
    assert.equal(offPlatform.screenCapture.state, 'unknown');
});

test('client shares one probe across calls, publishes failure/recovery, and does not bind during detection', async () => {
    const client = new DesktopClient('http://127.0.0.1:1', 'FIXTURE-NOT-A-CREDENTIAL');
    const available = await ready();
    const observations: string[] = [], requests: string[] = [];
    let fail = false;
    client.request = async path => {
        requests.push(path);
        if (fail) throw Error('FIXTURE disconnected');
        await new Promise(resolve => setTimeout(resolve, 5));
        return Response.json(available);
    };
    client.startMonitoring(value => observations.push(value.browser.state));
    try {
        const [a, b] = await Promise.all([client.capabilities(), client.capabilities()]);
        assert.equal(a, b); assert.equal(requests.length, 1);
        fail = true;
        assert.equal((await client.capabilities(undefined, true)).browser.state, 'unreachable');
        fail = false;
        assert.equal((await client.capabilities(undefined, true)).browser.state, 'ready');
        assert.deepEqual(observations, ['ready', 'unreachable', 'ready']);
        assert.ok(requests.every(path => path === '/capabilities'));
    } finally { client.close(); }
});

test('missing/old capability endpoint is unknown and does not expose configured tools', async () => {
    const client = new DesktopClient('http://127.0.0.1:1', 'FIXTURE-NOT-A-CREDENTIAL');
    client.request = async () => Response.json({ connected: true });
    assert.equal((await client.capabilities()).computerUse.state, 'unknown');
    await assert.rejects(client.call('bot', { kind: 'computer', tool: 'click', args: {} }), /unknown/);
    client.request = async () => { throw Object.assign(Error('FIXTURE'), { status: 403 }); };
    assert.equal((await client.capabilities(undefined, true)).computerUse.state, 'permission-required');
});

test('agent receives the same unavailable reason and never binds or sends input while unavailable', async () => {
    const client = new DesktopClient('http://127.0.0.1:1', 'FIXTURE-NOT-A-CREDENTIAL');
    const unavailable = unavailableDesktopCapabilities('linux', true, 'permission-required', 'FIXTURE accessibility denied');
    const paths: string[] = [];
    client.request = async path => { paths.push(path); return Response.json(unavailable); };
    const tools: any[] = [];
    createDesktopExtension(client, 'bot')({ registerTool: (tool: any) => tools.push(tool) } as any);
    const result = await tools.find(tool => tool.name === 'desktop_list').execute('read', {});
    assert.equal(JSON.parse(result.content[0].text).capabilities.computerUse.reason, unavailable.computerUse.reason);
    await assert.rejects(tools.find(tool => tool.name === 'desktop_call').execute('input', { kind: 'computer', tool: 'click', args: {} }), /permission-required: FIXTURE accessibility denied/);
    assert.ok(paths.every(path => path === '/capabilities'));
});

test('tool calls are filtered independently and a failed tool invalidates cached readiness', async () => {
    const client = new DesktopClient('http://127.0.0.1:1', 'FIXTURE-NOT-A-CREDENTIAL');
    let report = await ready();
    const paths: string[] = [];
    client.request = async path => {
        paths.push(path);
        if (path === '/capabilities') return Response.json(report);
        if (path === '/call') { report = unavailableDesktopCapabilities('linux', true, 'unreachable', 'FIXTURE runtime stopped'); return Response.json({ isError: true, content: [{ type: 'text', text: 'FIXTURE runtime stopped' }] }); }
        return Response.json({});
    };
    await assert.rejects(client.call('bot', { kind: 'computer', tool: 'unsupported_tool', args: {} }), /unavailable/);
    assert.equal(paths.includes('/bind'), false);
    const result = await client.call('bot', { kind: 'computer', tool: 'click', args: {} });
    assert.equal(result.isError, true);
    await client.capabilities(undefined, true);
    assert.equal(client.capabilitySnapshot.computerUse.state, 'unreachable');
    await assert.rejects(client.call('bot', { kind: 'computer', tool: 'click', args: {} }), /unreachable/);
    assert.equal(paths.filter(path => path === '/call').length, 1, 'failed input is never retried');
});

test('RFB probe requires a real protocol handshake and never sends pointer or keyboard input', async () => {
    const written: Buffer[] = [];
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer(socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        let phase = 0;
        socket.write('RFB 003.008\n');
        socket.on('data', data => {
            written.push(data);
            if (phase++ === 0) socket.write(Buffer.from([1, 1]));
            else if (phase === 2) socket.write(Buffer.alloc(4));
            else { const init = Buffer.alloc(24); init.writeUInt16BE(1280, 0); init.writeUInt16BE(900, 2); socket.write(init); }
        });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
        const state = await probeVnc((server.address() as any).port);
        assert.equal(state.state, 'ready');
        assert.deepEqual(Buffer.concat(written), Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]));
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('RFB authentication requirement and hung listener do not count as ready', async () => {
    let auth = true;
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); if (auth) { socket.write('RFB 003.008\n'); socket.once('data', () => socket.write(Buffer.from([1, 2]))); } });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
        const port = (server.address() as any).port;
        assert.equal((await probeVnc(port)).state, 'permission-required');
        auth = false;
        assert.equal((await probeVnc(port, 25)).state, 'unreachable');
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('isolated real harness exposes capabilities and rejects missing model without accepting silent work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pibo-capability-harness-'));
    const old = process.env.PI_BOT_DESKTOP_CONTROL;
    process.env.PI_BOT_DESKTOP_CONTROL = join(dir, 'absent-control.json');
    let daemon: PiBotDaemon | undefined, api: PiBotClient | undefined;
    try {
        daemon = await PiBotDaemon.create({ dataDir: join(dir, 'data'), piOptions: { cwd: dir, agentDir: join(dir, 'pi') } });
        api = await PiBotClient.connect({ transport: { inProcess: daemon } });
        const report = await api.desktop.capabilities({});
        assert.equal(report.configured, false);
        assert.equal(report.canOpenView, false);
        const { bot } = await api.bot.create({ name: 'ISOLATED NO MODEL' });
        await assert.rejects(api.turn.start({ botId: bot.id, text: 'DO NOT CALL A MODEL', key: 'no-model' }), (e: any) => e.reason === 'setupRequired' && /设置/.test(e.message));
        const snapshot = await api.daemon.snapshot({});
        assert.equal(snapshot.turns.length, 0);
        assert.equal(daemon.runtime.store.list('inbox').length, 0);
        const state = stateFromSnapshot(snapshot);
        assert.deepEqual(state.desktopCapabilities, report);
        const recovered: DesktopCapabilities = await ready();
        const next = applyEvent(state, { seq: state.seq + 1, at: Date.now(), method: 'desktop/capabilitiesChanged', params: { desktopCapabilities: recovered } });
        assert.deepEqual(next.desktopCapabilities, recovered);
        await assert.rejects(api.desktop.capabilities({ botId: 'missing' }), (e: any) => e.reason === 'notFound');
    } finally {
        api?.close(); await daemon?.close();
        if (old === undefined) delete process.env.PI_BOT_DESKTOP_CONTROL; else process.env.PI_BOT_DESKTOP_CONTROL = old;
        await rm(dir, { recursive: true, force: true });
    }
});

test('malformed control configuration does not crash the harness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pibo-bad-desktop-'));
    try { const path = join(dir, 'control.json'); await writeFile(path, '{'); assert.equal(DesktopClient.load(path), undefined); }
    finally { await rm(dir, { recursive: true, force: true }); }
});
