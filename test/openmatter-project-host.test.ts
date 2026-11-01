import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { conversationKeyOf, observeProjectEvent, PiBotProjectHost, projectFromId, projectIdForEnvelope, type PiBotRole } from '../src/daemon/openmatter/project-host.ts';
import type { PiBotReplyInput } from '../src/daemon/openmatter/pi-bot-integration.ts';
import type { PiConversation, PiConversationEvent, PiConversationInput, PiDriverTool } from '../src/pi/agent-driver.ts';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import type { Envelope, Outbound } from '../src/daemon/runtime/store.ts';
/** Scripted model: `brain` decides what each Pi session does with a prompt. */
type Session = { role: PiBotRole; input: PiConversationInput; prompts: string[]; steers: string[]; say(text: string): void; call(name: string, args: unknown): Promise<any> };
type Brain = (session: Session, prompt: string) => Promise<void>;
const fakeOpen = (brain: Brain, sessions: Session[]) => async (role: PiBotRole, input: PiConversationInput): Promise<PiConversation> => {
    const listeners = new Set<(event: PiConversationEvent) => void>();
    let calls = 0;
    const session: Session = {
        role, input, prompts: [], steers: [],
        say(text) {
            for (const listener of listeners)
                listener({ type: 'assistant_message', text, hasToolCalls: false, stopReason: 'stop' });
        },
        async call(name, args) {
            const tool: PiDriverTool | undefined = input.tools.find(t => t.name === name);
            if (!tool)
                throw new Error(`no tool ${name} on ${role}: ${input.tools.map(t => t.name)}`);
            return tool.execute(`call-${++calls}`, args);
        }
    };
    sessions.push(session);
    let streaming = false;
    return {
        get isStreaming() {
            return streaming;
        },
        prompt: async text => {
            session.prompts.push(text);
            streaming = true;
            try {
                await brain(session, text);
            }
            finally {
                streaming = false;
            }
        },
        steer: async text => {
            session.steers.push(text);
        },
        drainSteers: () => [],
        abort: async () => { },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispose: () => { }
    };
};
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const task of cleanup.splice(0).reverse())
        await task();
});
const envelope = (id: string, text: string, over: Partial<Envelope> = {}): Envelope => ({
    id, from: 'user', to: 'bot-a', text, key: id, kind: 'user', taskId: 't1', replyTo: null, hop: 0, state: 'queued', createdAt: Date.now(),
    route: { channelId: 'alpha', threadId: 'main', senderId: 'alice' }, ...over
} as Envelope);
const setup = (brain: Brain, over: Partial<ConstructorParameters<typeof PiBotProjectHost>[0]> = {}) => {
    const directory = mkdtempSync(join(tmpdir(), 'pibot-project-'));
    const sessions: Session[] = [];
    const delivered: PiBotReplyInput[] = [];
    const host = new PiBotProjectHost({
        directory, eventLeaseMs: 100, open: fakeOpen(brain, sessions),
        reply: input => (delivered.push(input), { outboxId: `o${delivered.length}` }),
        ...over
    });
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    cleanup.push(() => host.close());
    host.start();
    return { host, sessions, delivered };
};
const until = async (what: string, ready: () => boolean | Promise<boolean>, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (!(await ready())) {
        if (Date.now() > deadline)
            throw new Error(`Timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};
const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>(resolve => (open = resolve));
    return { open, opened };
};
const operationCalls = (host: PiBotProjectHost, projectId: string) => Effect.runPromise(host.service.store.inspectScope(projectId)).then(facts => facts);
const delegateAndReply: Brain = async (session, prompt) => {
    if (session.role === 'worker') {
        session.say(`RESULT for: ${prompt.includes('count') ? 'count' : 'other'}`);
        return;
    }
    if (prompt.includes('coordinator-worker-result')) {
        await session.call('pi-bot_message_reply', { text: 'The worker finished: 42', key: 'final' });
        return;
    }
    await session.call('delegate_worker', { worker_id: 'researcher', task: 'count the things' });
};
test('project identity is one bot thread and is reversible', () => {
    const id = projectIdForEnvelope(envelope('x', 'y'));
    assert.deepEqual(projectFromId(id), { id, name: 'bot-a alpha/main', botId: 'bot-a', channelId: 'alpha', conversationId: 'alpha', threadId: 'main' });
    assert.notEqual(id, projectIdForEnvelope(envelope('x', 'y', { route: { channelId: 'alpha', threadId: 'side', senderId: 'a' } })));
    assert.notEqual(id, projectIdForEnvelope(envelope('x', 'y', { to: 'bot-b' })));
    assert.equal(projectFromId('other'), null);
    assert.equal(projectFromId('pibot:not-json'), null);
});
test('observation: humans count, worker traffic only moves the revision', () => {
    const base = { schemaVersion: '0.1', id: 'e', idempotencyKey: 'e', occurredAt: 'now', receivedAt: 'now', source: { provider: 'project', authority: 'project-host', conversationId: 'p' } };
    assert.deepEqual(observeProjectEvent({ ...base, type: 'project.message', payload: { text: 'hi', origin: { messageId: 'm', sender: { id: 'alice', kind: 'human' } } } }), { conversationId: 'p', kind: 'message', threadId: 'main', messageId: 'm', sender: { id: 'alice', kind: 'human' }, text: 'hi' });
    assert.equal(observeProjectEvent({ ...base, type: 'project.message', payload: { text: 'x', origin: { messageId: 'm', sender: { id: 'bot-b', kind: 'app' } } } })?.sender?.kind, 'app');
    const worker = observeProjectEvent({ ...base, type: 'project.worker.requested', payload: { workerId: 'w', task: 't' } });
    assert.deepEqual(worker?.sender, { id: 'w', kind: 'app' });
    assert.equal(worker?.threadId, 'main', 'a worker id is not a chat thread');
    assert.equal(observeProjectEvent({ ...base, type: 'project.goal.continue', payload: {} }), undefined);
});
test('coordinator delegates to a worker through project-host, and the result is replied through OpenMatter', async () => {
    const { host, sessions, delivered } = setup(delegateAndReply);
    const e = envelope('m1', 'how many things?');
    await host.submit(e);
    await until('reply', () => delivered.length === 1);
    const project = projectIdForEnvelope(e);
    const coordinator = sessions.find(s => s.role === 'coordinator')!, worker = sessions.find(s => s.role === 'worker')!;
    assert.match(coordinator.prompts[0]!, /how many things/);
    assert.match(worker.prompts[0]!, /count the things/);
    assert.match(worker.input.workThreadId!, /:worker:researcher$/, 'Thread = worker id');
    assert.notEqual(worker.input.sessionId, coordinator.input.sessionId);
    assert.match(coordinator.prompts[1]!, /coordinator-worker-result.*RESULT for: count/);
    // Workers have no way to talk to the user; only the coordinator has controls and reply.
    assert.deepEqual(worker.input.tools, []);
    assert.deepEqual(coordinator.input.tools.map(t => t.name).sort(), ['cancel_worker', 'complete_project', 'delegate_worker', 'pi-bot_message_reply', 'steer_worker']);
    // The target was bound by the host, from the message at the Turn's trigger.
    assert.deepEqual(delivered[0], { sourceMessageId: 'm1', conversationId: JSON.stringify(['bot-a', 'alpha', 'alpha']), threadId: 'main', text: 'The worker finished: 42', key: 'final' });
    await until('turns settled', async () => (await host.service.view(project)).pending === 0);
    const facts = await operationCalls(host, project);
    const turnIds = facts.turns.filter(t => t.allow.includes('pi-bot.message.reply')).map(t => t.id);
    assert.ok(turnIds.length >= 2, 'the kernel granted the reply to project Turns');
    const stored = (await Promise.all(turnIds.flatMap(id => ['call-1', 'call-2'].map(call => Effect.runPromise(host.service.store.getOperationCall(id, call)))))).filter(Boolean);
    const reply = stored.find(call => call!.operation === 'message.reply')!;
    assert.deepEqual(reply.result, { status: 'delivered', receipt: { outboxId: 'o1' } }, 'the kernel holds the call record and receipt');
    assert.equal(reply.state, 'completed');
    assert.ok(reply.conversation, 'the call was freshness guarded');
});
test('a stale reply is rejected by freshness: nothing is delivered and the newer message is returned', async () => {
    const started = gate();
    const results: any[] = [];
    let attempts = 0;
    const { host, sessions, delivered } = setup(async (session, prompt) => {
        if (session.role === 'worker')
            return session.say('worker result');
        if (prompt.includes('coordinator-worker-result')) {
            attempts++;
            if (attempts === 1) {
                started.open();
                await until('correction recorded', async () => {
                    const entries = await Effect.runPromise(host.service.store.listConversationEntries(conversationKeyOf(project), 0));
                    return entries.some(entry => entry.text === 'Correction: failures only');
                });
            }
            const first = await session.call('pi-bot_message_reply', { text: 'full stale report', key: 'r0' });
            results.push(first);
            // As the tool result tells it to: read the newer message, decide again, new key.
            if (first.status === 'conflict')
                results.push(await session.call('pi-bot_message_reply', { text: 'failures only: none', key: 'r1' }));
            return;
        }
        if (prompt.includes('Correction'))
            return;
        await session.call('delegate_worker', { worker_id: 'w', task: 'report' });
    });
    const e = envelope('m1', 'give me the report');
    const project = projectIdForEnvelope(e);
    await host.submit(e);
    await started.opened;
    await host.submit(envelope('m2', 'Correction: failures only'));
    await until('second reply', () => results.length === 2);
    assert.equal(results[0].status, 'conflict');
    assert.equal(results[0].effect, 'not-applied');
    assert.deepEqual(results[0].conflict.messages.map((m: any) => m.text), ['Correction: failures only']);
    assert.equal(results[1].status, 'delivered', 'having seen it, the coordinator may reply');
    assert.deepEqual(delivered.map(d => d.text), ['failures only: none'], 'the stale text never reached the channel');
    await until('correction Turn', () => sessions.some(s => s.role === 'coordinator' && s.prompts.some(p => p.startsWith('[trigger]') && p.includes('Correction'))));
});
test('worker traffic and a peer app message do not make a reply stale', async () => {
    const results: any[] = [];
    let release = gate();
    const { host, delivered } = setup(async (session, prompt) => {
        if (session.role !== 'coordinator')
            return;
        if (prompt.includes('hello')) {
            await release.opened;
            results.push(await session.call('pi-bot_message_reply', { text: 'hi', key: 'k' }));
        }
    });
    const e = envelope('m1', 'hello');
    await host.submit(e);
    await until('first entry', async () => (await Effect.runPromise(host.service.store.listConversationEntries(conversationKeyOf(projectIdForEnvelope(e)), 0))).length === 1);
    await host.submit(envelope('m2', 'peer chatter', { kind: 'bot', from: 'bot-b' }));
    await until('peer entry', async () => (await Effect.runPromise(host.service.store.listConversationEntries(conversationKeyOf(projectIdForEnvelope(e)), 0))).length === 2);
    release.open();
    await until('reply', () => results.length === 1);
    assert.equal(results[0].status, 'delivered');
    assert.equal(delivered.length, 1);
    release = gate();
});
test("workspace 'none' is the default: no workspace context, branch naming, or registry", async () => {
    let prompt = '';
    const { host, delivered } = setup(async (session, text) => {
        prompt = text;
        await session.call('pi-bot_message_reply', { text: 'ok', key: 'k' });
    });
    const e = envelope('m1', 'no repo here');
    await host.submit(e);
    await until('reply', () => delivered.length === 1);
    const id = projectIdForEnvelope(e);
    assert.equal(host.service.config(id)?.workspace, 'none');
    const view = await host.service.view(id);
    assert.equal(view.workspaces, undefined);
    assert.doesNotMatch(prompt, /project-workspaces/);
    assert.doesNotMatch(prompt, /openmatter\//);
    // Thread mode stays available for a repository-backed deployment.
    const threaded = setup(async (session, text) => {
        prompt = text;
        await session.call('pi-bot_message_reply', { text: 'ok', key: 'k' });
    }, { config: () => ({ workspace: 'thread' }) });
    await threaded.host.submit(e);
    await until('thread reply', () => threaded.delivered.length === 1);
    assert.match(prompt, /project-workspaces/);
});
test('steer_worker reaches a running worker live through Pi steer, and is a new Turn once it finished', async () => {
    const release = gate(), running = gate();
    let coordinatorActions = 0;
    const { host, sessions } = setup(async (session, prompt) => {
        if (session.role === 'worker') {
            if (prompt.includes('long task')) {
                running.open();
                await release.opened;
            }
            return session.say('worker output');
        }
        coordinatorActions++;
        if (coordinatorActions === 1)
            await session.call('delegate_worker', { worker_id: 'w', task: 'long task' });
        if (coordinatorActions === 2) {
            await running.opened;
            await session.call('steer_worker', { worker_id: 'w', instruction: 'change course' });
        }
    });
    await host.submit(envelope('m1', 'start'));
    await running.opened;
    await host.submit(envelope('m2', 'actually change course'));
    const worker = () => sessions.find(s => s.role === 'worker')!;
    await until('live steer', () => worker().steers.length === 1);
    assert.match(worker().steers[0]!, /change course/);
    assert.equal(worker().prompts.length, 1, 'no second prompt: the running Turn took it');
    const coordinator = sessions.find(s => s.role === 'coordinator')!;
    await until('coordinator told live', () => coordinator.prompts.some(p => /coordinator-worker-steer.*"status":"live"/.test(p)));
    release.open();
    await until('result', () => coordinator.prompts.some(p => p.includes('coordinator-worker-result')));
    // Idle worker now: the same control starts a Turn (the driver rejects / runtime reports idle).
    const before = worker().prompts.length;
    await Effect.runPromise(host.service.control(projectIdForEnvelope(envelope('m1', '')), undefined, 'after-finish').steer({ workerId: 'w', instruction: 'one more thing' }));
    await until('next worker Turn', () => worker().prompts.length === before + 1);
    assert.equal(worker().steers.length, 1);
    await until('reported queued', () => coordinator.prompts.some(p => /coordinator-worker-steer.*"status":"queued"/.test(p)));
});
test('cancel_worker cancels through the driver and tells the coordinator', async () => {
    const running = gate();
    let actions = 0;
    const { host, sessions } = setup(async (session) => {
        if (session.role === 'worker') {
            running.open();
            return new Promise<void>(resolve => setTimeout(resolve, 200));
        }
        actions++;
        if (actions === 1)
            await session.call('delegate_worker', { worker_id: 'w', task: 'slow' });
        if (actions === 2) {
            await running.opened;
            await session.call('cancel_worker', { worker_id: 'w', reason: 'not needed' });
        }
    });
    await host.submit(envelope('m1', 'start'));
    await running.opened;
    await host.submit(envelope('m2', 'stop it'));
    const coordinator = () => sessions.find(s => s.role === 'coordinator')!;
    await until('cancellation reported', () => coordinator().prompts.some(p => /coordinator-worker-cancellation.*"workerId":"w"/.test(p)));
});
test('BotRuntime with OpenMatter dispatch: no Pi lane wakes, replies land in the outbox and are delivered', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pibot-project-runtime-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    let legacyWakes = 0;
    const sessions: Session[] = [];
    let runtime!: BotRuntime;
    const host = new PiBotProjectHost({
        directory: join(directory, 'projects'), eventLeaseMs: 100, open: fakeOpen(delegateAndReply, sessions),
        reply: input => runtime.deliverProjectReply(input)
    });
    runtime = new BotRuntime(join(directory, 'bot.db'), async () => {
        legacyWakes++;
        throw new Error('the legacy lane must not start');
    }, { dispatch: host });
    cleanup.push(() => runtime.close());
    cleanup.push(() => host.close());
    host.start();
    const bot = runtime.createBot('main', 'Reply', 'alpha');
    const accepted = runtime.accept({ to: bot.id, text: 'how many?', key: 'q1', route: { channelId: 'alpha', threadId: 'main', senderId: 'alice' } });
    await until('outbox', () => runtime.store.list<Outbound>('outbox').length === 1);
    const out = runtime.store.list<Outbound>('outbox')[0]!;
    assert.equal(out.text, 'The worker finished: 42');
    assert.equal(out.replyTo, accepted.id);
    assert.deepEqual(out.route, accepted.route);
    const sent: string[] = [];
    await runtime.deliver(async o => {
        sent.push(o.text);
    });
    assert.deepEqual(sent, ['The worker finished: 42']);
    assert.equal(runtime.store.get<Envelope>('inbox', accepted.id)?.state, 'processed', 'OpenMatter holds the work');
    assert.equal(legacyWakes, 0);
    // A second accept of the same key stays idempotent; a restart re-submit is a no-op in OpenMatter.
    assert.equal(runtime.accept({ to: bot.id, text: 'how many?', key: 'q1', route: accepted.route }).id, accepted.id);
    await host.submit(accepted);
    await until('settled', async () => (await host.service.view(projectIdForEnvelope(accepted))).pending === 0);
    assert.equal(runtime.store.list<Outbound>('outbox').length, 1);
});
test('the daemon opts in with PI_BOT_PROJECT_HOST and otherwise keeps the native lanes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pibot-project-daemon-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const { PiBotDaemon } = await import('../src/daemon/core/daemon.ts');
    const factory = async () => {
        throw new Error('the native lane must not start under project-host');
    };
    const native = await PiBotDaemon.create({ dataDir: join(directory, 'native'), factory });
    assert.equal(native.projects, undefined);
    await native.close();
    process.env.PI_BOT_PROJECT_HOST = '1';
    try {
        const daemon = await PiBotDaemon.create({ dataDir: join(directory, 'projects'), factory });
        assert.ok(daemon.projects);
        const bot = daemon.runtime.createBot('main', 'x', 'alpha');
        const accepted = daemon.runtime.accept({ to: bot.id, text: 'hi', key: 'q', route: { channelId: 'alpha', threadId: 'main', senderId: 'a' } });
        await until('handed to OpenMatter', () => daemon.runtime.store.get<Envelope>('inbox', accepted.id)?.state === 'processed');
        await daemon.close();
    }
    finally {
        delete process.env.PI_BOT_PROJECT_HOST;
    }
});
