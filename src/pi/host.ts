/**
 * Host ports: everything the Pi plugin layer needs from the process hosting it.
 *
 * The plugin (`src/pi`) depends only on these interfaces; a host such as
 * `src/daemon` implements them (`BotRuntime implements BotHost`). Keep this
 * module free of host imports so the dependency arrow always points into `pi`.
 */
import type { Bot, BotStateSnapshot, Envelope, Job, JobResultPage, MemoryRecord, Monitor, Outbound, Proposal, Question, Schedule } from './types.ts';
import type { CommitResult, Decision, Revision } from './state-protection.ts';
/** Thrown by a tool whose durable job failed; carries the native outcome. */
export class JobExecutionError extends Error {
    constructor(message: string, readonly outcome: unknown) {
        super(message);
    }
}
/** Thrown when foreground inference yields to newly arrived host input. */
export class InferenceYieldError extends Error {
    constructor() {
        super('Inference yielded to host input');
    }
}
/** A trusted host refusal, distinct from a provider transport failure. */
export class ProviderRequestGuardError extends Error {
    constructor(readonly reason: 'budgetExhausted' | 'taskCancelled', message: string) {
        super(message);
        this.name = 'ProviderRequestGuardError';
    }
}
/** One live Pi conversation for a bot (optionally per routing scope). */
export interface BotSession {
    run(e: Envelope): Promise<void>;
    enqueue?(e: Envelope): Promise<void>;
    yieldForUser?(): void;
    /** Native adapter confirms event actually reached a provider boundary. */
    consumed?(e: Envelope): boolean;
    /** A successful final native step, unlike merely reaching a provider boundary. */
    resolved?(e: Envelope): boolean;
    close(): Promise<void>;
}
export type Permission = (request: {
    botId: string;
    tool: string;
    args: unknown;
    taskId: string;
    /** Exact originating envelope, preserved across background execution. */
    sourceMessageId?: string;
}) => Promise<boolean> | boolean;
/** Durable record store, as seen by the plugin. */
export interface HostStore {
    get<T>(table: string, id: string): T | undefined;
    list<T>(table: string): T[];
    find<T>(table: string, owner: string, key: string): T | undefined;
    put<T extends {
        id: string;
    }>(table: string, value: T): void;
    transaction<T>(f: () => T): T;
    state(botId: string): BotStateSnapshot;
}
/** Durable, non-preemptive bot runtime services exposed to Pi tools. */
export interface BotHost {
    readonly store: HostStore;
    readonly events?: EventSink;
    readonly approvals?: ApprovalPort;
    readonly errors: unknown[];
    readonly options: {
        readonly permission?: Permission;
    };
    fileImageInputs?(e: Envelope): {
        type: "image";
        data: string;
        mimeType: string;
    }[];
    fileImageStatus?(e: Envelope, status: "attached" | "unsupported"): void;
    fileContext?(e: Envelope): {
        outputDir: string;
        attachments: unknown[];
        notice: string;
    };
    publishFile?(e: Envelope, name: string, mime: string, key: string, observedConversation?: Revision): unknown;
    createBot(name: string, description?: string, channelId?: string): Bot;
    channelBots(channelId?: string): Bot[];
    sendToBot(source: Envelope, to: string, text: string, key: string, options?: Envelope['peerPriority'] | {
        priority?: boolean;
    }): Envelope;
    sendToGroup(source: Envelope, text: string, key: string, priority?: boolean): Envelope[];
    sendMessage(e: Envelope, text: string, key: string, toolCallId?: string): Outbound;
    commitMessage(e: Envelope, text: string, key: string, options?: {
        toolCallId?: string;
        observedConversation?: Revision;
    }): CommitResult<Outbound>;
    askUser(e: Envelope, text: string, key: string, choices?: string[]): Question;
    startJob(e: Envelope, tool: string, args: unknown, key: string, execute: () => Promise<unknown>, options?: {
        quiet?: boolean;
        onSettled?: (state: Job['state']) => void;
    }): Job;
    waitForJob(id: string): Promise<Job>;
    assertTaskCurrent(e: Envelope, allowCancellationReply?: boolean): void;
    jobResult(botId: string, id: string, offset?: number, limit?: number): JobResultPage;
    checkpointInbox(ids: Iterable<string>, stage: 'consumed' | 'resolved'): void;
}
/** Creates the Pi session backing one bot (and optional routing scope). */
export type SessionFactory = (bot: Bot, host: BotHost, scope?: string) => Promise<BotSession>;
/** Host-owned proactive scheduling/monitoring/background-work service. */
export interface ProactivePort {
    createSchedule(source: Envelope, input: {
        key: string;
        prompt: string;
        at: number;
        timezone: string;
        intervalMs?: number;
        misfire?: Schedule['misfire'];
        overlap?: Schedule['overlap'];
    }): Schedule;
    listSchedules(botId: string): Schedule[];
    cancelSchedule(botId: string, id: string, decision?: Decision): CommitResult<Schedule>;
    createMonitor(source: Envelope, input: {
        key: string;
        detector: string;
        prompt: string;
        intervalMs: number;
        deadline: number;
    }): Monitor;
    listMonitors(botId: string): Monitor[];
    dryRunMonitor(botId: string, id: string): Promise<unknown>;
    enableMonitor(botId: string, id: string, decision?: Decision): CommitResult<Monitor>;
    cancelMonitor(botId: string, id: string, decision?: Decision): CommitResult<Monitor>;
    startBackgroundWork(source: Envelope, input: {
        kind: 'research' | 'memory';
        key: string;
        evidenceRefs: string[];
        memoryKey?: string;
    }): Proposal;
    readProposal(botId: string, id: string): Proposal;
    cancelBackgroundWork(botId: string, id: string): unknown;
    applyMemory(botId: string, id: string): MemoryRecord;
    getMemory(botId: string, key: string): MemoryRecord | undefined;
}
export interface CredentialScope {
    botId: string;
    taskId: string;
    tool: string;
}
export interface CredentialForm {
    requestId: string;
    scope: CredentialScope;
    label: string;
    expiresAt: number;
    fields: {
        name: 'secret';
        type: 'password';
        autocomplete: 'off';
    }[];
}
/** Trusted host credential broker; submitted values never enter Pi messages. */
export interface CredentialPort {
    request(scope: CredentialScope, label: string): CredentialForm;
    revoke(requestId: string): void;
}
/** The host owns persistence, correlation and client capabilities. Pi only reports events. */
export type PluginEvent = {
    type: 'toolStarted';
    toolCallId: string;
    tool: string;
    args: unknown;
} | {
    type: 'toolDelta';
    toolCallId: string;
    partial: string;
} | {
    type: 'toolCompleted';
    toolCallId: string;
    result: unknown;
    isError: boolean;
} | {
    type: 'replyDelta';
    toolCallId: string;
    textDelta: string;
} | {
    type: 'internalDelta';
    textDelta: string;
} | {
    type: 'usage';
    input: number;
    output: number;
    cacheRead: number;
    reasoning: number;
    totalTokens: number;
    costUsd: number;
} | {
    type: 'compaction';
    tokensBefore: number;
    tokensAfter: number;
};
export interface EventSink {
    emit(botId: string, event: PluginEvent): void;
}
export interface ApprovalPort {
    request(params: {
        botId: string;
        taskId: string;
        tool: string;
        args: unknown;
        sourceMessageId?: string;
        reason?: string;
    }): Promise<boolean>;
}
export async function authorize(host: BotHost, params: Parameters<Permission>[0]) {
    if (host.options.permission && !await host.options.permission(params))
        return false;
    return !host.approvals || await host.approvals.request(params);
}
