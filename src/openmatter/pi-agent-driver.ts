/**
 * An OpenMatter AgentDriver backed by a Pi SDK session. pi-bot has one turn
 * mode: an idle session starts a Turn with `prompt`; a running one takes the
 * input into the current Turn with `steer`. OpenMatter only defines the
 * driver interface (including the optional live `steer`); Pi lives here.
 */
import type { AgentSession as PiSession } from '@earendil-works/pi-coding-agent';
import type { ContextProjection } from '@openma/matter';
import { AgentDriverError, AgentSessionUnavailableError, createOpenMAEvent, type AgentDriver, type AgentSessionHandle, type OpenMAEvent } from '@openma/matter/agent';
import { Effect, Stream } from 'effect';

/** The part of a Pi session the driver uses. */
export type PiTurnSession = Pick<PiSession, 'prompt' | 'steer' | 'subscribe' | 'abort' | 'isStreaming'>;

/** Mirrors `AgentSteerInput`/`AgentSteerAck` from @openma/matter (>0.2.7). */
export interface PiSteerInput { readonly session: AgentSessionHandle; readonly sessionId: string; readonly turnId: string; readonly steerId: string; readonly context: ContextProjection }
export type PiSteerAck = { readonly status: 'accepted' } | { readonly status: 'rejected'; readonly reason: string };
export type PiAgentDriver = AgentDriver & { readonly steer: (input: PiSteerInput) => Effect.Effect<PiSteerAck, AgentDriverError> };

export interface PiAgentDriverOptions {
    readonly id: string;
    /** Opens the Pi session for one OpenMatter Session id. */
    readonly openSession: (sessionId: string) => Promise<PiTurnSession>;
    /** Projects a Turn's or steer's context into Pi input text. */
    readonly content?: (context: ContextProjection) => string;
}

const defaultContent = (context: ContextProjection) => context.items.map(item => typeof item.value === 'string' ? item.value : JSON.stringify(item.value)).join('\n\n');
const textOf = (message: any): string => typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('') : '';
const fail = (message: string) => (cause: unknown) => new AgentDriverError({ message, cause });

export function makePiAgentDriver(options: PiAgentDriverOptions): PiAgentDriver {
    const content = options.content ?? defaultContent;
    const sessions = new Map<string, Promise<PiTurnSession>>();
    const steered = new Set<string>();
    const session = (id: string) => {
        let open = sessions.get(id);
        if (!open) sessions.set(id, open = options.openSession(id));
        return open;
    };
    const known = (handle: AgentSessionHandle) => sessions.get(handle.id);
    return {
        id: options.id,
        capabilities: () => Effect.succeed({ resume: true, cancel: true, permissions: false, concurrentTurns: false, steering: true }),
        createSession: ({ sessionId }) => Effect.tryPromise({ try: () => session(sessionId).then(() => ({ id: sessionId })), catch: fail('Could not open Pi session') }),
        resumeSession: handle => known(handle) ? Effect.succeed(handle) : Effect.fail(new AgentSessionUnavailableError({ message: `Pi session is not open in this process: ${handle.id}` })),
        turn: input => Stream.async<OpenMAEvent, AgentDriverError>(emit => {
            let seq = input.afterSequence;
            const event = (type: string, data: Record<string, unknown>) => createOpenMAEvent({
                event_id: `${input.turnId}:${seq + 1}`, session_id: input.sessionId, turn_id: input.turnId, seq: ++seq, type,
                occurred_at: new Date().toISOString(), source: { kind: 'harness', harness: 'pi' }, data
            } as Parameters<typeof createOpenMAEvent>[0]) as OpenMAEvent;
            const prompt = content(input.context);
            let unsubscribe = () => {};
            let output = '';
            void (async () => {
                const pi = await session(input.session.id);
                let userMessages = 0;
                unsubscribe = pi.subscribe((e: any) => {
                    if (e.type === 'message_end' && e.message?.role === 'user') {
                        // The first user message is this Turn's prompt; later ones
                        // are steers the Pi agent consumed inside this Turn.
                        if (userMessages++ > 0) void emit.single(event('user.message', { text: textOf(e.message), steered: true }));
                    } else if (e.type === 'message_end' && e.message?.role === 'assistant') {
                        const text = textOf(e.message);
                        if (text) { output = text; void emit.single(event('agent.message', { text })); }
                    } else if (e.type === 'tool_execution_start') {
                        void emit.single(event('tool.started', { tool_call_id: e.toolCallId, name: e.toolName }));
                    } else if (e.type === 'tool_execution_end') {
                        void emit.single(event('tool.completed', { tool_call_id: e.toolCallId, name: e.toolName, is_error: e.isError }));
                    }
                });
                await pi.prompt(prompt);
                await emit.single(event('turn.completed', { output }));
                void emit.end();
            })().catch(cause => void emit.fail(new AgentDriverError({ message: 'Pi Turn failed', cause })));
            return Effect.sync(() => unsubscribe());
        }),
        steer: ({ session: handle, steerId, context }) => Effect.tryPromise({
            try: async (): Promise<PiSteerAck> => {
                const pi = await known(handle);
                if (!pi) return { status: 'rejected', reason: 'Pi session is not open in this process' };
                if (steered.has(steerId)) return { status: 'accepted' };
                if (!pi.isStreaming) return { status: 'rejected', reason: 'Pi session is idle' };
                steered.add(steerId);
                await pi.steer(content(context));
                return { status: 'accepted' };
            },
            catch: fail('Could not steer Pi session')
        }),
        respondToPermission: () => Effect.void,
        cancel: ({ session: handle }) => Effect.tryPromise({ try: async () => { await (await known(handle))?.abort(); }, catch: fail('Could not cancel Pi Turn') }),
        closeSession: handle => Effect.sync(() => { sessions.delete(handle.id); })
    } as PiAgentDriver;
}
