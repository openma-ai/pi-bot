import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createSandboxHost } from '../src/pi/sandbox.ts';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runCodingWorker } from '../src/pi/coding-worker.ts';
import { piSessionFactory } from '../src/pi/session-factory.ts';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';

function fixture(config: object = { enabled: true }) {
    const dir = mkdtempSync(join(tmpdir(), 'pi-sandbox-test-'));
    mkdirSync(join(dir, '.pi'));
    writeFileSync(join(dir, '.pi/sandbox.json'), JSON.stringify(config));
    const calls = { initialize: [] as any[], wrap: [] as string[], reset: 0 };
    const manager = {
        async initialize(config: any) { calls.initialize.push(config); },
        async wrapWithSandbox(command: string) { calls.wrap.push(command); return command; },
        async reset() { calls.reset++; },
    };
    return { dir, calls, manager };
}
async function load(host: ReturnType<typeof createSandboxHost>, cwd: string, background = false) {
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    const notices: string[] = [];
    const ctx: any = { cwd, ui: { notify: (s: string) => notices.push(s), setStatus() {}, theme: { fg: (_: string, s: string) => s } } };
    const session = host.forSession(cwd, background);
    await session.extension({
        registerFlag() {}, getFlag: () => false, registerCommand() {},
        on: (name: string, handler: Function) => handlers.set(name, handler),
        registerTool: (tool: any) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI);
    await handlers.get('session_start')!({}, ctx);
    return { ...session, handlers, tools, notices, ctx };
}
test('official extension wraps bash and user_bash with the session cwd, not daemon cwd', async () => {
    const { dir, calls, manager } = fixture();
    const host = createSandboxHost({ cwd: dir }, manager);
    const sessionDir = join(dir, 'child');
    mkdirSync(sessionDir);
    const session = await load(host, sessionDir);
    const result = await session.bash.execute('bash-1', { command: 'pwd' }, undefined, undefined, session.ctx);
    assert.ok(JSON.stringify(result).includes(sessionDir));
    assert.deepEqual(calls.wrap, ['pwd']);
    assert.ok(session.handlers.get('user_bash')!({}, session.ctx).operations);
    assert.equal(calls.initialize.length, 1);
    assert.deepEqual(calls.initialize[0].filesystem.allowWrite, [dir, '/tmp']);
    await host.dispose();
});
test('background wrapper gets the official tool, without an overriding duplicate registration', async () => {
    const { dir, calls, manager } = fixture();
    const host = createSandboxHost({ cwd: dir }, manager);
    const session = await load(host, dir, true);
    assert.equal(session.tools.size, 0);
    await session.bash.execute('bg', { command: 'printf wrapped' }, undefined, undefined, session.ctx);
    assert.deepEqual(calls.wrap, ['printf wrapped']);
    await host.dispose();
});
test('concurrent sessions and host reloads share initialization and do not reset live peers', async () => {
    const { dir, calls, manager } = fixture();
    const host = createSandboxHost({ cwd: dir }, manager);
    const next = createSandboxHost({ cwd: dir }, manager);
    const [a, b] = await Promise.all([load(host, dir), load(next, dir)]);
    assert.equal(calls.initialize.length, 1);
    await a.handlers.get('session_shutdown')!({}, a.ctx);
    await host.dispose();
    assert.equal(calls.reset, 0);
    await b.bash.execute('peer', { command: 'printf live' }, undefined, undefined, b.ctx);
    assert.deepEqual(calls.wrap, ['printf live']);
    await next.dispose();
    await next.dispose();
    assert.equal(calls.reset, 1);
});
test('official disabled and initialization-failure modes explicitly fall back to ordinary bash', async () => {
    for (const disabled of [true, false]) {
        const { dir, calls, manager } = fixture({ enabled: !disabled });
        if (!disabled) manager.initialize = async () => { throw Error('test dependency unavailable'); };
        const status: string[] = [];
        const host = createSandboxHost({ cwd: dir, onStatus: message => status.push(message) }, manager);
        const session = await load(host, dir);
        const result = await session.bash.execute('fallback', { command: 'printf fallback' }, undefined, undefined, session.ctx);
        assert.ok(JSON.stringify(result).includes('fallback'));
        assert.equal(calls.wrap.length, 0);
        assert.equal(session.handlers.get('user_bash')!({}, session.ctx), undefined);
        assert.ok(status.some(s => s.includes(disabled ? 'disabled' : 'initialization failed')));
        await host.dispose();
    }
});
test('a host acquired during final cleanup waits for reset before initializing', async () => {
    const { dir, calls, manager } = fixture();
    let release!: () => void;
    const resetting = new Promise<void>(resolve => { release = resolve; });
    manager.reset = async () => { calls.reset++; await resetting; };
    const first = createSandboxHost({ cwd: dir }, manager);
    await load(first, dir);
    const closing = first.dispose();
    await new Promise(resolve => setImmediate(resolve));
    const transient = createSandboxHost({ cwd: dir }, manager);
    const transientClosing = transient.dispose();
    const next = createSandboxHost({ cwd: dir }, manager);
    const loaded = load(next, dir);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.initialize.length, 1);
    release();
    await closing;
    await transientClosing;
    await loaded;
    assert.equal(calls.initialize.length, 2);
    const peer = createSandboxHost({ cwd: dir }, manager);
    await load(peer, dir);
    assert.equal(calls.initialize.length, 2);
    await next.dispose();
    assert.equal(calls.reset, 1);
    await peer.dispose();
    assert.equal(calls.reset, 2);
});
test('real Pi coding-worker extension loading routes bash through official wrapper', async () => {
    const { dir, calls, manager } = fixture();
    const sandbox = createSandboxHost({ cwd: dir }, manager);
    const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider();
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'printf child-sandbox' })),
        fauxAssistantMessage('done'),
    ]);
    models.registerNativeProvider(faux.provider);
    try {
        await runCodingWorker({ dir, modelRuntime: models, model: faux.getModel(), sandbox, assertCurrent() {} }, 'Run fixture', { taskId: 'test' });
        assert.equal(calls.initialize.length, 1);
        assert.deepEqual(calls.wrap, ['printf child-sandbox']);
        assert.equal(calls.reset, 0);
    } finally { await sandbox.dispose(); }
});
for (const toolName of ['bash', 'codemode']) test(`real Pi background ${toolName} remains sandboxed after background registration`, async () => {
    const { dir, calls, manager } = fixture();
    const sandbox = createSandboxHost({ cwd: dir }, manager);
    const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider();
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall(toolName, toolName === 'bash' ? { command: 'printf background-sandbox' } : { code: 'text(await tools.bash({ command: "printf background-sandbox" }));' })),
        ...Array(8).fill(fauxAssistantMessage('done')),
    ]);
    models.registerNativeProvider(faux.provider);
    const runtime = new BotRuntime(join(dir, 'test.db'), piSessionFactory({
        dir: join(dir, 'sessions'), modelRuntime: models, model: faux.getModel(), sandbox, backgroundTools: {},
    }));
    try {
        const bot = runtime.createBot('sandbox-test');
        runtime.accept({ to: bot.id, from: 'user', kind: 'user', text: 'Run fixture', key: 'fixture' });
        await runtime.idle();
        assert.deepEqual(calls.wrap, ['printf background-sandbox']);
        assert.deepEqual(runtime.errors, []);
    } finally { await runtime.close(); await sandbox.dispose(); }
});
