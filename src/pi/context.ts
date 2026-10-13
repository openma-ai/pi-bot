import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionFactory, ExtensionContext, BoundaryResult, CompactionEntryDraft, ProjectedSessionEntry } from '@earendil-works/pi-coding-agent';
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
    /** Start well before the hard input limit; defaults to 60% of that limit. */
    thresholdTokens?: number;
    recentMessages?: number;
    summarize?: (snapshot: SummarySnapshot) => Promise<string>;
    /** Explicitly disable background requests for a capped smoke evaluation. */
    backgroundEnabled?: boolean;
    /** Host scheduling predicate; false never blocks or changes foreground history. */
    canSummarize?: () => boolean;
    summaryTimeoutMs?: number;
    summaryRetryMs?: number;
    summaryMaxAttempts?: number;
    /** Lifetime cancellation only; new foreground input must not abort summaries. */
    signal?: AbortSignal;
    /** Hard guard failures only; the host should leave the inbox recoverable. */
    onError?: (error: Error) => void;
    /** Observational only: a background failure must never fail a foreground wake. */
    onSummaryError?: (error: Error) => void;
    onCompaction?: (info: {
        tokensBefore: number;
        tokensAfter: number;
    }) => void;
}
export class ContextBudgetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ContextBudgetError';
    }
}
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
// Deliberately conservative, tokenizer-independent text/JSON accounting. Images
// need a provider-specific bound; never omit them to make a request fit.
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
const visibleEntries = (entries: readonly ProjectedSessionEntry[]): ProjectedSessionEntry[] => entries.filter(entry => entry.messages.length > 0);
const prefixHash = (entries: readonly ProjectedSessionEntry[]): string => fingerprint(entries.map(entry => [entry.sourceEntry.id, entry.messages]));
interface SummaryCandidate {
    sessionId: string;
    epoch: number;
    count: number;
    hash: string;
    firstKeptEntryId: string;
    text: string;
}
interface Flight {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
}
export interface ContextInput {
    sessionId: string;
    messages: AgentMessage[];
    historyRef: string;
    contextWindow?: number;
}
export interface SummaryInput {
    sessionId: string;
    entries: ProjectedSessionEntry[];
    state: unknown;
    contextWindow?: number;
    /** Full foreground input accounting, including prompt, tools and ledger. */
    contextTokens?: number;
}
/** Main-path methods are synchronous. Only Pi owns the active conversation. */
export class NonBlockingContextManager {
    private sessionId = '';
    private epoch = 0;
    private flight?: Flight;
    // Even an abort-ignoring adapter may have at most one outstanding task.
    private backgroundBusy = false;
    private ready?: SummaryCandidate;
    private attemptedHash?: string;
    private attempts = 0;
    private retryAfter = 0;
    constructor(readonly options: ContextOptions) {
        options.signal?.addEventListener('abort', () => this.reset(), {
            once: true
        });
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
        this.attemptedHash = undefined;
        this.attempts = 0;
        this.retryAfter = 0;
        this.sessionId = '';
    }
    private budget(contextWindow?: number): {
        input: number;
        threshold: number;
    } {
        const limit = Math.min(this.options.maxContextTokens ?? Infinity, contextWindow ?? 32000);
        const reserve = this.options.outputReserveTokens ?? 4096;
        const input = limit - reserve;
        const threshold = this.options.thresholdTokens ?? Math.floor(input * 0.6);
        if (!Number.isFinite(input) || !Number.isFinite(reserve) || reserve < 0 || input < 512 ||
            !Number.isFinite(threshold) || threshold <= 0 || threshold >= input)
            throw new ContextBudgetError('Context budget must fit the output reserve and a soft threshold below the hard input limit.');
        return {
            input, threshold
        };
    }
    private report(error: unknown): void {
        try {
            this.options.onSummaryError?.(error instanceof Error ? error : new Error(String(error)));
        }
        catch { /* reporting cannot break the foreground */
        }
    }
    /** Add only a small current ledger. No existing message is changed or removed. */
    preserveContext(input: ContextInput): AgentMessage[] {
        this.enter(input.sessionId);
        const budget = this.budget(input.contextWindow).input;
        const ledger: AgentMessage = {
            role: 'user', timestamp: 0,
            content: '[Runtime ledger; state, not a new user request.]\n' + JSON.stringify({
                state: this.options.getState(), history: {
                    reference: input.historyRef, tool: 'context_history'
                },
                guidance: 'Pending jobs, questions and inbox state are authoritative. A receipt is not completion. Read durable history if a compacted detail is needed.'
            })
        };
        if (estimateContextTokens([ledger, ...input.messages.filter(message => message.role === 'system')]) >= budget)
            throw new ContextBudgetError('System prompt, tool declarations and authoritative runtime state exceed the input budget.');
        if (input.messages.some(hasImages))
            throw new ContextBudgetError('Image inputs need a provider-specific context budget. No input or history was truncated.');
        if (!hasValidToolPairs(input.messages))
            throw new ContextBudgetError('Incomplete or mismatched tool call/result batch. Full native history is retained.');
        const messages = [...input.messages];
        messages.splice(messages[0]?.role === 'system' ? 1 : 0, 0, ledger);
        if (estimateContextTokens(messages) > budget)
            throw new ContextBudgetError('Full native context exceeds the input budget before background compaction could be applied. Nothing was truncated and no summary was awaited; retry after a completed compaction or select a larger context budget/model.');
        return messages;
    }
    /** Launch an immutable stable prefix only after the soft threshold is reached. */
    schedule(input: SummaryInput): void {
        this.enter(input.sessionId);
        if (this.options.backgroundEnabled === false || this.options.canSummarize?.() === false || !this.options.summarize || this.options.signal?.aborted || this.backgroundBusy || this.ready || Date.now() < this.retryAfter)
            return;
        const { input: budget, threshold } = this.budget(input.contextWindow);
        const entries = visibleEntries(input.entries);
        const allMessages = entries.flatMap(entry => entry.messages);
        if ((input.contextTokens ?? estimateContextTokens(allMessages)) < threshold)
            return;
        const indexed = entries.flatMap((entry, index) => entry.messages.filter(message => message.role !== 'system').map(message => ({
            message, index
        })));
        const all = groups(indexed.map(item => item.message));
        if (all.some(group => !group.valid))
            return;
        const keep = Math.max(1, this.options.recentMessages ?? 12);
        let retained = 0, cut = all.length;
        while (cut > 0 && retained < keep)
            retained += all[--cut]!.messages.length;
        if (!cut)
            return;
        // Restrict the snapshot, not the foreground. A larger history can be reduced
        // across several native compactions without ever cutting a message in half.
        const snapshotBudget = Math.min(48000, Math.floor(budget * 0.75));
        let prefix: AgentMessage[] = [], firstKept = 0;
        while (cut > 0) {
            firstKept = indexed[all[cut]!.start]!.index;
            // A projected entry may own several messages (notably prior compaction).
            // Only choose an entry boundary which is also a complete tool boundary.
            if (indexed[all[cut]!.start - 1]?.index !== firstKept) {
                prefix = entries.slice(0, firstKept).flatMap(entry => entry.messages).filter(message => message.role !== 'system');
                if (prefix.length && estimateContextTokens(prefix) <= snapshotBudget)
                    break;
            }
            cut--;
        }
        if (!cut || !prefix.length || prefix.some(hasImages))
            return;
        const kept = entries[firstKept]!;
        if (kept.sourceEntry.type === 'compaction')
            return;
        const hash = prefixHash(entries.slice(0, firstKept));
        if (this.attemptedHash !== hash) {
            this.attemptedHash = hash;
            this.attempts = 0;
        }
        if (this.attempts >= (this.options.summaryMaxAttempts ?? 3))
            return;
        this.attempts++;
        const epoch = this.epoch;
        const { sessionId } = input;
        const controller = new AbortController();
        const snapshot: SummarySnapshot = {
            sessionId, messages: structuredClone(prefix), state: structuredClone(input.state), signal: controller.signal
        };
        const fail = (error: unknown): void => {
            if (epoch !== this.epoch || sessionId !== this.sessionId)
                return;
            this.retryAfter = Date.now() + (this.options.summaryRetryMs ?? 30000);
            this.report(error);
        };
        const timer = setTimeout(() => {
            controller.abort();
            fail(new Error('Background context summary timed out. Full native context remains active.'));
            // Do not free the slot until settlement: a hung, abort-ignoring adapter
            // must not create accumulating background requests on every boundary.
        }, this.options.summaryTimeoutMs ?? 30000);
        timer.unref?.();
        this.flight = {
            controller, timer
        };
        this.backgroundBusy = true;
        setImmediate(() => {
            // This work runs separately from the foreground request/extension lane.
            Promise.resolve().then(() => {
                if (controller.signal.aborted)
                    return undefined;
                return this.options.summarize!(snapshot);
            }).then(text => {
                if (controller.signal.aborted || epoch !== this.epoch || sessionId !== this.sessionId)
                    return;
                if (typeof text !== 'string' || !text.trim() || bytes(text) > 8000)
                    throw new Error('Background context summary was empty or exceeded its size limit.');
                if (bytes(text) >= estimateContextTokens(prefix))
                    throw new Error('Background context summary did not reduce the stable prefix.');
                this.ready = {
                    sessionId, epoch, count: firstKept, hash, firstKeptEntryId: kept.sourceEntry.id, text
                };
            }).catch(error => {
                if (!controller.signal.aborted)
                    fail(error);
            }).finally(() => {
                clearTimeout(timer);
                this.backgroundBusy = false;
                if (this.flight?.controller === controller)
                    this.flight = undefined;
            });
        });
    }
    /** Return a native draft at a Pi boundary, never a parallel projected history. */
    adoptReady(sessionId: string, currentEntries: ProjectedSessionEntry[]): CompactionEntryDraft | undefined {
        this.enter(sessionId);
        const ready = this.ready;
        this.ready = undefined;
        if (!ready)
            return;
        const entries = visibleEntries(currentEntries);
        if (ready.epoch !== this.epoch || ready.sessionId !== sessionId ||
            entries[ready.count]?.sourceEntry.id !== ready.firstKeptEntryId ||
            prefixHash(entries.slice(0, ready.count)) !== ready.hash)
            return;
        // firstKeptEntryId keeps the full old tail AND entries appended since the
        // snapshot. Pi persists this compaction and restores it on every restart.
        return {
            type: 'compaction', summary: ready.text, firstKeptEntryId: ready.firstKeptEntryId,
            details: {
                sessionId, sourceEntryCount: ready.count, sourceHash: ready.hash, mode: 'background-ready-only'
            }
        };
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
        pi.on('session_before_switch', () => manager.reset());
        pi.on('session_shutdown', () => manager.reset());
        const schedule = (ctx: ExtensionContext, contextTokens?: number): void => manager.schedule({
            sessionId: ctx.sessionManager.getSessionId(), entries: ctx.sessionManager.buildSessionProjection().entries,
            state: options.getState(), contextWindow: ctx.model?.contextWindow, contextTokens
        });
        pi.on('context_with_system', (event, ctx) => {
            try {
                // The only additive request context is the small authoritative ledger.
                const messages = manager.preserveContext({
                    sessionId: ctx.sessionManager.getSessionId(), messages: event.messages, historyRef: historyRef(ctx), contextWindow: ctx.model?.contextWindow
                });
                schedule(ctx, estimateContextTokens(messages));
                return {
                    messages
                };
            }
            catch (error) {
                // Pi catches extension exceptions, so explicitly stop the request.
                // Keep native history intact, including the overflowing latest input.
                ctx.abort();
                const fault = error instanceof Error ? error : new Error(String(error));
                try {
                    options.onError?.(fault);
                }
                catch { /* observer only */
                }
            }
        });
        const boundary = (event: {
            entries: NonNullable<BoundaryResult['entries']>;
            context: {
                contextEntries: ProjectedSessionEntry[];
            };
        }, ctx: ExtensionContext): BoundaryResult | undefined => {
            const ready = manager.adoptReady(ctx.sessionManager.getSessionId(), event.context.contextEntries);
            if (ready) {
                const before = visibleEntries(event.context.contextEntries).flatMap(entry => entry.messages);
                try {
                    options.onCompaction?.({
                        tokensBefore: estimateContextTokens(before), tokensAfter: Math.ceil(JSON.stringify(ready).length / 4)
                    });
                }
                catch { /* observer only */
                }
                return {
                    entries: [...event.entries, ready]
                };
            }
            schedule(ctx);
        };
        pi.on('turn_end', (event, ctx) => boundary(event, ctx));
        pi.on('agent_before_settle', (event, ctx) => boundary(event, ctx));
        pi.registerTool({
            name: 'context_history', label: 'Read durable context history',
            description: 'Read paginated durable session history, including compacted earlier instructions and original tool results. Entry offset plus character offset allows retrieval of oversized entries without returning an oversized result.',
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
