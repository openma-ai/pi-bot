import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBotProjectHost } from '../src/daemon/openmatter/project-host.ts';
import { envelopeSource, makePiBotCoordinatorActions } from '../src/daemon/openmatter/coordinator-actions.ts';
import { BotRuntime } from '../src/daemon/runtime/runtime.ts';
import { ProactiveService } from '../src/daemon/runtime/proactive.ts';
import type { PiConversation, PiConversationEvent, PiConversationInput, PiDriverTool } from '../src/pi/agent-driver.ts';
import type { Envelope, Job, Outbound } from '../src/daemon/runtime/store.ts';

type Session = { role: string; input: PiConversationInput; prompts: string[]; call(name: string, args: unknown): Promise<any> };
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const task of cleanup.splice(0).reverse())
        await task();
});
const until = async (what: string, ready: () => boolean | Promise<boolean>, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (!(await ready())) {
        if (Date.now() > deadline)
            throw new Error(`Timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

test('coordinator actions use the native runtime: ask_user, send_to_bot and a background job', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pibot-actions-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const sessions: Session[] = [];
    let runtime!: BotRuntime;
    const replies: string[] = [];
    let jobId = '';
    let peerId = '';
    const fakeOpen = async (role: string, input: PiConversationInput): Promise<PiConversation> => {
        const listeners = new Set<(event: PiConversationEvent) => void>();
        let calls = 0;
        const session: Session = { role, input, prompts: [], async call(name, args) {
            const tool: PiDriverTool | undefined = input.tools.find(t => t.name === name);
            if (!tool)
                throw new Error(`no tool ${name}: ${input.tools.map(t => t.name)}`);
            return tool.execute(`call-${++calls}`, args);
        } };
        sessions.push(session);
        return {
            get isStreaming() { return false; },
            prompt: async text => {
                session.prompts.push(text);
                if (role !== 'coordinator')
                    return;
                if (text.includes('use every feature')) {
                    try {
                        await session.call('ask_user', { question: 'Which one?', choices: ['a', 'b'], key: 'q1' });
                        await session.call('send_to_bot', { bot_id: peerId, text: 'peer hello', key: 's1' });
                        const job = await session.call('start_job', { task: 'compute the answer', key: 'j1' });
                        jobId = job.jobId;
                        await session.call('schedule_create', { prompt: 'later check', at: Date.now() + 60000, timezone: 'UTC', key: 'sched1' });
                    } catch (error) {
                        throw error;
                    }
                    return;
                }
                if (text.includes('jobId')) {
                    const result = await session.call('job_result', { job_id: jobId });
                    await session.call('pi-bot_message_reply', { text: `job said ${JSON.parse(result.text).text}`, key: 'r1' });
                    replies.push(result.text);
                }
            },
            steer: async () => {},
            drainSteers: () => [],
            abort: async () => {},
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            dispose: () => {}
        };
    };
    let host!: PiBotProjectHost;
    let proactive!: ProactiveService;
    host = new PiBotProjectHost({
        directory: join(directory, 'projects'), eventLeaseMs: 100,
        open: fakeOpen,
        reply: input => runtime.deliverProjectReply(input),
        source: envelopeSource(() => runtime),
        actions: makePiBotCoordinatorActions({
            runtime: () => runtime,
            proactive: () => proactive,
            openJob: async () => {
                await new Promise(resolve => setTimeout(resolve, 150));
                return 'BACKGROUND-42';
            }
        })
    });
    runtime = new BotRuntime(join(directory, 'bot.db'), async () => {
        throw new Error('native lane must not start');
    }, { dispatch: host });
    proactive = new ProactiveService(runtime, {});
    cleanup.push(() => proactive.close());
    cleanup.push(() => runtime.close());
    cleanup.push(() => host.close());
    host.start();
    const a = runtime.createBot('a', 'Coordinator', 'alpha');
    const b = runtime.createBot('b', 'Peer', 'alpha');
    peerId = b.id;
    const route = { channelId: 'alpha', threadId: 'main', senderId: 'alice' };
    const first = runtime.accept({ to: a.id, text: 'use every feature', key: 'q1', route });
    await until('reply', () => runtime.store.list<Outbound>('outbox').length >= 1);
    assert.ok(runtime.store.list<Outbound>('outbox').some(o => o.text.includes('Which one?')), 'ask_user is projected to the user');
    assert.equal(runtime.store.list<any>('questions').filter(q => q.state === 'pending').length, 1);
    await until('schedule created', () => runtime.store.list<any>('schedules').some(s => s.key === 'sched1'));
    await until('job started', () => runtime.store.list<Job>('jobs').length === 1);
    const jobs = runtime.store.list<Job>('jobs');
    await until('job completed', () => runtime.store.get<Job>('jobs', jobs[0]!.id)?.state === 'completed');
    assert.match(runtime.store.get<Job>('jobs', jobs[0]!.id)?.result ?? '', /BACKGROUND-42/);
    await until('job result reply', () => runtime.store.list<Outbound>('outbox').some(o => o.text.includes('BACKGROUND-42')));
    // The job completion came back through pi-bot's inbox, not an OpenMatter worker.
    assert.ok(runtime.store.list<Envelope>('inbox').some(e => e.kind === 'job' && e.to === a.id && e.replyTo === first.id));
    // send_to_bot reached the teammate's own project.
    await until('peer envelope', () => runtime.store.list<Envelope>('inbox').some(e => e.from === a.id && e.to === b.id && e.text === 'peer hello'));
    await until('peer coordinator woke', () => sessions.some(s => s.role === 'coordinator' && s.prompts.some(p => p.includes('peer hello'))));
    assert.ok(replies.length >= 1);
});
