import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Stream, Fiber, Chunk } from 'effect';
import type { AgentTurnInput, OpenMAEvent } from '@openma/matter/agent';
import type { ContextProjection } from '@openma/matter';
import { makePiAgentDriver, renderTurnPrompt, type PiConversation, type PiConversationEvent, type PiConversationInput } from '../src/pi/agent-driver.ts';
/** A scripted Pi session: each prompt waits for `release` when one is set, then answers. */
function fakePi(script: (pi: ReturnType<typeof fakePi>, text: string) => Promise<void> = async (pi, text) => pi.say(`echo:${text.length}`)) {
    const listeners = new Set<(event: PiConversationEvent) => void>();
    const pi = {
        prompts: [] as string[], steers: [] as string[], queued: [] as string[], aborted: 0, opens: [] as PiConversationInput[], disposed: 0, streaming: false,
        say(text: string, hasToolCalls = false, stopReason = 'stop') {
            for (const listener of listeners)
                listener({ type: 'assistant_message', text, hasToolCalls, stopReason });
        },
        emit(event: PiConversationEvent) {
            for (const listener of listeners)
                listener(event);
        },
        open: async (input: PiConversationInput): Promise<PiConversation> => {
            pi.opens.push(input);
            return {
                get isStreaming() {
                    return pi.streaming;
                },
                prompt: async text => {
                    pi.prompts.push(text);
                    pi.streaming = true;
                    try {
                        await script(pi, text);
                    }
                    finally {
                        pi.streaming = false;
                    }
                },
                steer: async text => {
                    pi.steers.push(text);
                },
                drainSteers: () => pi.queued.splice(0),
                abort: async () => {
                    pi.aborted++;
                },
                subscribe(listener) {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                dispose: () => {
                    pi.disposed++;
                }
            };
        }
    };
    return pi;
}
const context = (text: string, id = 'ctx'): ContextProjection => ({
    schemaVersion: '0.1', id, scopeId: 'scope', workThreadId: 'thread', triggerEventId: 'evt', digest: 'd', grants: [], createdAt: '2026-11-01T00:00:00.000Z',
    items: [{ id: 'evt', kind: 'event', provenance: [], value: { type: 'project.message', payload: { text } } }]
});
const input = (turnId: string, over: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
    session: { id: 's1' }, sessionId: 's1', turnId, afterSequence: 0, context: context('hello'), allow: [], ...over
});
const collect = (stream: Stream.Stream<OpenMAEvent, unknown>) => Effect.runPromise(Stream.runCollect(stream)).then(chunk => Chunk.toReadonlyArray(chunk) as readonly OpenMAEvent[]);
const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>(resolve => (open = resolve));
    return { open, opened };
};
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
test('turn runs a Pi prompt and emits sequenced events ending in a terminal', async () => {
    const pi = fakePi();
    const driver = makePiAgentDriver({ id: 'pi', open: pi.open });
    assert.deepEqual(await Effect.runPromise(driver.capabilities()), { resume: true, cancel: true, permissions: false, concurrentTurns: false, operations: true, steering: true });
    const handle = await Effect.runPromise(driver.createSession({ sessionId: 's1', bindingKey: 'b', scopeId: 'scope', workThreadId: 'w', generation: 1, idempotencyKey: 's1' }));
    const events = await collect(driver.turn(input('t1', { session: handle })));
    assert.deepEqual(events.map(e => [e.seq, e.type]), [[1, 'agent.message'], [2, 'turn.completed']]);
    assert.equal(pi.prompts.length, 1);
    assert.match(pi.prompts[0]!, /hello/);
    assert.equal(pi.opens[0]!.scopeId, 'scope', 'the Session keeps the host-bound scope');
    // The next Turn on an idle Session reuses the Pi session and prompts again.
    await collect(driver.turn(input('t2', { session: handle })));
    assert.equal(pi.opens.length, 1);
    assert.equal(pi.prompts.length, 2);
});
test('steer on a running Turn goes to Pi steer and is accepted once per steerId', async () => {
    const release = gate(), started = gate();
    const pi = fakePi(async p => {
        started.open();
        await release.opened;
        p.say('done');
    });
    const driver = makePiAgentDriver({ id: 'pi', open: pi.open });
    const running = Effect.runPromise(Stream.runCollect(driver.turn(input('t1'))));
    await started.opened;
    const steer = { session: { id: 's1' }, sessionId: 's1', turnId: 't1', steerId: 'k1', context: context('change course') };
    assert.deepEqual(await Effect.runPromise(driver.steer!(steer)), { status: 'accepted' });
    assert.deepEqual(await Effect.runPromise(driver.steer!(steer)), { status: 'accepted' });
    assert.equal(pi.steers.length, 1, 'a redelivered steer is applied once');
    assert.match(pi.steers[0]!, /change course/);
    assert.equal(pi.prompts.length, 1, 'no new prompt while running');
    release.open();
    await running;
});
test('steer is rejected once the Turn finished, so the runtime starts the next Turn', async () => {
    const pi = fakePi();
    const driver = makePiAgentDriver({ id: 'pi', open: pi.open });
    await collect(driver.turn(input('t1')));
    const ack = await Effect.runPromise(driver.steer!({ session: { id: 's1' }, sessionId: 's1', turnId: 't1', steerId: 'k', context: context('late') }));
    assert.equal(ack.status, 'rejected');
    assert.equal(pi.steers.length, 0);
    const other = await Effect.runPromise(driver.steer!({ session: { id: 'never' }, sessionId: 'never', turnId: 'x', steerId: 'k', context: context('late') }));
    assert.equal(other.status, 'rejected');
});
test('a steer Pi queued after its final check is still applied inside the same Turn', async () => {
    const pi = fakePi();
    pi.queued.push('left in the queue');
    const driver = makePiAgentDriver({ id: 'pi', open: pi.open });
    const events = await collect(driver.turn(input('t1')));
    assert.deepEqual(pi.prompts.slice(1), ['left in the queue']);
    assert.equal(events.at(-1)!.type, 'turn.completed');
    assert.equal(events.filter(e => e.type === 'turn.completed').length, 1);
});
test('an allowed operation is a Pi tool answered through the callback channel', async () => {
    const tool = { name: 'pi-bot.message.reply', integrationId: 'pi-bot', operation: 'message.reply', description: 'Reply', inputSchema: { type: 'object' } };
    let toolResult: unknown;
    const pi = fakePi(async p => {
        const reply = p.opens[0]!.tools.find(t => t.name === 'pi-bot_message_reply')!;
        toolResult = await reply.execute('call-1', { text: 'hi', key: 'k' });
        p.say('sent');
    });
    const driver = makePiAgentDriver({ id: 'pi', open: pi.open });
    const seen: OpenMAEvent[] = [];
    await Effect.runPromise(driver.turn(input('t1', { tools: [tool], allow: [tool.name] })).pipe(Stream.runForEach(event => Effect.gen(function* () {
        seen.push(event);
        if (event.type === 'callback.requested')
            yield* driver.respondToCallback!({ session: { id: 's1' }, callbackId: 'call-1', result: { status: 'delivered', receipt: { outboxId: 'o1' } } });
    }))));
    const call = seen.find(e => e.type === 'callback.requested')!;
    assert.deepEqual((call.data as { params: unknown }).params, { integrationId: 'pi-bot', operation: 'message.reply', input: { text: 'hi', key: 'k' } });
    assert.equal((call.data as { method: string }).method, 'openmatter/operation');
    assert.deepEqual(toolResult, { status: 'delivered', receipt: { outboxId: 'o1' } });
    // Answering again is idempotent.
    await Effect.runPromise(driver.respondToCallback!({ session: { id: 's1' }, callbackId: 'call-1', result: null }));
});
test('a worker driver exposes no operations but keeps host tools', async () => {
    const tool = { name: 'pi-bot.message.reply', integrationId: 'pi-bot', operation: 'message.reply', description: 'Reply', inputSchema: {} };
    const pi = fakePi();
    const hostTool = { name: 'lookup', description: 'x', parameters: {}, execute: async () => null };
    const driver = makePiAgentDriver({ id: 'pi', open: pi.open, exposeOperations: false, hostTools: () => [hostTool] });
    await collect(driver.turn(input('t1', { tools: [tool], allow: [tool.name] })));
    assert.deepEqual(pi.opens[0]!.tools.map(t => t.name), ['lookup']);
});
test('cancel aborts Pi and the Turn ends cancelled; a provider error fails the Turn', async () => {
    const release = gate(), started = gate();
    const pi = fakePi(async () => {
        started.open();
        await release.opened;
    });
    const driver = makePiAgentDriver({ id: 'pi', open: pi.open });
    const fiber = Effect.runFork(Stream.runCollect(driver.turn(input('t1'))));
    await started.opened;
    await Effect.runPromise(driver.cancel({ session: { id: 's1' }, turnId: 't1' }));
    await Effect.runPromise(driver.cancel({ session: { id: 's1' }, turnId: 't1' }));
    assert.equal(pi.aborted, 1, 'repeated cancel is idempotent once');
    release.open();
    const chunk = await Effect.runPromise(Fiber.join(fiber));
    assert.equal(Chunk.toReadonlyArray(chunk).at(-1)!.type, 'turn.cancelled');
    const failing = fakePi(async p => p.say('', false, 'error'));
    const events = await collect(makePiAgentDriver({ id: 'pi', open: failing.open }).turn(input('t2')));
    assert.equal(events.at(-1)!.type, 'turn.failed');
});
test('resume: an unavailable session is reported, and a Turn that lost its Pi run is interrupted, not re-run', async () => {
    const pi = fakePi();
    const driver = makePiAgentDriver({ id: 'pi', open: pi.open, canResume: id => id === 'alive' });
    assert.equal((await Effect.runPromiseExit(driver.resumeSession({ id: 'gone' })))._tag, 'Failure');
    assert.equal((await Effect.runPromiseExit(driver.resumeSession({ id: 'alive' })))._tag, 'Success');
    const events = await collect(driver.turn(input('t1', { session: { id: 'alive' }, sessionId: 'alive', afterSequence: 3 })));
    assert.deepEqual(events.map(e => [e.seq, e.type]), [[4, 'turn.interrupted']]);
    assert.equal(pi.prompts.length, 0, 'the Agent does not think twice');
    await settle();
});
test('prompt rendering puts the trigger first, hides routing, and sends project context once per Session', () => {
    const projection: ContextProjection = {
        ...context('do it'), items: [
            { id: 'a', kind: 'coordinator-association', provenance: [], value: { role: 'coordinator' } },
            { id: 'p', kind: 'project-context', provenance: [], value: 'repo notes' },
            { id: 'evt', kind: 'event', provenance: [], value: { type: 'project.worker.requested', payload: { workerId: 'w1', task: 'do it', attachments: [{ data: 'x'.repeat(2000) }] } } },
            { id: 'r', kind: 'coordinator-worker-result', provenance: [], value: { workerId: 'w1', outcome: 'completed', output: 'result' } }
        ]
    };
    const seen = new Set<string>();
    const first = renderTurnPrompt(projection, seen);
    assert.match(first.split('\n')[0]!, /^\[trigger\].*do it/);
    assert.doesNotMatch(first, /coordinator-association/);
    assert.match(first, /repo notes/);
    assert.match(first, /coordinator-worker-result/);
    const second = renderTurnPrompt(projection, seen);
    assert.doesNotMatch(second, /repo notes/);
    assert.match(second, /coordinator-worker-result/, 'results are per Turn facts, never deduplicated away');
});
