import { redactTraceValue } from '../../pi/redact.ts';
import { projectChannelMessage } from '../runtime/channel-messages.ts';
import type { Envelope, Outbound } from '../../pi/types.ts';
export function jobView(j: any) {
    const { args, result, ...rest } = j;
    return redactTraceValue(rest) as any;
}
export function routineView(table: string, r: any) {
    const { cursor, baseline, ...rest } = r;
    return {
        ...rest, id: (table === 'schedules' ? 'schedule:' : 'monitor:') + r.id, kind: table === 'schedules' ? 'schedule' : 'monitor'
    };
}
export function derive(table: string, before: any, after: any, context: any) {
    const events: {
        method: string;
        params: Record<string, any>;
    }[] = [];
    const add = (method: string, params: Record<string, any>) => events.push({
        method, params
    });
    if (JSON.stringify(before) === JSON.stringify(after))
        return events;
    if (table === 'bots')
        add(before ? 'bot/updated' : 'bot/created', {
            bot: after
        });
    if (table === 'groups')
        add(before ? 'group/updated' : 'group/created', {
            group: after
        });
    if (table === 'threads')
        add(!before ? 'thread/started' : after.status === 'loaded' ? 'thread/loaded' : after.status === 'archived' ? 'thread/archived' : 'thread/unloaded', {
            thread: after
        });
    if (table === 'turns')
        add(after.status === 'running' ? (before ? 'turn/updated' : 'turn/started') : 'turn/completed', {
            turn: after
        });
    if (table === 'requests')
        add(after.status === 'pending' ? 'request/created' : 'request/resolved', {
            request: after
        });
    if (table === 'items')
        add(after.status === 'inProgress' ? (before ? 'item/updated' : 'item/started') : 'item/completed', {
            item: after
        });
    if (table === 'schedules' || table === 'monitors')
        add('routine/updated', {
            routine: routineView(table, after)
        });
    if (table === 'fires')
        add('routine/fired', {
            routineId: (after.kind === 'monitor' ? 'monitor:' : 'schedule:') + (after.triggerId ?? after.scheduleId ?? after.monitorId ?? ''), fireId: after.id, inputId: after.messageId ?? after.inputId ?? after.id
        });
    if (table === 'proposals')
        add('proposal/updated', {
            proposal: jobView(after)
        });
    if (table === 'memories')
        add('memory/updated', {
            memory: after
        });
    if (table === 'group_messages')
        add('group/messageUpdated', {
            message: after
        });
    if (table === 'jobs') {
        const job = jobView(after);
        add('job/updated', {
            job
        });
        if (context?.threadId)
            add(after.state === 'running' ? 'item/started' : 'item/completed', {
                item: {
                    id: 'job:' + after.id, type: 'job', threadId: context.threadId, turnId: context.turnId ?? null, status: after.state === 'running' ? 'inProgress' : 'completed', jobId: after.id, botId: after.botId, tool: after.tool, state: after.state
                }
            });
    }
    if ((table === 'inbox' || table === 'outbox') && context?.threadId) {
        const e = after as any;
        const message = projectChannelMessage(table, after);
        if (table === 'inbox' && !before && e.state === 'queued')
            add('turn/queued', {
                inputId: e.id, threadId: context.threadId, trigger: e.kind
            });
        const item = {
            id: table + ':' + e.id, type: table === 'inbox' ? 'inputMessage' : 'agentMessage', threadId: context.threadId, turnId: context.turnId ?? null, status: 'completed', botId: table === 'inbox' ? e.to : e.botId, text: message.text, ...(table === 'inbox' ? {
                envelopeId: e.id, sender: e.from, source: e.kind
            } : {
                outboxId: e.id, delivery: e.state, ...(e.toolCallId ? {
                    toolCallId: e.toolCallId
                } : {})
            }), message
        };
        add(before ? 'item/updated' : 'item/completed', {
            item
        });
        if (table === 'inbox' && ['uncertain', 'failed'].includes(e.state))
            add('task/reviewRequired', {
                inputId: e.id, threadId: context.threadId, error: e.error
            });
        if (table === 'inbox' && before?.state === 'uncertain' && e.state !== 'uncertain')
            add('task/reconciled', {
                inputId: e.id, threadId: context.threadId, outcome: e.state, evidence: e.resolution?.evidence ?? []
            });
    }
    return events;
}
