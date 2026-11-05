/**
 * ClientCallHub: daemon-side end of reverse calls (see sdk/protocol/client-calls.ts).
 * Transport-agnostic: an attach hands the hub a `write(frame)` sink; HTTP wiring
 * lives in transports/http.ts.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CLIENT_CALL_LIMITS, CLIENT_CALL_PROTOCOL, type ClientCallOutcome, type ClientPost, type ClientPresence, type HubFrame } from '../../sdk/protocol/client-calls.ts';

type Limits = { -readonly [K in keyof typeof CLIENT_CALL_LIMITS]: number };
interface Pending { resolve: (o: ClientCallOutcome) => void; timer: NodeJS.Timeout; method: string }
interface Unacked { seq: number; id: string; line: string; bytes: number }
interface Waiting { id: string; method: string; params: unknown; deadline: number; bytes: number; line?: string }

class ClientState {
    presence: ClientPresence = 'unknown';
    seq = 0;
    unacked: Unacked[] = [];
    unackedBytes = 0;
    caps = new Set<string>();
    sink?: { write: (line: string) => boolean; close: () => void; token: symbol };
    waiting: Waiting[] = [];
    done = new Map<string, true>();
    lastSeen = 0;
}

export interface HubOptions {
    /** Methods the daemon may call on clients. Default deny: empty = nothing callable. */
    allow?: Iterable<string>;
    limits?: Partial<Limits>;
    now?: () => number;
}

export class ClientCallHub extends EventEmitter {
    readonly generation = randomUUID();
    readonly limits: Limits;
    private allow: Set<string>;
    private clients = new Map<string, ClientState>();
    private pending = new Map<string, Pending>();
    private closed = false;
    private ping: NodeJS.Timeout;
    private now: () => number;

    constructor(opts: HubOptions = {}) {
        super();
        this.allow = new Set(opts.allow ?? []);
        this.limits = { ...CLIENT_CALL_LIMITS, ...opts.limits };
        this.now = opts.now ?? Date.now;
        this.ping = setInterval(() => { for (const c of this.clients.values()) c.sink?.write(JSON.stringify({ t: 'ping' } satisfies HubFrame) + '\n'); }, this.limits.pingMs);
        this.ping.unref();
    }

    allowed(method: string) { return this.allow.has(method); }
    setAllowlist(methods: Iterable<string>) { this.allow = new Set(methods); }
    presence(clientId: string): ClientPresence { return this.clients.get(clientId)?.presence ?? 'unknown'; }
    list() { return [...this.clients].map(([id, c]) => ({ id, presence: c.presence, capabilities: [...c.caps], unacked: c.unacked.length, lastSeen: c.lastSeen || null })); }

    private state(id: string) {
        let c = this.clients.get(id);
        if (!c) this.clients.set(id, c = new ClientState());
        return c;
    }
    private setPresence(id: string, c: ClientState, p: ClientPresence) {
        if (c.presence === p) return;
        c.presence = p;
        this.emit('presence', { id, presence: p });
    }

    /**
     * A client stream attached. `after` = highest seq the client has already
     * accepted; anything later still unacked is replayed in order.
     * Returns a detach function. A newer attach replaces the older stream.
     */
    attach(clientId: string, opts: { after: number; capabilities: string[] }, sink: { write: (line: string) => boolean; close: () => void }) {
        if (this.closed) { sink.close(); return () => {}; }
        const c = this.state(clientId);
        const old = c.sink;
        const token = Symbol('attach');
        c.sink = { ...sink, token };
        old?.close();
        c.caps = new Set(opts.capabilities);
        c.lastSeen = this.now();
        this.ack(c, opts.after);
        sink.write(JSON.stringify({ t: 'hello', protocol: CLIENT_CALL_PROTOCOL, generation: this.generation, replayFrom: c.unacked[0]?.seq ?? c.seq + 1 } satisfies HubFrame) + '\n');
        for (const u of c.unacked) sink.write(u.line);
        this.setPresence(clientId, c, 'online');
        const waiting = c.waiting.splice(0);
        for (const w of waiting) {
            if (!this.pending.has(w.id)) continue;
            const pre = this.precheck(c, w.method, w.bytes);
            if (pre) this.finish(w.id, pre);
            else this.enqueue(c, w);
        }
        return () => {
            if (c.sink?.token !== token) return;
            c.sink = undefined;
            this.setPresence(clientId, c, 'offline');
        };
    }

    /** Explicitly forget a client (revoked device). Pending calls fail as offline. */
    drop(clientId: string) {
        const c = this.clients.get(clientId);
        if (!c) return;
        c.sink?.close(); c.sink = undefined;
        this.setPresence(clientId, c, 'offline');
        for (const w of c.waiting.splice(0)) this.finish(w.id, { status: 'error', code: 'DEVICE_OFFLINE', message: 'Device removed', notSent: true });
    }

