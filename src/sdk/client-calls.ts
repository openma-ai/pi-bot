/**
 * Client side of reverse calls: attach to a daemon and serve whitelisted
 * handlers. Transport-agnostic: give it a `fetch` that reaches the daemon's API
 * (loopback HTTP with a Bearer token, or RemoteConnection.fetch through the E2E
 * relay). Engine-agnostic: handlers are plain functions.
 *
 * Default deny: only methods registered in `handlers` are declared and served.
 */
import { ATTACH_PATH, RPC_PATH, type ClientCallResult, type ClientPost, type HubFrame } from './protocol/client-calls.ts';

export interface CallFetchResponse { status: number; chunks?: AsyncIterable<Uint8Array>; body?: ReadableStream<Uint8Array> | null; text(): Promise<string> }
export type CallFetch = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<CallFetchResponse>;
export type ClientCallHandler = (params: any, ctx: { id: string; signal: AbortSignal; deadline: number }) => Promise<unknown> | unknown;

export interface ClientCallRunnerOptions {
    fetch: CallFetch;
    handlers: Record<string, ClientCallHandler>;
    headers?: Record<string, string>;
    /** Max cached results kept for duplicate ids. */
    resultCache?: number;
    /** Max results waiting to be delivered. */
    maxOutbox?: number;
    backoff?: { minMs: number; maxMs: number };
    log?: (line: string) => void;
    onState?: (s: 'connecting' | 'online' | 'offline' | 'stopped') => void;
}

/** Loopback / plain HTTP fetch adapter (Node or browser global fetch). */
export function httpCallFetch(baseUrl: string, token: string): CallFetch {
    return async (path, init = {}) => {
        const r = await fetch(baseUrl.replace(/\/+$/, '') + path, { method: init.method ?? 'GET', headers: { ...init.headers, authorization: 'Bearer ' + token }, body: init.body, signal: init.signal });
        return { status: r.status, body: r.body, text: () => r.text() };
    };
}

async function* bytesOf(r: CallFetchResponse): AsyncIterable<Uint8Array> {
    if (r.chunks) { yield* r.chunks; return; }
    if (!r.body) return;
    const reader = r.body.getReader();
    try { while (true) { const { done, value } = await reader.read(); if (done) return; yield value; } } finally { reader.releaseLock(); }
}

export class ClientCallRunner {
    private delivered = 0;
    private done = new Map<string, ClientCallResult>();
    private running = new Map<string, AbortController>();
    private outbox: ClientCallResult[] = [];
    private ackDirty = false;
    private flushing?: Promise<void>;
    private stopped = false;
    private abort?: AbortController;
    private loop?: Promise<void>;
    private generation?: string;
    state: 'connecting' | 'online' | 'offline' | 'stopped' = 'offline';

    constructor(private opts: ClientCallRunnerOptions) {}

    get capabilities() { return Object.keys(this.opts.handlers); }

    start() { this.loop ??= this.run(); return this; }
    async stop() {
        this.stopped = true;
        this.abort?.abort();
        for (const a of this.running.values()) a.abort();
        this.setState('stopped');
        await this.loop?.catch(() => {});
    }

    private setState(s: ClientCallRunner['state']) { if (this.state !== s) { this.state = s; this.opts.onState?.(s); } }
    private log(s: string) { this.opts.log?.(s); }

