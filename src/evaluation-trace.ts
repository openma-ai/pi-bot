import type { Envelope, Job, Outbound } from './store.ts';
/** Evaluation-only evidence: never captures HTTP headers, raw provider errors or reasoning. */
export interface EvaluationTrace {
    inbox: Envelope[];
    jobs: Job[];
    outbox: Outbound[];
    calls: {
        order: number;
        botId: string;
        id: string;
        parentId?: string;
        name: string;
        args: unknown;
    }[];
    results: {
        order: number;
        botId: string;
        id: string;
        parentId?: string;
        name: string;
        isError: boolean;
        content: unknown;
        details: unknown;
    }[];
    boundaries: {
        order: number;
        botId: string;
        inboxIds: string[];
    }[];
}
export function redactTraceValue<T>(value: T): T {
    const redact = (v: any): any => {
        if (typeof v === 'string')
            return v
                .replace(/\bBearer\s+[^\s;"']+/gi, 'Bearer [REDACTED]')
                .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
                .replace(/((?:api[_ -]?key|secret|password|authorization)\s*[:=]\s*)[^\s;,"']+/gi, '$1[REDACTED]');
        if (Array.isArray(v))
            return v.filter(item => item?.type !== 'thinking' && item?.type !== 'reasoning').map(redact);
        if (v && typeof v === 'object')
            return Object.fromEntries(Object.entries(v).filter(([k]) => !/^(thinking|reasoning|reasoning_content)$/i.test(k)).map(([k, item]) => [k, /^(api[_-]?key|secret|password|authorization|credentials)$/i.test(k) ? '[REDACTED]' : redact(item)]));
        return v;
    };
    return redact(value);
}
export { inboxIds } from './inbox-identity.ts';
/** Observes native hooks, including ctx.executeTool nested calls omitted by the transcript projection. */
export function observeEvaluationTools(trace: EvaluationTrace, botId: string, nextOrder: () => number): import('@earendil-works/pi-coding-agent').ExtensionFactory {
    return pi => {
        pi.on('tool_call', event => {
            trace.calls.push(redactTraceValue({
                order: nextOrder(), botId, id: event.toolCallId, parentId: event.parentToolCallId, name: event.toolName, args: event.input
            }));
        });
        pi.on('tool_result', event => {
            trace.results.push(redactTraceValue({
                order: nextOrder(), botId, id: event.toolCallId, parentId: event.parentToolCallId, name: event.toolName, isError: event.isError, content: event.content, details: event.details
            }));
        });
    };
}
