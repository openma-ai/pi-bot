import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { ContextBudgetError, NonBlockingContextManager, estimateContextTokens, hasValidToolPairs, createContextExtension } from '../src/context.ts';
const user = (content: string): AgentMessage => ({
    role: 'user', content, timestamp: 1
});
const system: AgentMessage = {
    role: 'system', content: 'Preserve these exact safety instructions.', toolsAdded: [{
            name: 'read', description: 'read history', parameters: {
                type: 'object', properties: {}
            }
        }], timestamp: 1
};
const assistant = (ids: string[]): AgentMessage => ({
    role: 'assistant', content: ids.map(id => ({
        type: 'toolCall', id, name: 'read', arguments: {
            id
        }
    })), api: 'openai-responses', provider: 'openai', model: 'fake', usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0
        }
    }, stopReason: 'toolUse', timestamp: 1
});
const result = (id: string, content = 'result'): AgentMessage => ({
    role: 'toolResult', toolCallId: id, toolName: 'read', content: [{
            type: 'text', text: content
        }], isError: false, timestamp: 1
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const history = Array.from({
    length: 20
}, (_, i) => user(`old request ${i}`));
const input = (messages: AgentMessage[], sessionId = 'a') => ({
    sessionId, messages, historyRef: 'durable-session.jsonl'
});
test('never waits on a hanging summarizer; next full-context projection proceeds', async () => {
    let invoked = 0;
    const manager = new NonBlockingContextManager({
        getState: () => ({
            pendingJobs: ['job1'], questions: ['question1']
        }), recentMessages: 2, maxContextTokens: 5000, outputReserveTokens: 500,
        summarize: async () => {
            invoked++;
            return new Promise<string>(() => {
            });
        }
    });
    const first = manager.project(input([system, ...history, user('do this now')]));
    await tick();
    assert.equal(invoked, 1);
    const second = manager.project(input([system, ...history, user('do this now'), user('new foreground request')]));
    assert.ok(second.some(message => message.role === 'user' && message.content === 'new foreground request'));
    assert.ok(JSON.stringify(second).includes('job1'));
    assert.ok(JSON.stringify(second).includes('question1'));
    assert.equal(invoked, 1);
    assert.ok(estimateContextTokens(first) <= 4500);
    manager.reset();
});
test('ready result is adopted only at a boundary and only for the same prefix', async () => {
    let resolve!: (value: string) => void;
    const manager = new NonBlockingContextManager({
        getState: () => ({}), recentMessages: 2, summarize: () => new Promise(r => {
            resolve = r;
        })
    });
    manager.project(input(history));
    await tick();
    resolve('background summary');
    await tick();
    assert.equal(JSON.stringify(manager.project(input(history))).includes('background summary'), false);
    const ready = manager.adoptReady('a', history);
    assert.ok(ready);
    assert.ok(JSON.stringify(manager.project(input(history))).includes('background summary'));
    const changed = [user('forked prefix'), ...history.slice(1)];
    assert.equal(JSON.stringify(manager.project(input(changed))).includes('background summary'), false);
    manager.reset();
});
test('stale ready result and late cross-session completion are rejected', async () => {
    let resolve!: (value: string) => void;
    const manager = new NonBlockingContextManager({
        getState: () => ({}), recentMessages: 2, summarize: () => new Promise(r => {
            resolve = r;
        })
    });
    manager.schedule('a', history, {});
    await tick();
    resolve('stale');
    await tick();
    assert.equal(manager.adoptReady('a', [user('different'), ...history.slice(1)]), undefined);
    manager.reset();
    manager.schedule('a', history, {});
    await tick();
    const oldResolve = resolve;
    manager.project(input([user('session b request')], 'b'));
    oldResolve('cross-session secret');
    await tick();
    assert.equal(manager.adoptReady('b', history), undefined);
    assert.equal(JSON.stringify(manager.project(input([user('session b request')], 'b'))).includes('cross-session secret'), false);
    manager.reset();
});
test('failed background work never becomes a synchronous fallback', async () => {
    let invocations = 0;
    const errors: Error[] = [];
    const manager = new NonBlockingContextManager({
        getState: () => ({}), recentMessages: 2, summarize: async () => {
            invocations++;
            throw new Error('offline');
        }, onSummaryError: error => errors.push(error)
    });
    manager.project(input(history));
    await tick();
    await tick();
    assert.equal(invocations, 1);
    assert.equal(errors.length, 1);
    for (let i = 0; i < 5; i++)
        assert.ok(manager.project(input(history)).length > 0);
    assert.equal(invocations, 1);
    manager.reset();
});
test('oversized tool result is explicit and retrievable, retains parallel pairs and system/tools', () => {
    const manager = new NonBlockingContextManager({
        getState: () => ({
            pending: ['p']
        }), maxContextTokens: 5000, outputReserveTokens: 500
    });
    const messages = [system, user('current instruction must survive'), assistant(['a', 'b']), result('a', 'x'.repeat(50000)), result('b')];
    const original = structuredClone(messages);
    const projected = manager.project(input(messages));
    assert.deepEqual(messages, original);
    assert.equal(projected[0], system);
    assert.ok(hasValidToolPairs(projected));
    assert.ok(estimateContextTokens(projected) <= 4500);
    assert.ok(JSON.stringify(projected).includes('context_history'));
    assert.ok(JSON.stringify(projected).includes('toolCallId=a'));
    assert.ok(JSON.stringify(projected).includes('current instruction must survive'));
});
test('long tool run retains latest user and bounded recent complete tool batches without summary', () => {
    const manager = new NonBlockingContextManager({
        getState: () => ({
            jobs: ['durable-job']
        }), maxContextTokens: 5000, outputReserveTokens: 500
    });
    const messages: AgentMessage[] = [system, user('Never delete production data')];
    for (let i = 0; i < 100; i++)
        messages.push(assistant([`call-${i}`]), result(`call-${i}`, 'x'.repeat(1000)));
    const projected = manager.project(input(messages));
    assert.ok(estimateContextTokens(projected) <= 4500);
    assert.ok(hasValidToolPairs(projected));
    assert.ok(JSON.stringify(projected).includes('Never delete production data'));
    assert.ok(JSON.stringify(projected).includes('call-99'));
    assert.ok(projected.length < messages.length);
});
test('incomplete or duplicate newest tool batch fails explicitly; old orphan never leaks', () => {
    const manager = new NonBlockingContextManager({
        getState: () => ({}), maxContextTokens: 5000, outputReserveTokens: 500
    });
    assert.throws(() => manager.project(input([user('request'), assistant(['a', 'b']), result('a')])), ContextBudgetError);
    assert.throws(() => manager.project(input([user('request'), assistant(['a']), result('a'), result('a')])), ContextBudgetError);
    const projected = manager.project(input([result('old orphan'), user('new request')]));
    assert.ok(hasValidToolPairs(projected));
    assert.ok(!projected.some(message => message.role === 'toolResult'));
});
test('oversized latest input and oversized state never silently truncate instructions', () => {
    const manager = new NonBlockingContextManager({
        getState: () => ({}), maxContextTokens: 4000, outputReserveTokens: 500
    });
    assert.throws(() => manager.project(input([system, user('x'.repeat(10000))])), /current user input/);
    const bigState = new NonBlockingContextManager({
        getState: () => ({
            pending: 'x'.repeat(10000)
        }), maxContextTokens: 4000, outputReserveTokens: 500
    });
    assert.throws(() => bigState.project(input([system, user('small')])), /authoritative runtime state/);
});
test('manual compact hook always cancels, fail-closed handler aborts, history is paginated', async () => {
    const hooks = new Map<string, Function>();
    let tool: any;
    const factory = createContextExtension({
        getState: () => ({}), maxContextTokens: 4000, outputReserveTokens: 500
    });
    await factory({
        on: (name: string, fn: Function) => hooks.set(name, fn), registerTool: (definition: any) => {
            tool = definition;
        }
    } as any);
    assert.deepEqual(hooks.get('session_before_compact')!(), {
        cancel: true
    });
    let aborted = 0;
    const ctx: any = {
        abort: () => aborted++, sessionManager: {
            getSessionId: () => 'a', getSessionFile: () => '/session.jsonl', getBranch: () => [{
                    type: 'message', message: result('a', 'x'.repeat(20000))
                }]
        }
    };
    const projected = hooks.get('context_with_system')!({
        messages: [system, user('x'.repeat(50000))]
    }, ctx);
    assert.equal(aborted, 1);
    assert.ok(JSON.stringify(projected).includes('Request blocked'));
    const page = await tool.execute('id', {
        toolCallId: 'a', maxChars: 256
    }, undefined, undefined, ctx);
    assert.ok(page.content[0].text.length < 1000);
    assert.deepEqual(page.details.next, {
        offset: 0, charOffset: 256
    });
});
test('timeout and session reset cannot multiply an abort-ignoring background task', async () => {
    let invocations = 0;
    const manager = new NonBlockingContextManager({
        getState: () => ({}), recentMessages: 2, summaryTimeoutMs: 5, summarize: async () => {
            invocations++;
            return new Promise<string>(() => {
            });
        }
    });
    manager.project(input(history));
    await tick();
    await new Promise(resolve => setTimeout(resolve, 15));
    manager.project(input([...history, user('new')]));
    manager.reset();
    manager.project(input([...history, user('other session')], 'b'));
    await tick();
    assert.equal(invocations, 1);
    manager.reset();
});
test('system updates keep original chronology relative to retained tool calls', () => {
    const manager = new NonBlockingContextManager({
        getState: () => ({})
    });
    const update: AgentMessage = {
        role: 'system', content: 'Updated policy', toolsRemoved: [{
                name: 'read'
            }], timestamp: 2
    };
    const messages = [system, user('request'), assistant(['a']), result('a'), update, user('next')];
    const projected = manager.project(input(messages));
    const toolIndex = projected.findIndex(message => message.role === 'toolResult');
    assert.ok(projected.indexOf(update) > toolIndex);
    assert.equal(projected[0], system);
});
