import { randomUUID } from 'node:crypto';
import type { PiBotDaemon } from './daemon.ts';
import type { EventEnvelope } from '../../sdk/protocol/index.ts';
import { PiBotError, toRpcError } from './errors.ts';
export class DaemonConnection {
    readonly id = randomUUID();
    /** Assigned by authenticated transport, never by RPC params. */
    fileOwner: string = "local";
    status: 'awaitingInit' | 'initializing' | 'active' | 'closed' = 'awaitingInit';
    capabilities: Record<string, any> = {};
    private inFlight = 0;
    private queue: any[] = [];
    private bytes = 0;
    private send?: (message: any) => boolean | void;
    private subscriptions = new Map<string, () => void>();
    private filters = new Map<string, any>();
    constructor(readonly daemon: PiBotDaemon, readonly transport: string) {
    }
    private fileView(value: any): any {
        if (Array.isArray(value))
            return value.map(v => this.fileView(v));
        if (!value || typeof value !== "object")
            return value;
        const out: any = {};
        for (const [key, v] of Object.entries(value)) {
            if (key === "fileOwner")
                continue;
            out[key] = key === "attachments" && Array.isArray(v) ? v.filter(f => f && this.daemon.runtime.files.owns(this.fileOwner, f.id)).map(f => this.fileView(f)) : this.fileView(v);
        }
        if (Array.isArray(value.attachments) && value.attachments.length && !out.attachments?.length && typeof out.text === "string" && out.text.startsWith("生成文件："))
            out.text = "文件仅对所属身份可见";
        return out;
    }
    async request(frame: any): Promise<any> {
        if (this.status === 'active' && frame && typeof frame.id === 'string' && frame.id.startsWith('srv_') && frame.method === undefined) {
            try {
                const request = this.daemon.runtime.store.get<any>('requests', frame.id.slice(4));
                if (!request || !this.capabilities.serverRequests?.includes(request.kind) || !this.supportsRequest(request.botId, request.threadId))
                    throw new PiBotError('forbidden', 'Request was not offered to this connection');
                return {
                    id: frame.id, result: {
                        request: this.daemon.broker.resolve(frame.id.slice(4), frame.result, this.id)
                    }
                };
            }
            catch (e) {
                return {
                    id: frame.id, error: toRpcError(e)
                };
            }
        }
        if (frame?.method === 'initialized' && frame.id === undefined) {
            if (this.status === 'initializing')
                this.status = 'active';
            return;
        }
        try {
            if (this.status === 'closed')
                throw new PiBotError('invalidRequest', 'Connection closed');
            if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.method !== 'string' || (frame.jsonrpc !== undefined && frame.jsonrpc !== '2.0') || (frame.id !== undefined && typeof frame.id !== 'number' && typeof frame.id !== 'string'))
                throw new PiBotError('invalidRequest', 'Invalid RPC request');
            if (Buffer.byteLength(JSON.stringify(frame)) > 1024 * 1024)
                throw new PiBotError('invalidParams', 'Request too large');
            if (this.inFlight >= 32)
                throw new PiBotError('overloaded', 'Too many concurrent requests');
            this.inFlight++;
            try {
                const result = this.fileView(await this.daemon.router.dispatch(this, frame.method, frame.params ?? {}));
                return frame.id === undefined ? undefined : {
                    jsonrpc: '2.0', id: frame.id, result
                };
            }
            finally {
                this.inFlight--;
            }
        }
        catch (error) {
            return {
                jsonrpc: '2.0', id: frame?.id ?? null, error: toRpcError(error)
            };
        }
    }
    accepts(e: EventEnvelope) {
        if (this.capabilities.optOutNotifications?.includes(e.method))
            return false;
        if (e.method === 'item/internal/delta' && !this.capabilities.debugInternal)
            return false;
        if (e.method === 'item/agentMessage/delta' && !this.capabilities.streamingReplies)
            return false;
        return true;
    }
    push(frame: any) {
        frame = this.fileView(frame);
        if (this.status === 'closed' || !this.accepts(frame))
            return;
        if (this.send && this.queue.length === 0 && this.send(frame) !== false)
            return;
        const size = Buffer.byteLength(JSON.stringify(frame));
        if (this.queue.length >= 1000 || this.bytes + size > 8 * 1024 * 1024) {
            if (frame.seq === null)
                return;
            this.close('lagged');
            return;
        }
        this.queue.push(frame);
        this.bytes += size;
    }
    attach(send: (frame: any) => boolean | void) {
        this.send = send;
        this.flush();
        return () => {
            this.send = undefined;
        };
    }
    flush() {
        while (this.send && this.queue.length) {
            const frame = this.queue[0];
            if (this.send(frame) === false)
                break;
            this.queue.shift();
            this.bytes -= Buffer.byteLength(JSON.stringify(frame));
        }
    }
    replay(after: number) {
        for (const e of this.daemon.log.read(after))
            if ([...this.filters.values()].some(filter => this.daemon.log.matches(e, filter)))
                this.push(e);
            else if (e.seq !== null && this.filters.size)
                this.push({
                    seq: null, at: e.at, method: 'events/watermark', params: {
                        seq: e.seq
                    }
                });
    }
    subscribe(after: number, filter?: any) {
        const id = randomUUID();
        this.filters.set(id, filter ?? {});
        const subscription = this.daemon.log.subscribe(after, e => this.push(e), filter);
        this.subscriptions.set(id, subscription.close);
        this.daemon.broker?.sendPending(this);
        return {
            subscriptionId: id, replayedThrough: subscription.through
        };
    }
    unsubscribe(id: string) {
        this.subscriptions.get(id)?.();
        this.subscriptions.delete(id);
        this.filters.delete(id);
    }
    supportsRequest(botId: string, threadId: string) {
        return [...this.filters.values()].some(f => (!f.botIds || f.botIds.includes(botId)) && (!f.threadIds || f.threadIds.includes(threadId)));
    }
    close(reason = 'closed') {
        if (this.status === 'closed')
            return;
        this.status = 'closed';
        for (const close of this.subscriptions.values())
            close();
        this.subscriptions.clear();
        this.filters.clear();
        this.daemon.log.forget(this.id);
        this.send?.({
            method: 'connection/closed', params: {
                reason
            }
        });
        this.send = undefined;
        this.queue = [];
        this.bytes = 0;
        this.daemon.connections.delete(this.id);
    }
}
