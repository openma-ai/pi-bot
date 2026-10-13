/**
 * Typed client for the Pi Bot daemon HTTP API. Works in browsers and Node (>=18).
 *
 * Reads are unauthenticated (loopback only); every write carries the
 * per-process token obtained from `state()`. The daemon never replays a task
 * on the client's behalf, so a rejected write surfaces as `PiBotApiError`.
 */
import {
    TOKEN_HEADER,
    type AnswerRequest, type Bot, type CancelRoutineRequest, type ChatGroup, type CreateBotRequest, type CreateGroupRequest,
    type CreateRoutineRequest, type Envelope, type JobResultRequest, type Monitor, type OkResponse, type Question,
    type ReconcileRequest, type ReconcileResponse, type RoutineActionRequest, type Schedule, type SendMessageRequest, type StateResponse
} from './protocol.ts';

export class PiBotApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = 'PiBotApiError';
    }
}

export type PiBotClientOptions = {
    /** Daemon origin, e.g. `http://127.0.0.1:4317`. Empty string = same origin (GUI). */
    baseUrl?: string;
    fetch?: typeof fetch;
    /** Pre-known write token; otherwise fetched lazily via `state()`. */
    token?: string;
};

export class PiBotClient {
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;
    private token: string | undefined;

    constructor(options: PiBotClientOptions = {}) {
        this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
        this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.token = options.token;
    }

    private async request<T>(path: string, init?: RequestInit): Promise<T> {
        const response = await this.fetchImpl(this.baseUrl + '/api/' + path, init);
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok)
            throw new PiBotApiError(body.error ?? `Request failed (${response.status})`, response.status);
        return body as T;
    }

    private async post<T>(path: string, body: unknown): Promise<T> {
        this.token ??= (await this.state()).token;
        return this.request<T>(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: this.token },
            body: JSON.stringify(body)
        });
    }

    /** Full daemon snapshot; also refreshes the write token. */
    async state(): Promise<StateResponse> {
        const state = await this.request<StateResponse>('state', { cache: 'no-store' });
        this.token = state.token;
        return state;
    }

    /** Send a user message to a bot, or to a group via one of its members. */
    sendMessage(input: SendMessageRequest): Promise<Envelope | Envelope[]> {
        return this.post('message', { ...input, key: input.key ?? globalThis.crypto.randomUUID() });
    }
    createBot(input: CreateBotRequest): Promise<Bot> {
        return this.post('bot', input);
    }
    createGroup(input: CreateGroupRequest): Promise<ChatGroup> {
        return this.post('group', input);
    }
    createRoutine(input: CreateRoutineRequest): Promise<Schedule | Monitor> {
        return this.post('routine/create', input);
    }
    /** Returns the detector result for monitor `dry-run`, otherwise `{ ok: true }`. */
    routineAction(input: RoutineActionRequest): Promise<OkResponse | { decision: 'silent' | 'wake' | 'error'; error?: string }> {
        return this.post('routine/action', input);
    }
    cancelRoutine(input: CancelRoutineRequest): Promise<OkResponse> {
        return this.post('cancel', input);
    }
    jobResult(input: JobResultRequest): Promise<{ id: string; state: string; error: string | null; total: number; text: string | null; offset: number; next: number | null }> {
        return this.post('job', input);
    }
    answer(input: AnswerRequest): Promise<Question> {
        return this.post('answer', input);
    }
    /** Host review of an `uncertain` user task; never auto-replays effects. */
    reconcile(input: ReconcileRequest): Promise<ReconcileResponse> {
        return this.post('reconcile', input);
    }
}
