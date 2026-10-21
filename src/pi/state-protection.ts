import type { StateObservation } from '@openma/matter/store';
import type { ChatRoute, Envelope } from './types.ts';
/** Opaque equality token from the state owner; null means the resource never existed. */
export type Revision = StateObservation['revision'];
export type StateConflict = {
    status: 'conflict';
    operationId: string;
    effect: 'not-applied';
    conflicts: readonly {
        resourceId: string;
        expectedRevision: Revision;
        actualRevision: Revision;
    }[];
    /** How the agent can read the changed state before deciding again. */
    reread: string;
};
export type StateCommit<A> = {
    status: 'committed';
    operationId: string;
    value: A;
    observations: readonly StateObservation[];
};
/** Read -> Decide -> Conditional Commit outcome returned to the deciding agent. */
export type CommitResult<A> = StateCommit<A> | StateConflict;
/** An agent decision: a stable operation identity plus the revision the agent actually read. */
export type Decision = {
    operationId: string;
    observed: Revision;
};
/** Inputs whose arrival changes what a user-facing reply depends on. Peer, job and trigger
 * events are separate inputs; they queue and do not invalidate a reply decision. */
export const conversationInputKinds: readonly Envelope['kind'][] = ['user', 'answer'];
export const conversationResource = (route?: ChatRoute) => 'conversation:' + JSON.stringify([route?.channelId ?? 'private', route?.conversationId ?? route?.channelId ?? 'private', route?.threadId ?? '']);
export const outboxResource = (key: string) => `outbox:${key}`;
export const scheduleResource = (id: string) => `schedule:${id}`;
export const monitorResource = (id: string) => `monitor:${id}`;
/** Read evidence of one Pi session. Revisions come only from what the model was shown:
 * conversation inputs visible in its context and revisions returned by its own read tools.
 * Nothing here reads the latest store state, so a commit can never borrow a newer version. */
export class ReadEvidence {
    private seen = new Map<string, Revision>();
    private shown: ReadonlyMap<string, Revision> = new Map();
    private decisions = new Map<string, ReadonlyMap<string, Revision>>();
    constructor(private readonly retainedDecisions = 256) {
    }
    /** A model request is about to be built from these visible inbox envelopes (store order). */
    observeContext(visible: readonly Envelope[]) {
        for (const e of visible)
            if (conversationInputKinds.includes(e.kind))
                this.seen.set(conversationResource(e.route), e.id);
        this.shown = new Map(this.seen);
    }
    /** A read tool returned this revision; the model sees it from its next request on. */
    observe(resourceId: string, revision: Revision) {
        this.seen.set(resourceId, revision);
    }
    /** Freeze the evidence behind a tool call. Nested calls (codemode) inherit their parent's. */
    bind(toolCallId: string, parentToolCallId?: string) {
        this.decisions.set(toolCallId, (parentToolCallId && this.decisions.get(parentToolCallId)) || this.shown);
        for (const id of this.decisions.keys()) {
            if (this.decisions.size <= this.retainedDecisions)
                break;
            this.decisions.delete(id);
        }
    }
    decision(toolCallId: string, resourceId: string, operationId = `tool:${toolCallId}`): Decision {
        return {
            operationId, observed: (this.decisions.get(toolCallId) ?? this.shown).get(resourceId) ?? null
        };
    }
}
/** Tool result for a conditional commit: committed values keep their existing shape. */
export const commitOutcome = <A>(commit: CommitResult<A>, committed: (value: A) => unknown = value => value) => commit.status === 'committed' ? committed(commit.value) : commit;