    private async run() {
        const { minMs, maxMs } = this.opts.backoff ?? { minMs: 500, maxMs: 15_000 };
        let wait = minMs;
        while (!this.stopped) {
            this.setState('connecting');
            this.abort = new AbortController();
            try {
                const q = new URLSearchParams({ after: String(this.delivered), caps: this.capabilities.join(',') });
                const r = await this.opts.fetch(ATTACH_PATH + '?' + q, { headers: this.opts.headers, signal: this.abort.signal });
                if (r.status !== 200) { this.log('attach refused: ' + r.status); await r.text().catch(() => {}); if (r.status === 401 || r.status === 403) { this.stopped = true; break; } }
                else {
                    let buf = '';
                    const dec = new TextDecoder();
                    for await (const chunk of bytesOf(r)) {
                        buf += dec.decode(chunk, { stream: true });
                        let nl;
                        while ((nl = buf.indexOf('\n')) >= 0) {
                            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
                            if (line.trim()) { this.onFrame(JSON.parse(line) as HubFrame); wait = minMs; }
                        }
                    }
                }
            } catch (e) { if (!this.stopped) this.log('attach error: ' + (e as Error).message); }
            if (this.stopped) break;
            this.setState('offline');
            await new Promise(r => setTimeout(r, wait));
            wait = Math.min(wait * 2, maxMs);
        }
        this.setState('stopped');
    }

    private onFrame(f: HubFrame) {
        if (f.t === 'hello') {
            // A new hub generation (daemon restart) starts seq from 1 again.
            if (this.generation && this.generation !== f.generation) { this.delivered = 0; this.done.clear(); }
            this.generation = f.generation;
            this.setState('online');
            if (this.outbox.length) void this.flush();
            return;
        }
        if (f.t === 'cancel') { this.running.get(f.id)?.abort(); return; }
        if (f.t !== 'call') return;
        if (f.seq <= this.delivered) return; // replay of an already-accepted frame
        this.delivered = f.seq;
        this.ackDirty = true;
        const cached = this.done.get(f.id);
        if (cached) { this.push(cached); return; }
        if (this.running.has(f.id)) { void this.flush(); return; }
        const handler = Object.hasOwn(this.opts.handlers, f.method) ? this.opts.handlers[f.method] : undefined;
        if (!handler) { this.complete({ id: f.id, ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: f.method + ' is not served by this client' } }); return; }
        const ac = new AbortController();
        this.running.set(f.id, ac); // registered before the first await: ACK means "accepted"
        void this.flush();
        void (async () => {
            try { this.complete({ id: f.id, ok: true, result: await handler(f.params, { id: f.id, signal: ac.signal, deadline: f.deadline }) }); }
            catch (e: any) { this.complete({ id: f.id, ok: false, error: { code: e?.code ? String(e.code) : 'HANDLER_ERROR', message: String(e?.message ?? e) } }); }
            finally { this.running.delete(f.id); }
        })();
    }

    private complete(r: ClientCallResult) {
        this.done.set(r.id, r);
        if (this.done.size > (this.opts.resultCache ?? 256)) this.done.delete(this.done.keys().next().value!);
        this.push(r);
    }
    private push(r: ClientCallResult) {
        if (!this.outbox.some(x => x.id === r.id)) {
            this.outbox.push(r);
            const max = this.opts.maxOutbox ?? 64;
            // Keep newest; dropped results stay in `done` and are re-sent if the hub replays the call.
            while (this.outbox.length > max) this.outbox.shift();
        }
        void this.flush();
    }

    /** Deliver ack + results; retried until the daemon accepts them. */
    private flush(): Promise<void> {
        if (this.flushing) { this.flushing.then(() => { if (this.ackDirty || this.outbox.length) void this.flush(); }); return this.flushing; }
        this.flushing = (async () => {
            let wait = 200;
            while (!this.stopped && (this.ackDirty || this.outbox.length)) {
                const results = this.outbox.slice(0, 16);
                const body: ClientPost = { ack: this.delivered, results };
                this.ackDirty = false;
                try {
                    const r = await this.opts.fetch(RPC_PATH, { method: 'POST', headers: { ...this.opts.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
                    await r.text().catch(() => {});
                    if (r.status === 200) { this.outbox = this.outbox.filter(x => !results.includes(x)); wait = 200; continue; }
                    if (r.status === 401 || r.status === 403) return;
                } catch { /* retry */ }
                this.ackDirty = true;
                await new Promise(r => setTimeout(r, wait));
                wait = Math.min(wait * 2, 5000);
            }
        })().finally(() => { this.flushing = undefined; });
        return this.flushing;
    }
}
