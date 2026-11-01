/**
 * Real-model e2e of IM -> OpenMatter project-host -> pi-bot. DeepSeek deepseek-flash only.
 *   node --import tsx examples/openmatter-project-host-e2e.ts
 * A simulated-IM message reaches a real coordinator, which delegates to a real
 * worker; the result is replied through OpenMatter; a correction written while
 * the coordinator is busy is steered into its running Turn; a worker is
 * cancelled through OpenMatter; and a fresh host resumes the durable Session.
 * Prints no secrets.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { conversationKeyOf, COORDINATOR_PROMPT, JOB_PROMPT, PiBotProjectHost, projectIdForEnvelope, WORKER_PROMPT } from '../src/daemon/openmatter/project-host.ts';
import { envelopeSource, makePiBotCoordinatorActions } from '../src/daemon/openmatter/coordinator-actions.ts';
import { ProactiveService } from '../src/daemon/runtime/proactive.ts';
import { canResumePiConversation, openPiConversation } from '../src/pi/agent-driver-session.ts';
import { configureSmokeProvider, SMOKE_PROVIDER } from '../src/evals/smoke-provider.ts';
import type { Outbound } from '../src/daemon/runtime/store.ts';
const MODEL = 'deepseek-flash';
const key = process.env.DEEPSEEK_API_KEY;
if (!key)
    throw Error('DEEPSEEK_API_KEY required');
const started = Date.now();
const log = (label: string, value?: unknown) => console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${label}${value === undefined ? '' : ' ' + JSON.stringify(value)}`);
const section = (title: string) => console.log(`\n===== ${title} =====`);
const until = async (what: string, ready: () => boolean | Promise<boolean>, ms = 240000) => {
    const deadline = Date.now() + ms;
    while (!(await ready())) {
        if (Date.now() > deadline)
            throw Error(`Timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
};
const dir = await mkdtemp(join(tmpdir(), 'pi-bot-om-project-e2e-'));
const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
const model = configureSmokeProvider(models, MODEL);
await models.setRuntimeApiKey(SMOKE_PROVIDER, key);
let runtime!: BotRuntime;
let proactive!: ProactiveService;
let host!: PiBotProjectHost;
let onReplyCall: (input: { text?: string; key?: string }) => Promise<void> = async () => { };
const backlog: { project: string; messageIds: string[]; outcome: string }[] = [];
const openJob = async (input: { sessionId: string; task: string }) => {
    const conversation = await openPiConversation({ dir: join(dir, 'pi', 'job'), modelRuntime: models, model, systemPrompt: JOB_PROMPT }, { sessionId: input.sessionId, tools: [] });
    let final = '';
    conversation.subscribe(event => {
        if (event.type === 'assistant_message' && !event.hasToolCalls && event.text)
            final = event.text;
    });
    try {
        await conversation.prompt(input.task);
        return final || 'Job finished without a textual result.';
    }
    finally {
        await conversation.dispose();
    }
};
const makeHost = () => new PiBotProjectHost({
    directory: join(dir, 'projects'), eventLeaseMs: 3000,
    reply: input => {
        const receipt = runtime.deliverProjectReply(input);
        log('[OpenMatter deliver -> pi-bot outbox]', { sourceMessageId: input.sourceMessageId, key: input.key, text: input.text, receipt });
        return receipt;
    },
    source: envelopeSource(() => runtime),
    actions: makePiBotCoordinatorActions({
        runtime: () => runtime,
        proactive: () => proactive,
        openJob
    }),
    canResume: (role, id) => canResumePiConversation(join(dir, 'pi', role), id),
    onBacklog: input => {
        backlog.push({ project: input.project.id, messageIds: input.messageIds, outcome: input.outcome });
        log('[backlog]', { messageIds: input.messageIds, outcome: input.outcome });
    },
    beforeOperationCall: async (tool, input) => {
        log(`[coordinator calls ${tool.name}]`, input);
        await onReplyCall(input as { text?: string; key?: string });
    },
    open: async (role, input) => {
        log(`[open Pi session] role=${role}`, { sessionId: input.sessionId, workThreadId: input.workThreadId, tools: input.tools.map(t => t.name) });
        const conversation = await openPiConversation({ dir: join(dir, 'pi', role), modelRuntime: models, model, systemPrompt: role === 'coordinator' ? COORDINATOR_PROMPT : WORKER_PROMPT }, input);
        conversation.subscribe(event => {
            if (event.type === 'tool_start')
                log(`[${role} tool start] ${event.toolName}`, event.args);
            else if (event.type === 'tool_end')
                log(`[${role} tool end] ${event.toolName} isError=${event.isError}`, event.text.slice(0, 600));
            else if (event.text)
                log(`[${role} assistant] stop=${event.stopReason}`, event.text.slice(0, 600));
            else if (event.stopReason === 'error')
                log(`[${role} provider error]`, event.errorMessage);
        });
        return conversation;
    }
});
const boot = () => {
    runtime = new BotRuntime(join(dir, 'bot.db'), async () => {
        throw Error('The native lane must not run under project-host');
    }, { dispatch: host });
    proactive = new ProactiveService(runtime, {});
    runtime.start();
};
host = makeHost();
boot();
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
    log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail);
    if (!ok)
        failures.push(name);
};
const outbox = () => runtime.store.list<Outbound>('outbox');
const route = { channelId: 'alpha', threadId: 'main', senderId: 'alice' };
try {
    host.start();
    const bot = runtime.createBot('main', 'Coordinator', 'alpha');
    section(`SETUP model=${MODEL} provider=${SMOKE_PROVIDER}`);
    section('SCENARIO 1: IM message -> coordinator delegates -> worker -> reply through OpenMatter');
    const first = runtime.accept({ to: bot.id, text: 'Please delegate this to a worker with worker_id "calc": compute 17 * 23 and return only the number. When the worker result arrives, tell me the number with pi-bot_message_reply.', key: 'q1', route });
    log('[IM -> pi-bot accept]', { id: first.id, text: first.text });
    const project = projectIdForEnvelope(first);
    log('[project]', { id: project, config: { workspace: host.service.config(project)?.workspace, controls: host.service.config(project)?.controls } });
    await until('first reply', () => outbox().length >= 1);
    const sent = outbox()[0]!;
    check('reply landed in the pi-bot outbox', sent.replyTo === first.id, { text: sent.text, replyTo: sent.replyTo });
    check('worker result reached the user', sent.text.includes('391'), sent.text);
    await until('scenario 1 settled', async () => (await host.service.view(project)).pending === 0);
    await runtime.deliver(async o => log('[channel delivery]', { id: o.id, route: o.route, text: o.text }));
    const dump = async (title: string, since = 0) => {
        const facts = await Effect.runPromise(host.service.store.inspectScope(project));
        section(title);
        for (const session of facts.sessions)
            log('[session]', { workThreadId: session.workThreadId, agentId: session.agentId, driverId: session.driverId, state: session.state });
        for (const turn of facts.turns.slice(since))
            log('[turn]', { id: turn.id, session: facts.sessions.find(s => s.id === turn.sessionId)?.workThreadId, trigger: turn.triggerEventId, state: turn.state, allow: turn.allow });
        return facts;
    };
    const facts1 = await dump('OpenMatter facts after scenario 1');
    check('coordinator and worker are separate OpenMatter sessions', facts1.sessions.some(s => s.workThreadId.endsWith(':coordinator')) && facts1.sessions.some(s => s.workThreadId.endsWith(':worker:calc')), facts1.sessions.map(s => s.workThreadId));
    check("workspace 'none': no workspace registry", (await host.service.view(project)).workspaces === undefined);

    section('SCENARIO 2: corrections arrive as the coordinator replies -> live backlog merge + freshness');
    const before = outbox().length;
    const turnsBefore = facts1.turns.length;
    let injectedIds: string[] = [];
    onReplyCall = async () => {
        if (injectedIds.length)
            return;
        const correction = runtime.accept({ to: bot.id, text: 'Correction: I meant 18 * 23, not 19 * 23. Answer that instead.', key: 'q2-correction', route });
        const extra = runtime.accept({ to: bot.id, text: 'Please answer with only the resulting number, 414.', key: 'q2-extra', route });
        injectedIds = [correction.id, extra.id];
        log('[IM -> user corrections arrive before the reply executes]', { ids: injectedIds });
        await until('corrections in the OpenMatter log', async () => {
            const entries = await Effect.runPromise(host.service.store.listConversationEntries(conversationKeyOf(project), 0));
            return injectedIds.every(id => entries.some(entry => entry.messageId === id));
        });
        log('[corrections recorded in the OpenMatter conversation log]');
    };
    const second = runtime.accept({ to: bot.id, text: 'New request. Delegate to worker_id "calc2": compute 19 * 23 and return only the number. When the worker result arrives, tell me the number with pi-bot_message_reply.', key: 'q2', route });
    log('[IM -> pi-bot accept]', { id: second.id, text: second.text });
    await until('correction delivered', () => outbox().slice(before).some(o => o.text.includes('414')));
    await until('scenario 2 settled', async () => (await host.service.view(project)).pending === 0);
    await runtime.deliver(async o => log('[channel delivery]', { id: o.id, text: o.text }));
    check('busy coordinator received a live backlog steer', backlog.some(item => item.outcome === 'steered' && item.messageIds.length === 2), backlog);
    const facts2 = await dump('OpenMatter facts after scenario 2', turnsBefore);
    section('OpenMatter operation calls (kernel records)');
    const calls = [];
    for (const turn of facts2.turns) {
        for (const event of await Effect.runPromise(host.service.store.getAgentEvents(turn.id))) {
            if (event.type !== 'callback.requested')
                continue;
            const call = await Effect.runPromise(host.service.store.getOperationCall(turn.id, (event.data as { callback_id: string }).callback_id));
            if (call) {
                calls.push(call);
                log('[operation call]', { turnId: call.turnId, callId: call.callId, op: `${call.integrationId}.${call.operation}`, text: (call.input as { text?: string } | null)?.text, sourceMessageId: (call.input as { sourceMessageId?: string } | null)?.sourceMessageId, checkedAtRevision: call.conversation?.revision ?? null, state: call.state, result: call.result });
            }
        }
    }
    const conflicts = calls.filter(call => call.result?.status === 'conflict');
    const staleAnswer = '437';
    check('a stale reply got a freshness conflict', conflicts.length >= 1, conflicts.map(call => call.result));
    check('conflict was not applied', conflicts.every(call => call.result?.status === 'conflict' && call.result.effect === 'not-applied'));
    check('conflict returned the corrections to the Agent', conflicts.some(call => call.result?.status === 'conflict' && call.result.conflict.reason === 'newer_messages' && call.result.conflict.messages.some(m => m.messageId === injectedIds[0])));
    const staleTexts = conflicts.map(call => (call.input as { text?: string }).text);
    check('the Agent really tried to send the stale answer', staleTexts.some(text => text?.includes(staleAnswer)), { staleTexts });
    check('stale text never reached the channel', outbox().every(o => !staleTexts.includes(o.text) && !o.text.includes(staleAnswer)), { staleTexts });
    check('corrected answer reached the channel', outbox().some(o => o.text.includes('414')));

    section('SCENARIO 3: cancel a running worker through OpenMatter');
    const beforeCancelTurns = (await Effect.runPromise(host.service.store.inspectScope(project))).turns.length;
    await Effect.runPromise(host.service.control(project, undefined, 'e2e-cancel-delegate').delegate({ workerId: 'slow', task: 'Write a long detailed essay about number theory. Do not finish quickly; produce many paragraphs before stopping.' }));
    const slowSession = async () => {
        const facts = await Effect.runPromise(host.service.store.inspectScope(project));
        return facts.sessions.find(session => session.workThreadId.endsWith(':worker:slow'));
    };
    await until('slow worker running', async () => {
        const facts = await Effect.runPromise(host.service.store.inspectScope(project));
        const session = facts.sessions.find(item => item.workThreadId.endsWith(':worker:slow'));
        return !!session && facts.turns.some(turn => turn.sessionId === session.id && turn.state === 'running');
    });
    const cancellation = await Effect.runPromise(host.service.control(project, undefined, 'e2e-cancel').cancel({ workerId: 'slow', reason: 'e2e cancellation' }));
    check('cancel was accepted by OpenMatter', cancellation.status === 'accepted', cancellation);
    await until('worker cancelled', async () => {
        const facts = await Effect.runPromise(host.service.store.inspectScope(project));
        const session = facts.sessions.find(item => item.workThreadId.endsWith(':worker:slow'));
        return !!session && facts.turns.some(turn => turn.sessionId === session.id && turn.state === 'cancelled');
    });
    const facts3 = await dump('OpenMatter facts after cancellation', beforeCancelTurns);
    check('cancellation produced a cancelled worker Turn', await slowSession() !== undefined && facts3.turns.some(turn => turn.state === 'cancelled'));

    section('SCENARIO 4: restart the host/runtime and resume the durable Session');
    const outboxBeforeRestart = outbox().length;
    await host.close();
    runtime.close();
    await proactive.close();
    host = makeHost();
    boot();
    host.start();
    const resumedBot = runtime.store.list<{ id: string }>('bots').find(b => b.id === bot.id)!;
    const resumed = runtime.accept({ to: resumedBot.id, text: 'Repeat the last number you told me, using pi-bot_message_reply. Only the number.', key: 'q4', route });
    log('[IM -> pi-bot accept after restart]', { id: resumed.id });
    await until('reply after restart', () => outbox().length > outboxBeforeRestart);
    const resumedReply = outbox().at(-1)!;
    check('a fresh runtime resumed the coordinator Session and replied', resumedReply.text.includes('414'), resumedReply.text);
    check('resume reopened a durable Pi session directory', canResumePiConversation(join(dir, 'pi', 'coordinator'), (await Effect.runPromise(host.service.store.inspectScope(project))).sessions.find(s => s.workThreadId.endsWith(':coordinator'))!.id));

    section('CONVERSATION LOG (OpenMatter)');
    for (const entry of await Effect.runPromise(host.service.store.listConversationEntries(conversationKeyOf(project), 0)))
        log('[entry]', { revision: entry.revision, sender: entry.sender, messageId: entry.messageId, text: entry.text?.slice(0, 100) });
    section('OUTBOX (what the user saw)');
    for (const o of outbox())
        log('[outbox]', { text: o.text, state: o.state, replyTo: o.replyTo });
    section(failures.length ? `RESULT: FAILED ${JSON.stringify(failures)}` : 'RESULT: ALL CHECKS PASSED');
}
finally {
    await host.close();
    await runtime.close();
    await proactive.close();
    await rm(dir, { recursive: true, force: true });
}
if (failures.length)
    process.exitCode = 1;
