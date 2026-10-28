import { randomUUID } from 'node:crypto';
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext, type Context } from '@earendil-works/pi-ai';

/** Metadata only: never accept provider payloads, prompt text, arguments or errors. */
export type LatencyBoundary = {
    kind: 'provider' | 'tool';
    phase: 'start' | 'first_event' | 'first_content' | 'end';
    id: string;
    elapsedMs: number;
    outcome?: 'ok' | 'error' | 'cancelled' | 'blocked';
    tool?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    systemPromptCharacters?: number;
    toolSchemaCharacters?: number;
    declaredToolCount?: number;
    declaredToolNames?: string[];
    promptAndToolsChar4Estimate?: number;
    messageCount?: number;
};
/** Snapshot only size/name metadata at the actual request boundary. */
export function providerRequestShape(context: unknown): Partial<LatencyBoundary> {
    try {
        const c = context as Context;
        // Pi 1.2 uses system message sections/toolsAdded/toolsRemoved. Replaying
        // the public SDK contract avoids incorrectly reporting zero tools.
        const messages = normalizeContext({ ...c, messages: c.messages ?? [] }).messages;
        const systemPromptCharacters = getCurrentSystemPrompt(messages).length;
        const tools = getCurrentTools(messages);
        const toolSchemaCharacters = JSON.stringify(tools).length;
        return { systemPromptCharacters, toolSchemaCharacters, declaredToolCount: tools.length,
            declaredToolNames: tools.slice(0,128).map(t=>typeof t.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(t.name) ? t.name : 'other'),
            promptAndToolsChar4Estimate: Math.ceil((systemPromptCharacters + toolSchemaCharacters) / 4), messageCount: Array.isArray(c.messages) ? c.messages.length : 0 };
    } catch { return {}; }
}
export class ProviderTiming {
    private readonly id = randomUUID();
    private readonly started = performance.now();
    private firstEvent = false;
    private firstContent = false;
    private ended = false;
    constructor(private emit: (boundary: LatencyBoundary) => void, context?: unknown) { this.write('start', context ? providerRequestShape(context) : {}); }
    private write(phase: LatencyBoundary['phase'], extra: Partial<LatencyBoundary> = {}) {
        try { this.emit({ kind: 'provider', phase, id: this.id, elapsedMs: Math.max(0, performance.now() - this.started), ...extra }); }
        catch { /* Diagnostics never change request outcomes. */ }
    }
    event(type: string) {
        if (this.ended) return;
        if (!this.firstEvent) { this.firstEvent = true; this.write('first_event'); }
        // SDK "start" may be synthetic; this separately measures first content,
        // including reasoning/tool arguments without retaining their values.
        if (!this.firstContent && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(type)) {
            this.firstContent = true; this.write('first_content');
        }
    }
    end(outcome: LatencyBoundary['outcome'], usage?: { input: number; output: number; cacheRead: number }) {
        if (this.ended) return;
        this.ended = true;
        this.write('end', { outcome, ...(usage ? { inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead } : {}) });
    }
}
