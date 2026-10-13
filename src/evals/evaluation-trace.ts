import type { Envelope, Job, Outbound } from '../daemon/runtime/store.ts';
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
import { redactTraceValue } from '../pi/redact.ts';
export { redactTraceValue };
export { inboxIds } from '../pi/inbox-identity.ts';
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
