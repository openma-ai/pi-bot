import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionFactory, ExtensionContext, BoundaryResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
export interface SummarySnapshot {
    sessionId: string;
    messages: AgentMessage[];
    state: unknown;
    signal: AbortSignal;
}
export interface ContextOptions {
    getState: () => unknown;
    maxContextTokens?: number;
    outputReserveTokens?: number;
    recentMessages?: number;
    summarize?: (snapshot: SummarySnapshot) => Promise<string>;
    summaryTimeoutMs?: number;
    /** Blocking projection failures only; the host should leave the inbox recoverable. */
    onError?: (error: Error) => void;
    /** Observational only: a background failure must never fail a foreground wake. */
    onSummaryError?: (error: Error) => void;
}
export class ContextBudgetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ContextBudgetError';
    }
}
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
// Conservative, tokenizer-independent ceiling for text/tool JSON. Image inputs require
// a provider-specific bound and are rejected below rather than undercounted.
export const estimateContextTokens = (messages: readonly AgentMessage[]): number => messages.reduce((sum, message) => sum + bytes(message) + 32, 0);
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hasImages = (message: AgentMessage): boolean => Array.isArray((message as any).content) &&
    (message as any).content.some((part: any) => part.type === 'image');
const calls = (message: AgentMessage): string[] => message.role === 'assistant'
    ? message.content.filter(part => part.type === 'toolCall').map(part => part.id) : [];
