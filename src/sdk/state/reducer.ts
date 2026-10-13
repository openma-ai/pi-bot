import type { Snapshot, EventEnvelope } from '../protocol/index.ts';
export type DaemonState = {
    seq: number;
    status: string;
    bots: Record<string, any>;
    groups: Record<string, any>;
    threads: Record<string, any>;
    turns: Record<string, any>;
    items: Record<string, any>;
    requests: Record<string, any>;
    routines: Record<string, any>;
    jobs: Record<string, any>;
    streaming: Record<string, string>;
    streamingScopes: Record<string, string>;
    streamingTurns: Record<string, string>;
};
const index = (values: any[]) => Object.fromEntries(values.map(v => [v.id, v]));
export function stateFromSnapshot(s: Snapshot): DaemonState {
    return {
        seq: s.seq, status: s.status, bots: index(s.bots), groups: index(s.groups), threads: index(s.threads), turns: index(s.turns), items: index(s.items), requests: index(s.requests), routines: index(s.routines), jobs: index(s.jobs), streaming: {}, streamingScopes: {}, streamingTurns: {}
    };
}
export function applyEvent(state: DaemonState, e: EventEnvelope): DaemonState {
    if (e.seq !== null && e.seq <= state.seq)
        return state;
    const next = {
        ...state, seq: e.seq ?? state.seq
    }, p = e.params;
    if (e.method === 'events/watermark')
        return {
            ...next, seq: Math.max(next.seq, p.seq)
        };
    if (e.method === 'daemon/statusChanged')
        next.status = p.to;
    const map: Record<string, keyof DaemonState> = {
        bot: 'bots', group: 'groups', thread: 'threads', turn: 'turns', item: 'items', request: 'requests', routine: 'routines', job: 'jobs'
    };
    for (const [key, collection] of Object.entries(map))
        if (p[key]?.id)
            (next as any)[collection] = {
                ...(next as any)[collection], [p[key].id]: p[key]
            };
    if (e.method === 'item/agentMessage/delta') {
        next.streamingTurns = {
            ...state.streamingTurns, [p.toolCallId]: p.turnId
        };
        next.streamingScopes = {
            ...state.streamingScopes, [p.toolCallId]: p.threadId
        };
        next.streaming = {
            ...state.streaming, [p.toolCallId]: (state.streaming[p.toolCallId] ?? '') + p.textDelta
        };
    }
    if (p.item?.type === 'agentMessage' && p.item.toolCallId) {
        next.streaming = {
            ...state.streaming
        };
        delete next.streaming[p.item.toolCallId];
        next.streamingScopes = {
            ...state.streamingScopes
        };
        delete next.streamingScopes[p.item.toolCallId];
        next.streamingTurns = {
            ...state.streamingTurns
        };
        delete next.streamingTurns[p.item.toolCallId];
    }
    if (e.method === 'turn/completed') {
        next.streaming = {
            ...next.streaming
        };
        next.streamingScopes = {
            ...next.streamingScopes
        };
        next.streamingTurns = {
            ...next.streamingTurns
        };
        for (const id of Object.keys(next.streamingTurns))
            if (next.streamingTurns[id] === p.turn.id) {
                delete next.streaming[id];
                delete next.streamingScopes[id];
                delete next.streamingTurns[id];
            }
    }
    return next;
}
export function createDaemonStore(snapshot: Snapshot) {
    let state = stateFromSnapshot(snapshot);
    return {
        get: () => state, apply: (e: EventEnvelope) => {
            state = applyEvent(state, e);
            return state;
        }
    };
}
