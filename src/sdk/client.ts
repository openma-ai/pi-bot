import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import { methods, PROTOCOL_VERSION, type EventEnvelope, type Snapshot } from './protocol/index.ts';
import { InProcessTransport } from './transports/in-process.ts';
import { HttpSseTransport } from './transports/http-sse.ts';
import type { RpcTransport } from './transports/types.ts';
import { browserCsrf } from './browser-session.ts';
export class PiBotApiError extends Error {
    constructor(message: string, readonly reason: string, readonly retryable = false, readonly details?: unknown) {
        super(message);
        this.name = 'PiBotApiError';
    }
}
type Method = keyof typeof methods;
type Call<M extends Method> = (params: Static<(typeof methods)[M]['params']>) => Promise<Static<(typeof methods)[M]['result']>>;
type Namespace<N extends string> = {
    [M in Method as M extends `${N}/${infer Name}` ? Name : never]: Call<M>;
};
export type ConnectOptions = {
    transport?: {
        inProcess: {
            connect(transport?: string): any;
        };
    } | {
        http: string;
        token?: string;
    } | RpcTransport;
    clientInfo?: {
        name: string;
        version: string;
    };
    capabilities?: Record<string, unknown>;
    csrf?: string;
    auth?: () => Promise<{
        token?: string;
        csrf?: string;
    }>;
};
export class PiBotClient {
    declare readonly file: Namespace<'file'>;
    declare readonly daemon: Namespace<'daemon'>;
    declare readonly bot: Namespace<'bot'>;
    declare readonly group: Namespace<'group'>;
    declare readonly thread: Namespace<'thread'>;
    declare readonly turn: Namespace<'turn'>;
    declare readonly routine: Namespace<'routine'>;
    declare readonly job: Namespace<'job'>;
    declare readonly request: Namespace<'request'>;
    declare readonly task: Namespace<'task'>;
    declare readonly desktop: Namespace<'desktop'>;
    readonly events: {
        subscribe: (p: {
            after: number;
            filter?: any;
        }, receive: (e: EventEnvelope) => void) => Promise<() => void>;
        ack: (seq: number) => Promise<any>;
    };
    private id = 0;
    private closed = false;
    private connectionId = '';
    private stopListen?: () => void;
    private observers = new Set<(e: EventEnvelope) => void>();
    private listeners = new Map<string, Set<(data: any) => void>>();
    private lastSeq = 0;
    private subscription?: {
        after: number;
        filter?: any;
    };
    private reconnecting = false;
    private constructor(readonly transport: RpcTransport, readonly options: ConnectOptions) {
        for (const name of Object.keys(methods)) {
            if (!name.includes('/'))
                continue;
            const [namespace, method] = name.split('/');
            (this as any)[namespace] ??= {};
            (this as any)[namespace][method] = (p: any = {}) => this.call(name as Method, p);
        }
        this.events = {
            subscribe: async (p, receive) => {
                this.subscription = p;
                this.lastSeq = p.after;
                this.observers.add(receive);
                const result: any = await this.call('events/subscribe', p);
                return () => {
                    this.observers.delete(receive);
                    void this.call('events/unsubscribe', {
                        subscriptionId: result.subscriptionId
                    }).catch(() => {
                    });
                };
            }, ack: seq => this.call('events/ack', {
                seq
            })
        };
    }
    static async connect(options: ConnectOptions = {}) {
        const t = options.transport;
        let transport: RpcTransport;
        if (t && 'inProcess' in t)
            transport = new InProcessTransport(t.inProcess);
        else if (t && 'request' in t)
            transport = t;
        else {
            const http = t && 'http' in t ? t : {
                http: ''
            };
            const csrf = options.csrf ?? browserCsrf(http.http);
            transport = new HttpSseTransport(http.http, http.token, globalThis.fetch.bind(globalThis), csrf, options.auth);
        }
        const client = new PiBotClient(transport, options);
        await client.initialize();
        return client;
    }
    private async initialize() {
        const r = await this.transport.request({
            id: ++this.id, method: 'initialize', params: {
                clientInfo: this.options.clientInfo ?? {
                    name: 'pi-bot-client', version: '0.2.0'
                }, protocolVersion: PROTOCOL_VERSION, capabilities: this.options.capabilities ?? {}
            }
        });
        if (r.error)
            throw new PiBotApiError(r.error.message, r.error.data.reason);
        this.connectionId = r.result.connectionId;
        this.transport.setConnection?.(this.connectionId);
        await this.transport.request({
            method: 'initialized'
        });
        this.stopListen?.();
        this.stopListen = this.transport.listen?.(f => this.receive(f), () => void this.reconnect());
    }
    async call<M extends Method>(method: M, params: unknown = {}): Promise<Static<(typeof methods)[M]['result']>> {
        if (this.closed)
            throw new PiBotApiError('Client closed', 'invalidRequest');
        const schema = methods[method];
        if (!Value.Check(schema.params, params))
            throw new PiBotApiError('Invalid method parameters', 'invalidParams', false, {
                paths: [...Value.Errors(schema.params, params)].map((e: any) => e.instancePath ?? e.path)
            });
        for (let attempt = 0;; attempt++) {
            const reply = await this.transport.request({
                jsonrpc: '2.0', id: ++this.id, method, params
            });
            if (!reply?.error)
                return reply?.result;
            const error = new PiBotApiError(reply.error.message, reply.error.data.reason, reply.error.data.retryable, reply.error.data.details);
            if (!['overloaded', 'capacity'].includes(error.reason) || attempt >= 3)
                throw error;
            await new Promise(r => setTimeout(r, 100 * 2 ** attempt + Math.random() * 50));
        }
    }
    private receive(frame: any) {
        if (frame.method === 'connection/closed') {
            void this.reconnect();
            return;
        }
        if (frame.id !== undefined) {
            this.emit('request', frame);
            return;
        }
        if (frame.seq !== null && frame.seq !== undefined) {
            if (frame.seq <= this.lastSeq)
                return;
            this.lastSeq = frame.seq;
        }
        if (frame.method === 'events/watermark')
            this.lastSeq = Math.max(this.lastSeq, frame.params.seq);
        for (const f of this.observers)
            f(frame);
        this.emit(frame.method, frame.params);
    }
    private async reconnect() {
        if (this.closed || this.reconnecting)
            return;
        this.reconnecting = true;
        this.emit('disconnected', {});
        let attempt = 0;
        while (!this.closed) {
            try {
                await this.transport.refreshAuth?.();
                await this.initialize();
                if (this.subscription)
                    await this.call('events/subscribe', {
                        ...this.subscription, after: this.lastSeq
                    });
                this.reconnecting = false;
                this.emit('connected', {});
                return;
            }
            catch (e) {
                if((e as any)?.reason==='authenticationRequired'){this.reconnecting=false;this.emit('authenticationRequired',{});return;}
                if (e instanceof PiBotApiError && e.reason === 'cursorExpired') {
                    this.emit('cursorExpired', {});
                    this.reconnecting = false;
                    return;
                }
                await new Promise(r => setTimeout(r, Math.min(5000, 250 * 2 ** Math.min(attempt++, 5))));
            }
        }
        this.reconnecting = false;
    }
    on(name: string, receive: (data: any) => void) {
        const set = this.listeners.get(name) ?? new Set();
        set.add(receive);
        this.listeners.set(name, set);
        return () => set.delete(receive);
    }
    private emit(name: string, data: any) {
        for (const f of this.listeners.get(name) ?? [])
            try {
                void Promise.resolve(f(data)).catch(() => {
                });
            }
            catch {
            }
    }
    onRequest(kind: string, handle: (request: any) => Promise<any>) {
        return this.on('request', async (frame) => {
            if (frame.method === 'request/' + kind) {
                const response = await handle(frame.params.request);
                await this.request.resolve({
                    requestId: frame.params.request.id, response
                });
            }
        });
    }
    close() {
        this.closed = true;
        this.stopListen?.();
        this.transport.close();
        this.observers.clear();
    }
}