interface Group {
    messages: AgentMessage[];
    valid: boolean;
    start: number;
}
/** Never split an assistant's parallel tool-call batch from its results. */
function groups(messages: readonly AgentMessage[]): Group[] {
    const result: Group[] = [];
    for (let i = 0; i < messages.length;) {
        const start = i;
        const message = messages[i++]!;
        const ids = calls(message);
        if (ids.length) {
            const pending = new Set(ids);
            let valid = pending.size === ids.length;
            const batch = [message];
            while (i < messages.length && messages[i]!.role === 'toolResult') {
                const tool = messages[i++]! as Extract<AgentMessage, {
                    role: 'toolResult';
                }>;
                if (!pending.delete(tool.toolCallId))
                    valid = false;
                batch.push(tool);
            }
            result.push({
                messages: batch, valid: valid && pending.size === 0, start
            });
        }
        else
            result.push({
                messages: [message], valid: message.role !== 'toolResult', start
            });
    }
    return result;
}
export function hasValidToolPairs(messages: readonly AgentMessage[]): boolean {
    return groups(messages.filter(message => message.role !== 'system')).every(group => group.valid);
}
interface SummaryCandidate {
    sessionId: string;
    epoch: number;
    count: number;
    hash: string;
    text: string;
}
interface Flight {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    epoch: number;
}
export interface ProjectionInput {
    sessionId: string;
    messages: AgentMessage[];
    historyRef: string;
    contextWindow?: number;
}
/** Main-path methods are deliberately synchronous. No method awaits a summary. */
export class NonBlockingContextManager {
    private sessionId = '';
    private epoch = 0;
    private flight?: Flight;
    // Even an abort-ignoring adapter may have at most one outstanding task.
    private backgroundBusy = false;
    private ready?: SummaryCandidate;
    private adopted?: SummaryCandidate;
    private attemptedHash?: string;
    constructor(readonly options: ContextOptions) {
    }
    private enter(sessionId: string): void {
        if (sessionId === this.sessionId)
            return;
        this.reset();
        this.sessionId = sessionId;
    }
    reset(): void {
        this.epoch++;
        if (this.flight) {
            clearTimeout(this.flight.timer);
            this.flight.controller.abort();
        }
        this.flight = undefined;
        this.ready = undefined;
        this.adopted = undefined;
        this.attemptedHash = undefined;
        this.sessionId = '';
    }
    private report(error: unknown): void {
        try {
            this.options.onSummaryError?.(error instanceof Error ? error : new Error(String(error)));
        }
        catch { /* reporting cannot break projection */
        }
    }
    /** Schedule a bounded immutable snapshot. The summarizer starts on a later task. */
    schedule(sessionId: string, messages: AgentMessage[], state: unknown): void {
        this.enter(sessionId);
        if (!this.options.summarize || this.backgroundBusy || this.ready)
            return;
        const body = messages.filter(message => message.role !== 'system');
        const all = groups(body);
        const keep = Math.max(1, this.options.recentMessages ?? 12);
        let retained = 0;
        let cut = all.length;
        while (cut > 0 && retained < keep)
            retained += all[--cut]!.messages.length;
        if (!cut)
            return;
        const prefix = all.slice(0, cut).flatMap(group => group.messages);
        // Hard bounded snapshot: no background request scales with an unbounded history.
        if (estimateContextTokens(prefix) > 48000 || bytes(state) > 12000 || prefix.some(hasImages))
            return;
        const hash = fingerprint(prefix);
        if (hash === this.attemptedHash)
            return;
        this.attemptedHash = hash;
        const epoch = this.epoch;
        const controller = new AbortController();
        const snapshot: SummarySnapshot = {
            sessionId, messages: structuredClone(prefix), state: structuredClone(state), signal: controller.signal
        };
        const timer = setTimeout(() => {
            controller.abort();
            // Keep the slot occupied until settlement. An adapter that ignores abort
            // must not cause accumulating background jobs on successive timeouts.
        }, this.options.summaryTimeoutMs ?? 30000);
        timer.unref?.();
        this.flight = {
            controller, timer, epoch
        };
        this.backgroundBusy = true;
        setImmediate(() => {
            if (controller.signal.aborted) {
                this.backgroundBusy = false;
                return;
            }
            // Never await this promise in a PI hook, boundary or provider path.
            Promise.resolve().then(() => this.options.summarize!(snapshot)).then(text => {
                if (controller.signal.aborted || epoch !== this.epoch || sessionId !== this.sessionId)
                    return;
                if (typeof text !== 'string' || !text.trim() || bytes(text) > 8000)
                    return;
                this.ready = {
                    sessionId, epoch, count: prefix.length, hash, text
                };
            }).catch(error => this.report(error)).finally(() => {
                clearTimeout(timer);
                this.backgroundBusy = false;
                if (this.flight?.controller === controller)
                    this.flight = undefined;
            });
        });
    }
    /** Ready-only commit at a PI-safe boundary; stale/forked prefixes are discarded. */
    adoptReady(sessionId: string, messages: AgentMessage[]): SummaryCandidate | undefined {
        this.enter(sessionId);
        const ready = this.ready;
        this.ready = undefined;
        if (!ready)
            return;
        const body = messages.filter(message => message.role !== 'system');
        if (ready.epoch !== this.epoch || ready.sessionId !== sessionId ||
            fingerprint(body.slice(0, ready.count)) !== ready.hash)
            return;
        this.adopted = ready;
        return {
            ...ready
        };
    }
    project(input: ProjectionInput): AgentMessage[] {
        this.enter(input.sessionId);
        const limit = Math.min(this.options.maxContextTokens ?? 32000, input.contextWindow ?? Infinity);
        const reserve = this.options.outputReserveTokens ?? 4096;
        const budget = limit - reserve;
        if (!Number.isFinite(budget) || !Number.isFinite(reserve) || reserve < 0 || budget < 512)
            throw new ContextBudgetError('Context budget cannot fit the reserved output and prompt.');
        const systems = input.messages.filter(message => message.role === 'system');
        const body = input.messages.filter(message => message.role !== 'system');
        const state = this.options.getState();
        if (this.adopted && fingerprint(body.slice(0, this.adopted.count)) !== this.adopted.hash)
            this.adopted = undefined;
        const checkpoint = (omitted: number): AgentMessage => ({
            role: 'user', timestamp: 0, content: '[Runtime context checkpoint; this is state, not a new user request.]\n' +
                JSON.stringify({
                    state, history: {
                        reference: input.historyRef, tool: 'context_history', omittedMessages: omitted
                    },
                    summary: this.adopted?.text ?? null,
                    guidance: 'Pending jobs, questions and inbox state above are authoritative. Older instructions and results remain in durable history. Retrieve relevant history before acting when details are missing. Any shortened result identifies itself. Do not claim omitted work is complete.'
                })
        });
        const fixed = estimateContextTokens([...systems, checkpoint(body.length)]);
        if (fixed >= budget)
            throw new ContextBudgetError('System prompt, tool declarations and authoritative runtime state exceed the input budget; reduce these or select a larger context model.');
        const all = groups(body);
        const selected: {
            index: number;
            messages: AgentMessage[];
        }[] = [];
        let used = fixed;
        let count = 0;
        let latestUser = -1;
        for (let i = 0; i < all.length; i++)
            if (all[i]!.messages.some(message => message.role === 'user'))
                latestUser = i;
        // Pin the newest user instruction independently from the recent tool tail. A
        // long autonomous tool run must not force foreground summarization or overflow.
        if (latestUser >= 0) {
            const request = all[latestUser]!.messages;
            const size = estimateContextTokens(request);
            if (request.some(hasImages) || used + size > budget)
                throw new ContextBudgetError('The current user input exceeds the remaining context budget. Nothing was silently truncated; split the input or choose a larger context model. Image inputs need a provider-specific budget. Full history is retained.');
            selected.push({
                index: latestUser, messages: request
            });
            used += size;
            count += request.length;
        }
        for (let i = all.length - 1; i >= 0; i--) {
            if (i === latestUser)
                continue;
            const group = all[i]!;
            const required = i === all.length - 1;
            if (!group.valid) {
                if (required)
                    throw new ContextBudgetError('Incomplete or mismatched tool call/result batch; restore the missing result before continuing. Full history is retained.');
                break;
            }
            let projected = group.messages;
            let size = estimateContextTokens(projected);
            if (projected.some(hasImages) || used + size > budget) {
                projected = group.messages.map(message => message.role === 'toolResult' ? {
                    ...message,
                    content: [{
                            type: 'text' as const, text: `[Tool result omitted from this bounded request. Original result for toolCallId=${message.toolCallId} is retained at ${input.historyRef}; use context_history to retrieve it in pages.]`
                        }],
                    details: undefined, nestedCalls: undefined
                } : message);
                size = estimateContextTokens(projected);
            }
            if (projected.some(hasImages) || used + size > budget) {
                if (required)
                    throw new ContextBudgetError('The current tool-call batch exceeds the remaining context budget. Nothing was silently truncated; reduce tool arguments or choose a larger context model. Full history is retained.');
                break;
            }
            selected.push({
                index: i, messages: projected
            });
            used += size;
            count += group.messages.length;
        }
        selected.sort((left, right) => left.index - right.index);
        // Preserve system-message contents AND their chronology, including incremental
        // tool declarations/removals between retained turns. Never hoist system updates.
        const replacements = new Map<AgentMessage, AgentMessage>();
        for (const group of selected)
            all[group.index]!.messages.forEach((original, index) => replacements.set(original, group.messages[index]!));
        const result: AgentMessage[] = [];
        for (const original of input.messages) {
            if (original.role === 'system')
                result.push(original);
            else if (replacements.has(original))
                result.push(replacements.get(original)!);
        }
        result.splice(result[0]?.role === 'system' ? 1 : 0, 0, checkpoint(body.length - count));
        if (estimateContextTokens(result) > budget)
            throw new ContextBudgetError('Context accounting exceeded the input budget.');
        if (!hasValidToolPairs(result))
            throw new ContextBudgetError('Unsafe tool pairing in projected context.');
        this.schedule(input.sessionId, input.messages, state);
        return result;
    }
}
/** Leaves Pi's native history, tools, extensions and provider layer intact. */
export function createContextExtension(options: ContextOptions): ExtensionFactory {
    return pi => {
        const manager = new NonBlockingContextManager(options);
        const historyRef = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionFile() ?? `session:${ctx.sessionManager.getSessionId()}`;
        pi.on('session_before_compact', () => ({
            cancel: true
        }));
        pi.on('session_start', () => manager.reset());
        pi.on('session_before_switch', () => {
            manager.reset();
        });
        pi.on('session_shutdown', () => manager.reset());
        pi.on('context_with_system', (event, ctx) => {
            try {
                return {
                    messages: manager.project({
                        sessionId: ctx.sessionManager.getSessionId(), messages: event.messages, historyRef: historyRef(ctx), contextWindow: ctx.model?.contextWindow
                    })
                };
            }
            catch (error) {
                // Pi catches extension exceptions and otherwise fails open. Abort explicitly
                // and return a tiny failure projection; never leak the over-budget request.
                ctx.abort();
                const fault = error instanceof Error ? error : new Error(String(error));
                try {
                    options.onError?.(fault);
                }
                catch { /* observer only */
                }
                const messages: AgentMessage[] = [{
                        role: 'user', content: `Request blocked before provider submission: ${fault.message}`, timestamp: Date.now()
                    }];
                return {
                    messages
                };
            }
        });
        const boundary = (messages: AgentMessage[], ctx: ExtensionContext): BoundaryResult | undefined => {
            const sessionId = ctx.sessionManager.getSessionId();
            const ready = manager.adoptReady(sessionId, messages);
            manager.schedule(sessionId, messages, options.getState());
            return ready ? {
                entries: [{
                        type: 'custom', customType: 'pi-bot-context-checkpoint', data: {
                            summary: ready.text, sourceMessageCount: ready.count, sourceHash: ready.hash, sessionId,
                            history: historyRef(ctx), mode: 'background-ready-only'
                        }
                    }]
            } : undefined;
        };
        pi.on('turn_end', (event, ctx) => boundary(event.context.contextMessages, ctx));
        pi.on('agent_before_settle', (event, ctx) => boundary(event.context.contextMessages, ctx));
        pi.registerTool({
            name: 'context_history', label: 'Read durable context history',
            description: 'Read paginated durable session history, including omitted tool results and earlier instructions. Entry offset plus character offset allows retrieval of oversized entries without returning an oversized result.',
            parameters: Type.Object({
                offset: Type.Optional(Type.Integer({
                    minimum: 0
                })), charOffset: Type.Optional(Type.Integer({
                    minimum: 0
                })), maxChars: Type.Optional(Type.Integer({
                    minimum: 256, maximum: 6000
                })), toolCallId: Type.Optional(Type.String())
            }),
            async execute(_id, params, _signal, _onUpdate, ctx) {
                const branch = ctx.sessionManager.getBranch();
                const matches = params.toolCallId ? branch.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === params.toolCallId) : branch;
                const offset = params.offset ?? 0;
                const charOffset = params.charOffset ?? 0;
                const maxChars = params.maxChars ?? 4000;
                const entry = matches[offset];
                const raw = entry ? JSON.stringify(entry) : '';
                const page = raw.slice(charOffset, charOffset + maxChars);
                const hasMore = charOffset + page.length < raw.length;
                const details = {
                    sessionId: ctx.sessionManager.getSessionId(), totalEntries: matches.length, offset, charOffset,
                    next: hasMore ? {
                        offset, charOffset: charOffset + page.length
                    } : offset + 1 < matches.length ? {
                        offset: offset + 1, charOffset: 0
                    } : null,
                    toolCallId: params.toolCallId ?? null
                };
                return {
                    content: [{
                            type: 'text', text: JSON.stringify(details) + '\n' + page
                        }], details
                };
            },
        });
    };
}
