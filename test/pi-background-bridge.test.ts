import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
const sdk = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { NestedToolCallRunner } = await import(join(sdk, 'core/nested-tool-calls.js'));
test('detached native calls keep unique ids and original assistant across parent settlement', async () => {
    const events: any[] = [];
    const origins: any[] = [];
    const origin = {
        role: 'assistant', content: [{
                type: 'toolCall', id: 'parent', name: 'codemode', arguments: {
                    code: 'example'
                }
            }]
    };
    const runner = new NestedToolCallRunner({
        getTools: () => [], isSequential: () => false, emit: async (e: any) => {
            events.push(e);
        }, runToolCall: async (call: any, _parent: any, _signal: any, _update: any, original: any) => {
            origins.push(original);
            return {
                toolCall: call, result: {
                    content: [], details: {}
                }, isError: false
            };
        }
    });
    await runner.execute('parent', 'test', {}, {
        executionId: 'cell/1', originatingMessage: origin
    });
    runner.takeRecord('parent');
    runner.clear();
    await runner.execute('parent', 'test', {}, {
        executionId: 'cell/2', originatingMessage: origin
    });
    const starts = events.filter(e => e.type === 'tool_execution_start');
    assert.deepEqual(starts.map(e => e.toolCallId), ['cell/1/1', 'cell/2/1']);
    assert.ok(starts.every(e => e.parentToolCallId === 'parent'));
    assert.deepEqual(origins, [origin, origin]);
});
test('native codemode output artifacts honor the configured project directory', async () => {
    const dir = resolve('work/background-codemode-artifact-test');
    await mkdir(dir, {
        recursive: true
    });
    const prior = process.env.PI_TOOL_OUTPUT_DIR;
    process.env.PI_TOOL_OUTPUT_DIR = dir;
    try {
        const { writeOutputFile } = await import(join(sdk, 'utils/output-files.js'));
        const path = await writeOutputFile('pi-test', '.txt', 'output');
        assert.equal(dirname(path), dir);
    }
    finally {
        if (prior === undefined)
            delete process.env.PI_TOOL_OUTPUT_DIR;
        else
            process.env.PI_TOOL_OUTPUT_DIR = prior;
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('deep sequential native calls inherit the detached original after clear', async () => {
    const original = {
        role: 'assistant', content: [{
                type: 'toolCall', id: 'parent', name: 'codemode', arguments: {
                    code: 'example'
                }
            }]
    };
    const origins: unknown[] = [];
    const runner = new NestedToolCallRunner({
        getTools: () => [], isSequential: () => true, emit: async () => {
        }, runToolCall: async (call: any, _parent: any, _signal: any, _update: any, origin: any) => {
            origins.push(origin);
            if (call.name === 'outer') {
                runner.clear();
                await runner.execute(call.id, 'inner', {});
            }
            return {
                toolCall: call, result: {
                    content: [], details: {}
                }, isError: false
            };
        }
    });
    await runner.execute('parent', 'outer', {}, {
        executionId: 'cell/1', originatingMessage: original
    });
    assert.deepEqual(origins, [original, original]);
});

test('codemode 1.2 streams output before settlement and preserves store writes', async () => {
    const { CodemodeSandbox } = await import('@earendil-works/pi-codemode');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let observed!: () => void;
    const streamed = new Promise<void>(resolve => { observed = resolve; });
    const output: unknown[] = [];
    const sandbox = new CodemodeSandbox({ tools: [{ name: 'hold', execute: async () => { await gate; return 'done'; } }] });
    try {
        const pending = sandbox.execute("text('before'); await tools.hold(); store('answer', 42); text('after'); return 7", {
            onOutput: item => { output.push(item); observed(); }
        });
        await Promise.race([streamed, new Promise((_, reject) => setTimeout(() => reject(Error('output was not streamed')), 5000).unref())]);
        assert.deepEqual(output, [{ type: 'text', text: 'before' }]);
        release();
        const result = await pending;
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.value, 7);
            assert.deepEqual(result.storeWrites.set, { answer: 42 });
        }
        assert.deepEqual(output, [{ type: 'text', text: 'before' }, { type: 'text', text: 'after' }]);
    } finally { release(); await sandbox.close(); }
});