    /** POST from the client: cumulative ack and/or results. Idempotent. */
    receive(clientId: string, body: ClientPost) {
        const c = this.clients.get(clientId);
        if (!c) return { accepted: 0 };
        c.lastSeen = this.now();
        if (typeof body.ack === 'number') this.ack(c, body.ack);
        let accepted = 0;
        for (const r of body.results ?? []) {
            const id = String(r.id);
            if (c.done.has(id)) continue; // duplicate result (client retry)
            c.done.set(id, true);
            if (c.done.size > this.limits.resultCache) c.done.delete(c.done.keys().next().value!);
            const p = this.pending.get(id);
            if (!p) { this.emit('lateResult', { clientId, ...r }); continue; }
            accepted++;
            this.finish(id, r.ok ? { status: 'ok', result: r.result } : { status: 'error', code: r.error?.code ?? 'HANDLER_ERROR', message: r.error?.message ?? 'Client handler failed', notSent: false });
        }
        return { accepted };
    }

    private ack(c: ClientState, upTo: number) {
        while (c.unacked.length && c.unacked[0]!.seq <= upTo) c.unackedBytes -= c.unacked.shift()!.bytes;
    }

    private precheck(c: ClientState, method: string, bytes: number): ClientCallOutcome | undefined {
        if (c.presence === 'online' && !c.caps.has(method)) return { status: 'error', code: 'CAPABILITY_MISSING', message: `Client did not declare ${method}`, notSent: true };
        if (c.unacked.length >= this.limits.maxUnacked || c.unackedBytes + bytes > this.limits.maxUnackedBytes)
            return { status: 'error', code: 'BACKPRESSURE', message: 'Client is not keeping up; call was not sent', notSent: true };
        return undefined;
    }

    private enqueue(c: ClientState, w: Waiting) {
        const seq = ++c.seq;
        const line = JSON.stringify({ t: 'call', seq, id: w.id, method: w.method, params: w.params, deadline: w.deadline } satisfies HubFrame) + '\n';
        const bytes = Buffer.byteLength(line);
        c.unacked.push({ seq, id: w.id, line, bytes });
        c.unackedBytes += bytes;
        c.sink?.write(line);
    }

    private finish(id: string, o: ClientCallOutcome) {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(o);
    }

    /**
     * Call `method` on an explicit target client. Never throws; see ClientCallOutcome.
     * `timeout` means the effect is unknown, not that the call was cancelled.
     */
    call(target: string, method: string, params: unknown = {}, opts: { timeoutMs?: number; id?: string } = {}): Promise<ClientCallOutcome> {
        const fail = (code: string, message: string): Promise<ClientCallOutcome> => Promise.resolve({ status: 'error', code, message, notSent: true });
        if (this.closed) return fail('HUB_CLOSED', 'Hub closed');
        if (!this.allow.has(method)) return fail('METHOD_NOT_ALLOWED', `${method} is not on the allowlist`);
        const id = opts.id ?? randomUUID();
        if (this.pending.has(id)) return fail('DUPLICATE_ID', 'Call id already in flight');
        const bytes = Buffer.byteLength(JSON.stringify(params ?? null));
        if (bytes > this.limits.maxFrameBytes) return fail('FRAME_TOO_LARGE', 'Params too large');
        const c = this.state(target);
        if (c.presence === 'offline') return fail('DEVICE_OFFLINE', `${target} is offline`);
        const pre = this.precheck(c, method, bytes);
        if (pre) return Promise.resolve(pre);
        if (c.presence === 'unknown' && c.waiting.length >= this.limits.maxWaiting) return fail('BACKPRESSURE', 'Too many calls waiting for an unseen client');
        const timeoutMs = opts.timeoutMs ?? this.limits.defaultTimeoutMs;
        const deadline = this.now() + timeoutMs;
        return new Promise<ClientCallOutcome>(resolve => {
            const timer = setTimeout(() => {
                const idx = c.waiting.findIndex(w => w.id === id);
                if (idx >= 0) { c.waiting.splice(idx, 1); return this.finish(id, { status: 'error', code: 'DEVICE_OFFLINE', message: `${target} never attached`, notSent: true }); }
                // Sent (or queued for replay): best-effort cancel, but the effect stays unknown.
                c.sink?.write(JSON.stringify({ t: 'cancel', id } satisfies HubFrame) + '\n');
                this.finish(id, { status: 'timeout', effect: 'unknown' });
            }, timeoutMs);
            this.pending.set(id, { resolve, timer, method });
            const w = { id, method, params, deadline, bytes };
            if (c.presence === 'unknown') c.waiting.push(w);
            else this.enqueue(c, w);
        });
    }

    close() {
        this.closed = true;
        clearInterval(this.ping);
        for (const id of [...this.pending.keys()]) this.finish(id, { status: 'error', code: 'HUB_CLOSED', message: 'Hub closed', notSent: false });
        for (const c of this.clients.values()) { c.sink?.close(); c.sink = undefined; }
    }
}
