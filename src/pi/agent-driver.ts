import { createHash } from 'node:crypto';
import { Effect, Stream } from 'effect';
import type { ContextProjection, JsonValue } from '@openma/matter';
import { AgentDriverError, AgentSessionUnavailableError, createOpenMAEvent, OPERATION_CALL_METHOD, type AgentDriver, type AgentSessionHandle, type AgentTool, type AgentTurnInput, type OpenMAEvent } from '@openma/matter/agent';
/**
 * Pi as an OpenMatter Agent, for both the coordinator and its workers. OpenMatter
 * sees only the AgentDriver contract and never the Pi SDK: Turn -> Pi prompt,
 * steer -> Pi steer, an allowed operation -> a Pi tool whose call is answered by
 * the runtime through the callback channel.
 */
/** A provider-safe tool the Agent can call. */
export type PiDriverTool = {
    name: string;
    description: string;
    parameters: JsonValue;
    execute(toolCallId: string, args: unknown, signal?: AbortSignal): Promise<JsonValue>;
};
export type PiConversationEvent = {
    type: 'assistant_message';
    text: string;
    hasToolCalls: boolean;
    stopReason?: string;
    errorMessage?: string;
} | {
    type: 'tool_start';
    toolCallId: string;
    toolName: string;
    args: unknown;
} | {
    type: 'tool_end';
    toolCallId: string;
    toolName: string;
    isError: boolean;
    text: string;
};
/** The part of a Pi session the driver needs; a session adapter or a test double. */
export interface PiConversation {
    readonly isStreaming: boolean;
    prompt(text: string): Promise<void>;
    steer(text: string): Promise<void>;
    /** Takes steers Pi queued but did not reach before its final queue check. */
    drainSteers(): string[];
    abort(): Promise<void>;
    subscribe(listener: (event: PiConversationEvent) => void): () => void;
    dispose(): Promise<void> | void;
}
export type PiConversationInput = {
    sessionId: string;
    scopeId?: string;
    workThreadId?: string;
    tools: PiDriverTool[];
};
export type PiAgentDriverOptions = {
    id: string;
    open(input: PiConversationInput): Promise<PiConversation>;
    /** False when a Session with this id can no longer be reopened. */
    canResume?(sessionId: string): boolean;
    /** Tools the host binds to the Session, such as coordinator controls. */
    hostTools?(session: { sessionId: string; scopeId?: string; workThreadId?: string }): PiDriverTool[];
    /** A worker returns its result to the coordinator instead of calling operations. */
    exposeOperations?: boolean;
    render?(context: ContextProjection, seen: Set<string>): string;
    /** Observation point before a call reaches the runtime; awaited. */
    beforeOperationCall?(tool: AgentTool, input: unknown): Promise<void>;
    clock?(): string;
};
const ROUTING_KINDS = new Set(['coordinator-association']);
const withoutAttachmentData = (value: unknown): unknown => {
    if (Array.isArray(value))
        return value.map(withoutAttachmentData);
    if (typeof value !== 'object' || value === null)
        return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => k === 'data' && typeof v === 'string' && v.length > 1024 ? [k, '[attachment data omitted]'] : [k, withoutAttachmentData(v)]));
};
const triggerText = (value: unknown) => {
    const event = value as { type?: string; payload?: Record<string, unknown> } | null;
    const payload = event?.payload;
    return { type: event?.type, text: payload?.text ?? payload?.task ?? payload?.instruction ?? payload?.summary ?? payload?.reason, ...(payload?.workerId ? { workerId: payload.workerId } : {}), ...(payload?.origin ? { origin: payload.origin } : {}) };
};
/** What the Agent reads for a Turn. Repeated project context is sent once per Session. */
export function renderTurnPrompt(context: ContextProjection, seen: Set<string> = new Set()) {
    const parts: string[] = [];
    for (const item of context.items) {
        if (ROUTING_KINDS.has(item.kind))
            continue;
        if (item.kind === 'event') {
            parts.unshift(`[trigger] ${JSON.stringify(withoutAttachmentData(triggerText(item.value)))}`);
            continue;
        }
        const body = typeof item.value === 'string' ? item.value : JSON.stringify(withoutAttachmentData(item.value));
        if (!body)
            continue;
        const key = createHash('sha256').update(JSON.stringify([item.id, body])).digest('hex');
        if (item.kind.startsWith('project-') && seen.has(key))
            continue;
        seen.add(key);
        parts.push(`[${item.kind}] ${body}`);
    }
    return parts.join('\n');
}
/** Single-consumer async queue that bridges Pi's callbacks into the Turn's Stream. */
class EventQueue<T> implements AsyncIterableIterator<T> {
    private items: T[] = [];
    private waiter: ((result: IteratorResult<T>) => void) | undefined;
    private ended = false;
    constructor(private readonly onReturn: () => void) { }
    push(item: T) {
        if (this.ended)
            return;
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = undefined;
            waiter({ value: item, done: false });
        }
        else
            this.items.push(item);
    }
    end() {
        this.ended = true;
        this.waiter?.({ value: undefined, done: true });
        this.waiter = undefined;
    }
    next(): Promise<IteratorResult<T>> {
        const item = this.items.shift();
        if (item !== undefined)
            return Promise.resolve({ value: item, done: false });
        if (this.ended)
            return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => {
            this.waiter = resolve;
        });
    }
    return(): Promise<IteratorResult<T>> {
        this.onReturn();
        this.end();
        return Promise.resolve({ value: undefined, done: true });
    }
    [Symbol.asyncIterator]() {
        return this;
    }
}
type ActiveTurn = {
    turnId: string;
    tools: Map<string, AgentTool>;
    push(type: string, data: Record<string, unknown>, suffix: string): void;
    settled: boolean;
    cancelled: boolean;
    steers: Set<string>;
    callbacks: Map<string, (result: JsonValue) => void>;
};
type SessionState = {
    id: string;
    scopeId?: string;
    workThreadId?: string;
    conversation?: Promise<PiConversation>;
    toolNames?: string;
    turn?: ActiveTurn;
    seen: Set<string>;
};
const toolName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');
const driverError = (message: string, cause: unknown) => new AgentDriverError({ message, cause });
export function makePiAgentDriver(options: PiAgentDriverOptions): AgentDriver {
    const sessions = new Map<string, SessionState>();
    const clock = options.clock ?? (() => new Date().toISOString());
    const render = options.render ?? renderTurnPrompt;
    const state = (handle: AgentSessionHandle): SessionState => {
        const known = sessions.get(handle.id);
        if (known)
            return known;
        const raw = (handle.raw ?? {}) as { scopeId?: string; workThreadId?: string };
        const created: SessionState = { id: handle.id, ...(raw.scopeId ? { scopeId: raw.scopeId } : {}), ...(raw.workThreadId ? { workThreadId: raw.workThreadId } : {}), seen: new Set() };
        sessions.set(handle.id, created);
        return created;
    };
    const operationTool = (session: SessionState, tool: AgentTool): PiDriverTool => ({
        name: toolName(tool.name), description: tool.description, parameters: tool.inputSchema,
        async execute(toolCallId, args, signal) {
            const turn = session.turn;
            // Tools outlive a Turn on the Pi session; each call uses the current Turn's grant.
            const granted = turn?.tools.get(tool.name);
            if (!turn || !granted)
                return { status: 'refused', reason: `Operation is not allowed for this Turn: ${tool.name}` };
            await options.beforeOperationCall?.(granted, args);
            const params = { integrationId: granted.integrationId, operation: granted.operation, input: args as JsonValue };
            const answer = new Promise<JsonValue>((resolve, reject) => {
                turn.callbacks.set(toolCallId, resolve);
                signal?.addEventListener('abort', () => reject(new Error('Tool call aborted')), { once: true });
            });
            turn.push('callback.requested', {
                callback_id: toolCallId,
                fingerprint: createHash('sha256').update(JSON.stringify([turn.turnId, toolCallId, params])).digest('hex'),
                method: OPERATION_CALL_METHOD, category: 'extension', params
            }, `call:${toolCallId}`);
            return answer;
        }
    });
    const conversationFor = (session: SessionState, tools: readonly AgentTool[]) => {
        const hostTools = options.hostTools?.({ sessionId: session.id, ...(session.scopeId ? { scopeId: session.scopeId } : {}), ...(session.workThreadId ? { workThreadId: session.workThreadId } : {}) }) ?? [];
        const operations = options.exposeOperations === false ? [] : tools.map(tool => operationTool(session, tool));
        const all = [...hostTools, ...operations];
        const names = JSON.stringify(all.map(tool => tool.name).sort());
        if (session.conversation && session.toolNames === names)
            return session.conversation;
        // Pi fixes its tools when a session opens; a changed grant reopens the same Session.
        const previous = session.conversation;
        session.toolNames = names;
        session.conversation = (async () => {
            await (await previous?.catch(() => undefined))?.dispose();
            return options.open({ sessionId: session.id, ...(session.scopeId ? { scopeId: session.scopeId } : {}), ...(session.workThreadId ? { workThreadId: session.workThreadId } : {}), tools: all });
        })();
        return session.conversation;
    };
    const runTurn = async (input: AgentTurnInput, session: SessionState, turn: ActiveTurn, queue: EventQueue<OpenMAEvent>) => {
        let failure: string | undefined;
        let unsubscribe: (() => void) | undefined;
        try {
            const conversation = await conversationFor(session, input.tools ?? []);
            unsubscribe = conversation.subscribe(event => {
                if (session.turn !== turn)
                    return;
                if (event.type === 'tool_start')
                    turn.push('tool.started', { tool_call_id: event.toolCallId, tool_name: event.toolName, status: 'running', raw_input: (event.args ?? null) as JsonValue }, `tool:${event.toolCallId}:start`);
                else if (event.type === 'tool_end')
                    turn.push(event.isError ? 'tool.failed' : 'tool.completed', { tool_call_id: event.toolCallId, tool_name: event.toolName, status: event.isError ? 'failed' : 'completed', raw_output: event.text }, `tool:${event.toolCallId}:end`);
                else {
                    if (event.stopReason === 'error')
                        failure = event.errorMessage ?? 'Model error';
                    if (event.text)
                        turn.push('agent.message', { text: event.text, phase: event.hasToolCalls ? 'commentary' : 'final_answer' }, `message:${crypto.randomUUID()}`);
                }
            });
            let text: string | undefined = render(input.context, session.seen);
            while (text !== undefined) {
                await conversation.prompt(text);
                // Settled and drain are one synchronous step: an accepted steer either
                // reached Pi, is drained here, or was rejected because the Turn settled.
                turn.settled = true;
                const left: string[] = turn.cancelled ? [] : conversation.drainSteers();
                text = undefined;
                if (left.length > 0) {
                    turn.settled = false;
                    text = left.join('\n');
                }
            }
        }
        catch (cause) {
            failure = cause instanceof Error ? cause.message : String(cause);
        }
        finally {
            turn.settled = true;
            unsubscribe?.();
        }
        if (turn.cancelled)
            turn.push('turn.cancelled', { reason: 'Cancelled' }, 'terminal');
        else if (failure !== undefined)
            turn.push('turn.failed', { error: failure }, 'terminal');
        else
            turn.push('turn.completed', {}, 'terminal');
        if (session.turn === turn)
            delete session.turn;
        queue.end();
    };
    return {
        id: options.id,
        capabilities: () => Effect.succeed({ resume: true, cancel: true, permissions: false, concurrentTurns: false, operations: true, steering: true }),
        createSession: input => Effect.sync(() => {
            const handle = { id: input.sessionId, raw: { ...(input.scopeId ? { scopeId: input.scopeId } : {}), ...(input.workThreadId ? { workThreadId: input.workThreadId } : {}) } };
            state(handle);
            return handle;
        }),
        resumeSession: handle => options.canResume && !options.canResume(handle.id)
            ? Effect.fail(new AgentSessionUnavailableError({ message: `Pi session is gone: ${handle.id}` }))
            : Effect.sync(() => {
                state(handle);
                return handle;
            }),
        turn: input => Stream.suspend(() => {
            const session = state(input.session);
            let seq = input.afterSequence;
            const event = (type: string, data: Record<string, unknown>, suffix: string) => createOpenMAEvent({
                event_id: `${input.turnId}:${suffix}`, session_id: input.sessionId, turn_id: input.turnId, seq: ++seq, type, occurred_at: clock(),
                source: { kind: 'harness', harness: options.id }, data
            } as Parameters<typeof createOpenMAEvent>[0]) as OpenMAEvent;
            // A Pi run cannot rejoin after its process died. Anything the Agent did through
            // the runtime is recorded; report the gap rather than thinking twice.
            if (input.afterSequence > 0 && session.turn?.turnId !== input.turnId)
                return Stream.make(event('turn.interrupted', { reason: 'The Pi run did not survive; this Turn cannot be resumed' }, `interrupted:${seq + 1}`));
            if (session.turn && !session.turn.settled)
                return Stream.fail(new AgentDriverError({ message: `Pi session already has a running Turn: ${session.turn.turnId}` }));
            const queue = new EventQueue<OpenMAEvent>(() => {
                const running = session.turn;
                if (running?.turnId !== input.turnId || running.settled)
                    return;
                running.cancelled = true;
                void session.conversation?.then(conversation => conversation.abort()).catch(() => { });
            });
            const turn: ActiveTurn = {
                turnId: input.turnId, tools: new Map((input.tools ?? []).map(tool => [tool.name, tool])), settled: false, cancelled: false, steers: new Set(), callbacks: new Map(),
                push: (type, data, suffix) => queue.push(event(type, data, suffix))
            };
            session.turn = turn;
            void runTurn(input, session, turn, queue);
            return Stream.fromAsyncIterable(queue, cause => driverError('Pi Turn stream failed', cause));
        }),
        respondToPermission: () => Effect.void,
        respondToCallback: input => Effect.sync(() => {
            const turn = state(input.session).turn;
            const answer = turn?.callbacks.get(input.callbackId);
            turn?.callbacks.delete(input.callbackId);
            answer?.(input.result);
        }),
        steer: input => Effect.tryPromise({
            try: async () => {
                const session = state(input.session);
                const turn = session.turn;
                if (!turn || turn.turnId !== input.turnId || turn.settled || turn.cancelled)
                    return { status: 'rejected' as const, reason: 'Turn is not running' };
                if (turn.steers.has(input.steerId))
                    return { status: 'accepted' as const };
                const conversation = await session.conversation;
                // The await above can cross the Turn's end.
                if (!conversation || turn.settled || turn.cancelled)
                    return { status: 'rejected' as const, reason: 'Turn is not running' };
                turn.steers.add(input.steerId);
                try {
                    await conversation.steer(render(input.context, session.seen));
                }
                catch (cause) {
                    turn.steers.delete(input.steerId);
                    throw cause;
                }
                return { status: 'accepted' as const };
            },
            catch: cause => driverError('Pi steer failed', cause)
        }),
        cancel: input => Effect.tryPromise({
            try: async () => {
                const session = state(input.session);
                const turn = session.turn;
                if (!turn || turn.turnId !== input.turnId || turn.settled || turn.cancelled)
                    return;
                turn.cancelled = true;
                await (await session.conversation)?.abort();
            },
            catch: cause => driverError('Pi cancel failed', cause)
        }),
        closeSession: handle => Effect.tryPromise({
            try: async () => {
                const session = sessions.get(handle.id);
                sessions.delete(handle.id);
                await (await session?.conversation)?.dispose();
            },
            catch: cause => driverError('Pi session close failed', cause)
        })
    };
}
