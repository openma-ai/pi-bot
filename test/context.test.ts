import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ModelRuntime, ProjectedSessionEntry } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { ContextBudgetError, NonBlockingContextManager, estimateContextTokens, hasValidToolPairs, createContextExtension, type ContextOptions, type SummarySnapshot } from '../src/context.ts';
import { createModelSummarizer } from '../src/pi.ts';
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
const assistant = (ids: string[]): AgentMessage => fauxAssistantMessage(ids.map(id => ({
    type: 'toolCall' as const, id, name: 'read', arguments: {
        id
    }
})), {
    stopReason: 'toolUse', timestamp: 1
});
const result = (id: string, content = 'result'): AgentMessage => ({
    role: 'toolResult', toolCallId: id, toolName: 'read', content: [{
            type: 'text', text: content
        }], isError: false, timestamp: 1
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const history = Array.from({
    length: 20
}, (_, i) => user(`old request ${i} ${'x'.repeat(100)}`));
const input = (messages: AgentMessage[], sessionId = 'a') => ({
    sessionId, messages, historyRef: 'durable-session.jsonl'
});
const entries = (messages: AgentMessage[]): ProjectedSessionEntry[] => messages.map((message, index) => ({
    sourceEntry: {
        type: 'message', id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, timestamp: '2026-10-11T00:00:00Z', message
    }, messages: [message]
}));
const schedule = (manager: NonBlockingContextManager, messages = history, sessionId = 'a') => manager.schedule({
    sessionId, entries: entries(messages), state: {
        jobs: ['job1']
    }
});
const options: ContextOptions = {
    getState: () => ({
        pendingJobs: ['job1'], questions: ['question1']
    }), recentMessages: 2, thresholdTokens: 500
};
test('soft threshold schedules later; full context stays unchanged while summary hangs', async () => {
    let invoked = 0;
    const manager = new NonBlockingContextManager({
        ...options, summarize: async () => {
            invoked++;
            return new Promise<string>(() => {
            });
        }
    });
    const messages = [system, ...history, user('do this now')];
    const before = structuredClone(messages);
    const first = manager.preserveContext(input(messages));
    schedule(manager, messages);
    assert.equal(invoked, 0, 'background work must not start on the foreground stack');
    await tick();
    assert.equal(invoked, 1);
    const next = [...messages, user('new foreground request')];
    const second = manager.preserveContext(input(next));
    schedule(manager, next);
    assert.deepEqual(messages, before);
    assert.deepEqual(first.filter(message => !JSON.stringify(message).includes('[Runtime ledger;')), messages);
    assert.deepEqual(second.filter(message => !JSON.stringify(message).includes('[Runtime ledger;')), next);
    for (const message of messages)
        assert.ok(first.includes(message), 'every original message identity is retained');
    assert.match(JSON.stringify(second), /job1/);
    assert.match(JSON.stringify(second), /question1/);
    assert.equal(invoked, 1);
    manager.reset();
});
test('below soft threshold creates no background request', async () => {
    let invoked = 0;
    const manager = new NonBlockingContextManager({
        ...options, thresholdTokens: 10000, summarize: async () => {
            invoked++;
            return 'summary';
        }
    });
    schedule(manager);
    await tick();
    assert.equal(invoked, 0);
});
test('ready summary becomes only a native boundary draft and preserves the late tail', async () => {
    let resolve!: (value: string) => void;
    const snapshots: SummarySnapshot[] = [];
    const manager = new NonBlockingContextManager({
        ...options, summarize: snapshot => {
            snapshots.push(snapshot);
            return new Promise(r => {
                resolve = r;
            });
        }
    });
    schedule(manager);
    await tick();
    assert.deepEqual(snapshots[0]!.messages, history.slice(0, -2));
    assert.notEqual(snapshots[0]!.messages[0], history[0], 'the snapshot must not reference mutable native messages');
    resolve('background summary');
    await tick();
    assert.doesNotMatch(JSON.stringify(manager.preserveContext(input(history))), /background summary/);
    const late = [...history, user('arrived after snapshot')];
    const ready = manager.adoptReady('a', entries(late));
    assert.equal(ready?.type, 'compaction');
    assert.equal(ready?.summary, 'background summary');
    assert.equal(ready?.firstKeptEntryId, 'entry-18');
    assert.equal(manager.adoptReady('a', entries(late)), undefined, 'a draft is consumed once');
    assert.deepEqual(manager.preserveContext(input(late)).filter(message => !JSON.stringify(message).includes('[Runtime ledger;')), late, 'manager does not own a second active history');
});
test('changed prefix, changed entry identity, and cross-session completion are discarded', async () => {
    let resolve!: (value: string) => void;
    const manager = new NonBlockingContextManager({
        ...options, summarize: () => new Promise(r => {
            resolve = r;
        })
    });
    schedule(manager);
    await tick();
    resolve('stale summary');
    await tick();
    assert.equal(manager.adoptReady('a', entries([user('different prefix'), ...history.slice(1)])), undefined);
    manager.reset();
    schedule(manager);
    await tick();
    resolve('forked summary');
    await tick();
    const fork = entries(history);
    fork[0]!.sourceEntry.id = 'different-id-same-content';
    assert.equal(manager.adoptReady('a', fork), undefined);
    manager.reset();
    schedule(manager);
    await tick();
    const oldResolve = resolve;
    manager.preserveContext(input([user('session b')], 'b'));
    oldResolve('cross-session secret');
    await tick();
    assert.equal(manager.adoptReady('b', entries(history)), undefined);
});
test('background failure keeps complete foreground context with cooldown and bounded retry', async () => {
    let invocations = 0;
    const errors: Error[] = [];
    const manager = new NonBlockingContextManager({
        ...options, summaryRetryMs: 20, summaryMaxAttempts: 2,
        summarize: async () => {
            invocations++;
            throw Error('offline');
        }, onSummaryError: error => errors.push(error)
    });
    schedule(manager);
    await tick();
    await tick();
    assert.equal(invocations, 1);
    for (let i = 0; i < 5; i++) {
        assert.equal(manager.preserveContext(input(history)).length, history.length + 1);
        schedule(manager);
    }
    assert.equal(invocations, 1);
    await delay(25);
    schedule(manager);
    await tick();
    await tick();
    assert.equal(invocations, 2);
    await delay(25);
    schedule(manager);
    await tick();
    assert.equal(invocations, 2);
    assert.equal(errors.length, 2);
});
test('oversized tool results and long tool runs fail explicitly instead of trimming', () => {
    const manager = new NonBlockingContextManager({
        ...options, maxContextTokens: 5000, outputReserveTokens: 500
    });
    const messages = [system, user('current instruction'), assistant(['a', 'b']), result('a', 'x'.repeat(50000)), result('b')];
    const original = structuredClone(messages);
    assert.throws(() => manager.preserveContext(input(messages)), /Nothing was truncated and no summary was awaited/);
    assert.deepEqual(messages, original);
    const long: AgentMessage[] = [system, user('Never delete production data')];
    for (let i = 0; i < 100; i++)
        long.push(assistant([`call-${i}`]), result(`call-${i}`, 'x'.repeat(1000)));
    assert.throws(() => manager.preserveContext(input(long)), ContextBudgetError);
});
test('complete parallel tool batches are preserved and never split in a summary prefix', async () => {
    let snapshot: SummarySnapshot | undefined;
    const manager = new NonBlockingContextManager({
        ...options, recentMessages: 1, summarize: async (value) => {
            snapshot = value;
            return 'summary';
        }
    });
    const messages = [...history, assistant(['a', 'b']), result('a'), result('b')];
    const full = manager.preserveContext(input(messages));
    assert.ok(hasValidToolPairs(full));
    schedule(manager, messages);
    await tick();
    assert.deepEqual(snapshot!.messages, history);
    assert.equal(manager.adoptReady('a', entries(messages))?.firstKeptEntryId, 'entry-20');
});
test('all incomplete, duplicate, or orphan tool results fail rather than dropping old history', () => {
    const manager = new NonBlockingContextManager(options);
    assert.throws(() => manager.preserveContext(input([user('request'), assistant(['a', 'b']), result('a')])), ContextBudgetError);
    assert.throws(() => manager.preserveContext(input([user('request'), assistant(['a']), result('a'), result('a')])), ContextBudgetError);
    assert.throws(() => manager.preserveContext(input([result('old orphan'), user('new request')])), ContextBudgetError);
});
test('oversized input, state, or invalid reserve never silently truncate instructions', () => {
    const manager = new NonBlockingContextManager({
        ...options, maxContextTokens: 4000, outputReserveTokens: 500
    });
    assert.throws(() => manager.preserveContext(input([system, user('x'.repeat(10000))])), /Full native context/);
    const bigState = new NonBlockingContextManager({
        ...options, getState: () => ({
            pending: 'x'.repeat(10000)
        }), maxContextTokens: 4000, outputReserveTokens: 500
    });
    assert.throws(() => bigState.preserveContext(input([system, user('small')])), /authoritative runtime state/);
    assert.throws(() => new NonBlockingContextManager({
        ...options, maxContextTokens: 4000
    }).preserveContext(input(history)), /output reserve/);
});
test('manual compact is cancelled; guard aborts without changing history; history stays paginated', async () => {
    const hooks = new Map<string, Function>();
    let tool: any;
    const factory = createContextExtension({
        ...options, maxContextTokens: 4000, outputReserveTokens: 500
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
    const messages = [system, user('x'.repeat(50000))];
    assert.equal(hooks.get('context_with_system')!({
        messages
    }, ctx), undefined);
    assert.equal(aborted, 1);
    assert.equal((messages[1] as any).content.length, 50000);
    const page = await tool.execute('id', {
        toolCallId: 'a', maxChars: 256
    }, undefined, undefined, ctx);
    assert.ok(page.content[0].text.length < 1000);
    assert.deepEqual(page.details.next, {
        offset: 0, charOffset: 256
    });
});
test('timeout and reset cannot multiply an abort-ignoring task', async () => {
    let invocations = 0;
    let signal: AbortSignal | undefined;
    const manager = new NonBlockingContextManager({
        ...options, summaryTimeoutMs: 5, summarize: async (snapshot) => {
            signal = snapshot.signal;
            invocations++;
            return new Promise<string>(() => {
            });
        }
    });
    schedule(manager);
    await tick();
    await delay(15);
    assert.equal(signal?.aborted, true);
    schedule(manager, [...history, user('new')]);
    manager.reset();
    schedule(manager, [...history, user('new session')], 'b');
    await tick();
    assert.equal(invocations, 1);
    manager.reset();
});
test('host shutdown cancels only the background summary, never waits on it or restarts it', async () => {
    const lifetime = new AbortController();
    let snapshot: SummarySnapshot | undefined;
    const manager = new NonBlockingContextManager({
        ...options, signal: lifetime.signal, summarize: async (value) => {
            snapshot = value;
            return new Promise<string>(() => {
            });
        }
    });
    schedule(manager);
    await tick();
    lifetime.abort();
    assert.equal(snapshot?.signal.aborted, true);
    schedule(manager);
    assert.equal(manager.adoptReady('a', entries(history)), undefined);
});
test('system updates and all original message chronology remain unchanged', () => {
    const manager = new NonBlockingContextManager(options);
    const update: AgentMessage = {
        role: 'system', content: 'Updated policy', toolsRemoved: [{
                name: 'read'
            }], timestamp: 2
    };
    const messages = [system, user('request'), assistant(['a']), result('a'), update, user('next')];
    const full = manager.preserveContext(input(messages));
    assert.deepEqual(full.filter(message => !JSON.stringify(message).includes('[Runtime ledger;')), messages);
    assert.ok(estimateContextTokens(full) > estimateContextTokens(messages));
});
test('default model summarizer makes a separate tool-free request with the snapshot cancellation signal', async () => {
    const model = fauxProvider().getModel();
    const signal = new AbortController().signal;
    let request: any;
    const runtime = {
        completeSimple: async (...args: unknown[]) => {
            request = args;
            return fauxAssistantMessage('useful factual summary');
        }
    } as unknown as ModelRuntime;
    const summarize = createModelSummarizer(runtime, model);
    assert.equal(await summarize({
        sessionId: 'a', messages: history, state: {
            jobs: ['pending']
        }, signal
    }), 'useful factual summary');
    assert.equal(request[0], model);
    assert.equal(request[2].signal, signal);
    assert.equal(request[1].tools, undefined);
    assert.match(request[1].messages[0].content, /old request 0/);
    assert.match(request[1].systemPrompt, /actually delivered/);
    assert.equal(request[2].maxTokens, 2048);
});
