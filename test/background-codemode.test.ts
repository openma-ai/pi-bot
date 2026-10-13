import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import { createAgentSession, createBashTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ToolDefinition, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createBackgroundCodemodeExtension, type BackgroundCodemodeOptions } from '../src/pi/background-codemode.ts';
import { hasValidToolPairs } from '../src/pi/context.ts';
const deferred = <T = void>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => resolve = r);
    return {
        promise, resolve
    };
};
test('concurrent model-issued calls cannot race past the active execution cap', async () => {
    const finish = deferred();
    let executions = 0;
    const gate: ToolDefinition = {
        name: 'gate', label: 'Gate', description: 'Gate', parameters: Type.Object({}), async execute() {
            executions++;
            await finish.promise;
            return {
                content: [{
                        type: 'text', text: 'done'
                    }], details: {}
            };
        }
    };
    const h = await setup('', [gate], 40, {
        maxConcurrentCells: 1
    });
    h.session.agent.toolExecution = 'parallel';
    h.faux.setResponses([fauxAssistantMessage([fauxToolCall('codemode', {
                code: 'await tools.gate({});'
            }, {
                id: 'one'
            }), fauxToolCall('codemode', {
                code: 'await tools.gate({});'
            }, {
                id: 'two'
            })], {
            stopReason: 'toolUse'
        }), fauxAssistantMessage('internal')]);
    try {
        await h.session.prompt('parallel cells');
        const files = (await readdir(join(h.dir, 'cells', h.manager.getSessionId()))).filter(f => f.endsWith('.json'));
        assert.equal(files.length, 1);
        assert.ok(JSON.stringify(h.manager.buildSessionProjection().messages).includes('Concurrent codemode cell limit reached'));
        finish.resolve();
        assert.equal(await until(() => executions === 1), true);
    }
    finally {
        finish.resolve();
        await h.close();
    }
});
const until = async (check: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end)
            return false;
        await new Promise(r => setTimeout(r, 5));
    }
    return true;
};
async function setup(code: string, tools: ToolDefinition[] | ((dir: string) => ToolDefinition[]), waitMs = 10000, extra: Partial<BackgroundCodemodeOptions> = {}, hooks: ExtensionFactory[] = [], existing?: {
    dir: string;
    sessionFile: string;
}, adaptTools = false) {
    const root = resolve('work/background-codemode-tests');
    await mkdir(root, {
        recursive: true
    });
    const dir = existing?.dir ?? await mkdtemp(join(root, 'case-'));
    const definitions = typeof tools === 'function' ? tools(dir) : tools;
    const faux = fauxProvider({
        provider: `background-${Date.now()}-${Math.random()}`, models: [{
                id: 'test', contextWindow: 128000, maxTokens: 4096
            }], tokensPerSecond: 1000000
    });
    const contexts: unknown[] = [];
    faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode', {
            code
        }, {
            id: 'code-call'
        }), {
            stopReason: 'toolUse'
        }), ...Array.from({
            length: 20
        }, () => (ctx: any) => {
            contexts.push(ctx.messages);
            return fauxAssistantMessage('internal');
        })]);
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const settings = SettingsManager.inMemory({
        compaction: {
            enabled: false
        }, retry: {
            enabled: false
        }
    });
    const background = createBackgroundCodemodeExtension({
        directory: join(dir, 'cells'), yieldTimeMs: waitMs, ...extra, additionalTools: adaptTools ? definitions : []
    });
    const loader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => pi.registerProvider(faux.provider), background, ...hooks], systemPromptOverride: () => 'Use codemode and keep task correlation.'
    });
    await loader.reload();
    const manager = existing ? SessionManager.open(existing.sessionFile, dir, dir) : SessionManager.create(dir, dir);
    const { session } = await createAgentSession({
        cwd: dir, agentDir: dir, modelRuntime: models, model: faux.getModel(), settingsManager: settings, resourceLoader: loader, sessionManager: manager, noTools: 'builtin', customTools: adaptTools ? [] : definitions
    });
    session.setAutoCompactionEnabled(false);
    await session.bindExtensions({
        mode: 'json'
    });
    session.setActiveToolsByName(['codemode', 'codemode_wait', ...definitions.map(t => t.name)]);
    session.setSteeringMode('all');
    return {
        dir, session, manager, contexts, faux, background, async close() {
            await background.close();
            await session.waitForIdle();
            session.dispose();
            await rm(dir, {
                recursive: true, force: true
            });
        }
    };
}
test('codemode yields on new input; same sandbox makes late MCP calls once and keeps original pairing', {
    timeout: 15000
}, async () => {
    const began = deferred(), finish = deferred<string>();
    let executions = 0;
    let signal: AbortSignal | undefined;
    const gate: ToolDefinition = {
        name: 'mcp__fixture__gate', label: 'Gate', description: 'Hold a real native tool', parameters: Type.Object({}), async execute(_id, _p, s) {
            executions++;
            signal = s;
            began.resolve();
            const value = await finish.promise;
            return {
                content: [{
                        type: 'text', text: value
                    }], details: {}
            };
        }
    };
    const echoes: string[] = [];
    const echo: ToolDefinition = {
        name: 'mcp__fixture__echo', label: 'Echo', description: 'Echo', parameters: Type.Object({
            value: Type.String()
        }), async execute(_id, p) {
            const value = (p as {
                value: string;
            }).value;
            echoes.push(value);
            return {
                content: [{
                        type: 'text', text: value
                    }], details: {}
            };
        }
    };
    const h = await setup('const x=await tools.mcp__fixture__gate({});text(await tools.mcp__fixture__echo({value:x}));', [gate, echo]);
    const run = h.session.prompt('run code');
    try {
        assert.equal(await until(() => executions > 0), true, JSON.stringify(h.manager.buildSessionProjection().messages));
        await h.session.steer('NEW_TASK');
        assert.equal(await until(() => JSON.stringify(h.contexts).includes('Script running with cell ID') && JSON.stringify(h.contexts).includes('NEW_TASK'), 250), true, 'input must progress while native MCP tool is still running');
        assert.equal(executions, 1);
        assert.equal(signal?.aborted, false);
        finish.resolve('FINISHED');
        await run;
        assert.equal(await until(() => echoes.length === 1), true);
        assert.deepEqual(echoes, ['FINISHED']);
        assert.equal(executions, 1);
        assert.ok(hasValidToolPairs(h.manager.buildSessionProjection().messages));
    }
    finally {
        finish.resolve('FINISHED');
        await run;
        await h.close();
    }
});
test('fast scripts return their final result without a background notification', async () => {
    const notices: unknown[] = [];
    const h = await setup('text("FAST_RESULT");', [], 2000, {
        onCompletion: n => {
            notices.push(n);
        }
    });
    try {
        await h.session.prompt('fast');
        const transcript = JSON.stringify(h.manager.buildSessionProjection().messages);
        assert.ok(transcript.includes('FAST_RESULT'));
        assert.ok(!transcript.includes('Script running with cell ID'));
        assert.equal(notices.length, 0);
    }
    finally {
        await h.close();
    }
});
test('observations include descendants of a tool that invokes another native tool', async () => {
    const started = deferred(), finish = deferred();
    const inner: ToolDefinition = {
        name: 'mcp__fixture__inner', label: 'Inner', description: 'Inner', parameters: Type.Object({}), async execute(_id, _p, _s, update) {
            update?.({
                content: [{
                        type: 'text', text: 'DEEP_PROGRESS'
                    }], details: {}
            });
            started.resolve();
            await finish.promise;
            return {
                content: [{
                        type: 'text', text: 'DEEP_RESULT'
                    }], details: {}
            };
        }
    };
    const outer: ToolDefinition = {
        name: 'mcp__fixture__outer', label: 'Outer', description: 'Outer', parameters: Type.Object({}), async execute(_id, _p, _s, _update, ctx) {
            const outcome = await ctx.executeTool('mcp__fixture__inner', {});
            return outcome.result;
        }
    };
    const notices: unknown[] = [];
    const h = await setup('text(await tools.mcp__fixture__outer({}));', [inner, outer], 40, {
        onCompletion: n => {
            notices.push(n);
        }
    });
    try {
        await h.session.prompt('deep');
        await started.promise;
        const receipt = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolName === 'codemode') as any;
        h.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode_wait', {
                cell_id: receipt.details.cell_id, yield_time_ms: 1
            }, {
                id: 'deep-observe'
            }), {
                stopReason: 'toolUse'
            }), fauxAssistantMessage('internal')]);
        await h.session.prompt('observe descendants');
        const trace = receipt.details.trace_path;
        const liveTrace = await readFile(trace, 'utf8');
        assert.ok(liveTrace.includes('DEEP_PROGRESS'), liveTrace);
        finish.resolve();
        assert.equal(await until(() => notices.length === 1), true);
        const events = (await readFile(trace, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
        assert.ok(events.some(e => e.type === 'tool_started' && e.name === inner.name));
        assert.ok(events.some(e => e.type === 'tool_finished' && e.name === inner.name && JSON.stringify(e).includes('DEEP_RESULT')));
    }
    finally {
        finish.resolve();
        await h.close();
    }
});
test('large observation events are retrievable in full with bounded read pages', async () => {
    const h = await setup('text("BEGIN"+"x".repeat(20000)+"END");', [], 2000);
    try {
        await h.session.prompt('large output');
        const receipt = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolName === 'codemode') as any;
        const row = receipt.details.observations.find((e: any) => e.type === 'script_output');
        assert.equal(row.truncated, true);
        h.session.setActiveToolsByName(['codemode', 'codemode_wait', 'codemode_read']);
        h.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode_read', {
                cell_id: receipt.details.cell_id, event_seq: row.seq, offset: 19000, limit: 4000
            }, {
                id: 'read-full-event'
            }), {
                stopReason: 'toolUse'
            }), fauxAssistantMessage('internal')]);
        await h.session.prompt('read retained output');
        const read = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolCallId === 'read-full-event') as any;
        assert.equal(read.isError, false);
        assert.ok(JSON.stringify(read.content).includes('END'));
        assert.equal(read.details.done, true);
        assert.ok(read.details.total_characters > 20000);
    }
    finally {
        await h.close();
    }
});
test('time-based yield stores a durable result; repeated native waits do not rerun and preserve deny hooks', async () => {
    const finish = deferred<string>();
    let executions = 0, deniedExecutions = 0;
    const notices: any[] = [];
    const starts: string[] = [];
    const gate: ToolDefinition = {
        name: 'mcp__fixture__gate', label: 'Gate', description: 'Gate', parameters: Type.Object({}), async execute() {
            executions++;
            await finish.promise;
            return {
                content: [{
                        type: 'text', text: 'READY'
                    }], details: {}
            };
        }
    };
    const denied: ToolDefinition = {
        name: 'mcp__fixture__denied', label: 'Denied', description: 'Denied', parameters: Type.Object({}), async execute() {
            deniedExecutions++;
            return {
                content: [{
                        type: 'text', text: 'should not run'
                    }], details: {}
            };
        }
    };
    const h = await setup('await tools.mcp__fixture__gate({});try {await tools.mcp__fixture__denied({});} catch(e){text("DENIED_OK");}', [gate, denied], 50, {
        onCompletion: n => {
            notices.push(n);
        }
    }, [pi => {
            pi.on('tool_execution_start', e => {
                if (e.parentToolCallId)
                    starts.push(e.toolCallId);
            });
            pi.on('tool_call', e => {
                if (e.toolName === 'mcp__fixture__denied')
                    return {
                        block: true, reason: 'policy denial'
                    };
            });
        }]);
    try {
        await h.session.prompt('long');
        const messages = h.manager.buildSessionProjection().messages;
        const receipt = messages.find(m => m.role === 'toolResult' && m.toolName === 'codemode') as any;
        assert.ok(receipt);
        const cell = receipt.details.cell_id;
        assert.ok(cell);
        assert.equal(await until(() => executions === 1), true);
        finish.resolve('READY');
        assert.equal(await until(() => notices.length === 1), true);
        assert.equal(deniedExecutions, 0);
        assert.equal(new Set(starts).size, starts.length);
        for (let i = 0; i < 2; i++) {
            h.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode_wait', {
                    cell_id: cell
                }, {
                    id: `wait-${i}`
                }), {
                    stopReason: 'toolUse'
                }), fauxAssistantMessage('internal')]);
            await h.session.prompt('collect result');
        }
        assert.equal(executions, 1);
        assert.equal(notices.length, 1);
        assert.ok(JSON.stringify(h.manager.buildSessionProjection().messages).includes('DENIED_OK'));
        assert.ok(hasValidToolPairs(h.manager.buildSessionProjection().messages));
        const file = join(h.dir, 'cells', h.manager.getSessionId(), `${cell}.json`);
        const record = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(record.state, 'completed');
        assert.ok(JSON.stringify(record.result).includes('DENIED_OK'));
    }
    finally {
        finish.resolve('READY');
        await h.close();
    }
});
test('explicit terminate cancels the background cell; a new user message alone does not', async () => {
    let signal: AbortSignal | undefined;
    const notices: any[] = [];
    const tool: ToolDefinition = {
        name: 'mcp__fixture__hold', label: 'Hold', description: 'Hold', parameters: Type.Object({}), async execute(_id, _p, s) {
            signal = s;
            await new Promise<void>(r => s?.addEventListener('abort', () => r(), {
                once: true
            }));
            return {
                content: [{
                        type: 'text', text: 'cancelled'
                    }], details: {}
            };
        }
    };
    const h = await setup('text(await tools.mcp__fixture__hold({}));', [tool], 50, {
        onCompletion: n => {
            notices.push(n);
        }
    });
    try {
        await h.session.prompt('run');
        const receipt = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolName === 'codemode') as any;
        assert.equal(await until(() => !!signal), true);
        assert.equal(signal?.aborted, false);
        h.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode_wait', {
                cell_id: receipt.details.cell_id, terminate: true, yield_time_ms: 1000
            }, {
                id: 'terminate-cell'
            }), {
                stopReason: 'toolUse'
            }), fauxAssistantMessage('internal')]);
        await h.session.prompt('terminate');
        assert.equal(signal?.aborted, true);
        assert.equal(await until(() => notices.length === 1), true);
        assert.equal(notices[0].state, 'cancelled');
        assert.ok(hasValidToolPairs(h.manager.buildSessionProjection().messages));
    }
    finally {
        await h.close();
    }
});
test('two sessions keep native codemode artifact output in their own project directories', async () => {
    const a = await setup('// @options: {"max_output_tokens": 1}\ntext("A".repeat(3000));', [], 2000);
    const b = await setup('// @options: {"max_output_tokens": 1}\ntext("B".repeat(3000));', [], 2000);
    try {
        await Promise.all([a.session.prompt('A'), b.session.prompt('B')]);
        for (const h of [a, b]) {
            const r = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolName === 'codemode') as any;
            assert.ok(r.details.fullOutputPath.startsWith(join(h.dir, 'cells', 'artifacts')), r.details.fullOutputPath);
        }
    }
    finally {
        await a.close();
        await b.close();
    }
});
test('live script output, nested call results and incremental observation remain visible after yielding', async () => {
    const finish = deferred<string>();
    let executions = 0;
    const notices: any[] = [];
    const tool: ToolDefinition = {
        name: 'mcp__fixture__hold', label: 'Hold', description: 'Hold', parameters: Type.Object({}), async execute(_id, _p, _signal, onUpdate) {
            executions++;
            onUpdate?.({
                content: [{
                        type: 'text', text: 'MCP_PROGRESS'
                    }], details: {
                    progress: 1
                }
            });
            await finish.promise;
            return {
                content: [{
                        type: 'text', text: 'MCP_FINAL'
                    }], details: {}
            };
        }
    };
    const h = await setup('text("SCRIPT_STARTED");await tools.mcp__fixture__hold({});console.log("SCRIPT_ENDED");', [tool], 100, {
        onCompletion: n => {
            notices.push(n);
        }
    });
    try {
        await h.session.prompt('observe');
        assert.equal(await until(() => executions === 1), true);
        const receipt = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolName === 'codemode') as any;
        const cell = receipt.details.cell_id;
        h.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode_wait', {
                cell_id: cell, yield_time_ms: 1, after_seq: 0
            }, {
                id: 'observe-live'
            }), {
                stopReason: 'toolUse'
            }), fauxAssistantMessage('internal')]);
        await h.session.prompt('read live output');
        const observed = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolCallId === 'observe-live') as any;
        assert.ok(JSON.stringify(observed).includes('SCRIPT_STARTED'), 'script text must be visible before the script finishes');
        assert.ok(JSON.stringify(observed).includes('MCP_PROGRESS'), 'nested tool progress must be observable');
        const cursor = observed.details.next_seq;
        assert.ok(cursor > 0);
        finish.resolve('done');
        assert.equal(await until(() => notices.length === 1), true);
        h.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode_wait', {
                cell_id: cell, after_seq: cursor
            }, {
                id: 'observe-final'
            }), {
                stopReason: 'toolUse'
            }), fauxAssistantMessage('internal')]);
        await h.session.prompt('read final output');
        const final = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolCallId === 'observe-final') as any;
        assert.ok(final.details.observations.every((e: any) => e.seq > cursor));
        assert.ok(JSON.stringify(final.details.observations).includes('MCP_FINAL'));
        assert.ok(JSON.stringify(final.details.observations).includes('SCRIPT_ENDED'));
        const trace = await readFile(final.details.trace_path, 'utf8');
        assert.ok(trace.includes('SCRIPT_STARTED'));
        assert.ok(trace.includes('MCP_FINAL'));
        assert.equal(executions, 1);
    }
    finally {
        finish.resolve('done');
        await h.close();
    }
});
test('saved final result survives reopening the same session; another session cannot collect it', async () => {
    const notices: any[] = [];
    const h = await setup('text("PERSISTED_RESULT");', [], 1000, {
        onCompletion: n => {
            notices.push(n);
        }
    });
    let reopened: Awaited<ReturnType<typeof setup>> | undefined, other: Awaited<ReturnType<typeof setup>> | undefined;
    try {
        await h.session.prompt('save');
        const r = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolName === 'codemode') as any;
        const cell = r.details.cell_id;
        assert.ok(cell);
        await h.background.close();
        await h.session.waitForIdle();
        h.session.dispose();
        reopened = await setup('', [], 1000, {}, [], {
            dir: h.dir, sessionFile: h.manager.getSessionFile()!
        });
        reopened.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode_wait', {
                cell_id: cell
            }, {
                id: 'restored-wait'
            }), {
                stopReason: 'toolUse'
            }), fauxAssistantMessage('internal')]);
        await reopened.session.prompt('read retained result');
        assert.ok(JSON.stringify(reopened.manager.buildSessionProjection().messages).includes('PERSISTED_RESULT'));
        other = await setup('', [], 1000, {
            directory: join(h.dir, 'cells')
        });
        other.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode_wait', {
                cell_id: cell
            }, {
                id: 'foreign-wait'
            }), {
                stopReason: 'toolUse'
            }), fauxAssistantMessage('internal')]);
        await other.session.prompt('read foreign cell');
        const denied = other.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolCallId === 'foreign-wait') as any;
        assert.equal(denied.isError, true);
        assert.ok(!JSON.stringify(denied).includes('PERSISTED_RESULT'));
    }
    finally {
        if (other)
            await other.close();
        if (reopened)
            await reopened.close();
        else
            await h.close();
    }
});
test('hard runtime limit stops a runaway script and retains its partial output', async () => {
    const notices: any[] = [];
    const h = await setup('text("BEFORE_TIMEOUT");while(true){}', [], 10, {
        maxRuntimeMs: 200, onCompletion: n => {
            notices.push(n);
        }
    });
    try {
        await h.session.prompt('bounded script');
        assert.equal(await until(() => notices.length === 1), true);
        assert.equal(notices[0].state, 'timed_out');
        const record = JSON.parse(await readFile(join(h.dir, 'cells', h.manager.getSessionId(), `${notices[0].cellId}.json`), 'utf8'));
        assert.ok(JSON.stringify(record.result).includes('BEFORE_TIMEOUT'));
    }
    finally {
        await h.close();
    }
});
test('native bash process inside codemode keeps its pid and returns full output after input yields the cell', {
    timeout: 15000
}, async () => {
    const child = 'const fs=require("node:fs");fs.writeFileSync("started",String(process.pid));const t=setInterval(()=>{if(fs.existsSync("finish")){clearInterval(t);console.log("EXEC_FINISHED");}},10);';
    const command = "node -e '" + child + "'";
    const h = await setup('const r=await tools.bash({command:' + JSON.stringify(command) + '});text(typeof r==="string"?r:r.output);', dir => [createBashTool(dir) as unknown as ToolDefinition], 10000);
    // Register Pi's existing bash implementation, not a replacement executor.
    h.session.setActiveToolsByName(['codemode', 'codemode_wait', 'bash']);
    const run = h.session.prompt('execute native bash');
    try {
        assert.equal(await until(() => {
            try {
                return existsSync(join(h.dir, 'started'));
            }
            catch {
                return false;
            }
        }), true, JSON.stringify(h.manager.buildSessionProjection().messages));
        const pid = await readFile(join(h.dir, 'started'), 'utf8');
        await h.session.steer('NEW_EXEC_TASK');
        assert.equal(await until(() => JSON.stringify(h.contexts).includes('Script running with cell ID')), true);
        assert.equal(await readFile(join(h.dir, 'started'), 'utf8'), pid);
        await writeFile(join(h.dir, 'finish'), 'finish');
        await run;
        assert.equal(await until(() => JSON.stringify(h.manager.buildSessionProjection().messages).includes('codemode-cell-completed')), true);
        await h.session.waitForIdle();
        const receipt = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolName === 'codemode') as any;
        h.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode_wait', {
                cell_id: receipt.details.cell_id
            }, {
                id: 'read-exec'
            }), {
                stopReason: 'toolUse'
            }), fauxAssistantMessage('internal')]);
        await h.session.prompt('collect exec');
        const result = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolCallId === 'read-exec') as any;
        assert.ok(JSON.stringify(result).includes('EXEC_FINISHED'));
        assert.ok(hasValidToolPairs(h.manager.buildSessionProjection().messages));
    }
    finally {
        await writeFile(join(h.dir, 'finish'), 'finish');
        await run;
        await h.close();
    }
});
test('observation cap is an explicit failure with a retained marker, not silent trace loss', async () => {
    const notices: any[] = [];
    const h = await setup('text("X".repeat(5000));await tools.mcp__fixture__never({});', [], 10, {
        maxTraceBytes: 1000, onCompletion: n => {
            notices.push(n);
        }
    });
    try {
        await h.session.prompt('bounded trace');
        assert.equal(await until(() => notices.length === 1), true);
        assert.equal(notices[0].state, 'failed');
        const trace = await readFile(join(h.dir, 'cells', h.manager.getSessionId(), `${notices[0].cellId}.trace.jsonl`), 'utf8');
        assert.ok(trace.includes('trace_limit'));
    }
    finally {
        await h.close();
    }
});
test('session cell quota rejects a new execution without deleting retained results', async () => {
    const h = await setup('text("FIRST");', [], 1000, {
        maxCellsPerSession: 1
    });
    try {
        await h.session.prompt('first');
        h.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode', {
                code: 'text("SECOND");'
            }, {
                id: 'second-code'
            }), {
                stopReason: 'toolUse'
            }), fauxAssistantMessage('internal')]);
        await h.session.prompt('second');
        const r = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolCallId === 'second-code') as any;
        assert.equal(r.isError, true);
        assert.ok(JSON.stringify(r).includes('limit reached'));
        const saved = (await readdir(join(h.dir, 'cells', h.manager.getSessionId()))).filter(f => f.endsWith('.json'));
        assert.equal(saved.length, 1);
    }
    finally {
        await h.close();
    }
});
test('direct native bash yields on new input and exec_wait collects the same process without start_job', {
    timeout: 15000
}, async () => {
    const child = 'const fs=require("node:fs");fs.writeFileSync("direct-started",String(process.pid));const t=setInterval(()=>{if(fs.existsSync("direct-finish")){clearInterval(t);console.log("DIRECT_EXEC_FINISHED");}},10);';
    const h = await setup('', dir => [createBashTool(dir) as unknown as ToolDefinition], 10000, {}, [], undefined, true);
    h.session.setActiveToolsByName(['bash', 'exec_wait', 'codemode', 'codemode_wait']);
    h.faux.setResponses([fauxAssistantMessage(fauxToolCall('bash', {
            command: "node -e '" + child + "'"
        }, {
            id: 'direct-bash'
        }), {
            stopReason: 'toolUse'
        }), ...Array.from({
            length: 20
        }, () => (ctx: any) => {
            h.contexts.push(ctx.messages);
            return fauxAssistantMessage('internal');
        })]);
    const run = h.session.prompt('run direct bash');
    try {
        assert.equal(await until(() => existsSync(join(h.dir, 'direct-started'))), true, JSON.stringify(h.manager.buildSessionProjection().messages));
        const pid = await readFile(join(h.dir, 'direct-started'), 'utf8');
        await h.session.steer('NEW_DIRECT_TASK');
        assert.equal(await until(() => JSON.stringify(h.contexts).includes('Execution running with task ID')), true);
        const receipt = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolCallId === 'direct-bash') as any;
        assert.ok(receipt.details.task_id);
        assert.equal(await readFile(join(h.dir, 'direct-started'), 'utf8'), pid);
        await writeFile(join(h.dir, 'direct-finish'), 'done');
        await run;
        assert.equal(await until(() => JSON.stringify(h.manager.buildSessionProjection().messages).includes('exec-task-completed')), true);
        await h.session.waitForIdle();
        h.faux.setResponses([fauxAssistantMessage(fauxToolCall('exec_wait', {
                task_id: receipt.details.task_id
            }, {
                id: 'direct-collect'
            }), {
                stopReason: 'toolUse'
            }), fauxAssistantMessage('internal')]);
        await h.session.prompt('collect direct bash');
        const result = h.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolCallId === 'direct-collect') as any;
        assert.ok(JSON.stringify(result).includes('DIRECT_EXEC_FINISHED'));
        assert.ok(!JSON.stringify(h.manager.buildSessionProjection().messages).includes('start_job'));
        assert.ok(hasValidToolPairs(h.manager.buildSessionProjection().messages));
    }
    finally {
        await writeFile(join(h.dir, 'direct-finish'), 'done');
        await run;
        await h.close();
    }
});
