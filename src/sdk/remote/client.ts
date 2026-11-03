/**
 * Reference remote client: pairing link parsing and an E2E fetch over the relay.
 * Isomorphic (WebCrypto + global WebSocket). Backchat / Martty / mobile can port or import it.
 */
import { E2E_PATH, clientHandshake, routeToken, b64u, unb64u, type E2ESession } from '../protocol/remote-e2e.ts';
import { decodePairingLink } from '../protocol/remote-pairing.ts';
export { encodePairingLink, decodePairingLink, type PairingPayload } from '../protocol/remote-pairing.ts';

export interface RemoteResponse {
    status: number;
    headers: Record<string, string>;
    /** Full body (resolves at end of stream). */
    text(): Promise<string>;
    json(): Promise<any>;
    /** Streaming body chunks (SSE etc.). */
    chunks: AsyncIterable<Uint8Array>;
}

type Pending = { head: (r: RemoteResponse) => void; fail: (e: Error) => void; push: (c: Uint8Array | null, e?: Error) => void };

/** One E2E tunnel to a daemon through the relay. */
export class RemoteConnection {
    private next = 1;
    private pending = new Map<string, Pending>();
    private constructor(private ws: WebSocket, private session: E2ESession) {}

    static async connect(opts: { relay: string; code: string; WebSocketImpl?: typeof WebSocket }): Promise<RemoteConnection> {
        const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
        const token = await routeToken(opts.code);
        const url = new URL(opts.relay.replace(/\/+$/, '') + '/c/' + token + E2E_PATH);
        url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
        const hs = await clientHandshake(opts.code);
        const ws = new WS(url.toString());
        ws.binaryType = 'arraybuffer';
        const session = await new Promise<E2ESession>((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('E2E handshake timed out')), 15000);
            ws.onerror = () => { clearTimeout(timer); reject(Error('Relay connection failed')); };
            ws.onclose = (ev: any) => { clearTimeout(timer); reject(Error('Relay closed during handshake (' + ev.code + ')')); };
            ws.onopen = () => ws.send(JSON.stringify(hs.hello));
            ws.onmessage = async (ev: any) => {
                try {
                    const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
                    const frame = JSON.parse(text);
                    if (frame.t === 'error') throw Error('Daemon refused: ' + frame.message);
                    const { confirm, session } = await hs.finish(frame);
                    ws.send(JSON.stringify(confirm));
                    clearTimeout(timer);
                    resolve(session);
                } catch (e) { clearTimeout(timer); reject(e); ws.close(); }
            };
        });
        const conn = new RemoteConnection(ws, session);
        ws.onmessage = (ev: any) => conn.receive(ev.data);
        ws.onclose = () => conn.failAll(Error('Tunnel closed'));
        ws.onerror = () => conn.failAll(Error('Tunnel error'));
        return conn;
    }

    private failAll(e: Error) {
        for (const p of this.pending.values()) { p.fail(e); p.push(null, e); }
        this.pending.clear();
    }
    private async receive(data: any) {
        let msg: any;
        try {
            if (typeof data === 'string') throw Error('Plaintext frame after handshake');
            msg = JSON.parse(await this.session.openText(new Uint8Array(data)));
        } catch (e) { this.failAll(e as Error); this.ws.close(1008, 'e2e'); return; }
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.t === 'res') {
            const queue: (Uint8Array | null)[] = [];
            let wake: (() => void) | undefined, error: Error | undefined;
            p.push = (c, e) => { if (e) error = e; queue.push(c); wake?.(); };
            const chunks = (async function* () {
                while (true) {
                    if (!queue.length) await new Promise<void>(r => (wake = r));
                    wake = undefined;
                    const c = queue.shift()!;
                    if (c === null) { if (error) throw error; return; }
                    yield c;
                }
            })();
            let all: Promise<string> | undefined;
            const text = () => (all ??= (async () => { const parts: Uint8Array[] = []; for await (const c of chunks) parts.push(c); return new TextDecoder().decode(concatAll(parts)); })());
            p.head({ status: msg.status, headers: msg.headers ?? {}, chunks, text, json: async () => JSON.parse(await text()) });
        } else if (msg.t === 'chunk') p.push(unb64u(msg.b));
        else if (msg.t === 'end') { p.push(null); this.pending.delete(msg.id); }
        else if (msg.t === 'err') { const e = Error(msg.message ?? 'Remote error'); p.fail(e); p.push(null, e); this.pending.delete(msg.id); }
    }

    /** HTTP request to the daemon, carried inside the E2E session. Paths are daemon-local (`/rpc`, `/events`, ...). */
    async fetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}): Promise<RemoteResponse> {
        const id = String(this.next++);
        const body = init.body === undefined ? undefined : b64u(typeof init.body === 'string' ? new TextEncoder().encode(init.body) : init.body);
        const head = new Promise<RemoteResponse>((head, fail) => this.pending.set(id, { head, fail, push: () => {} }));
        this.ws.send(await this.session.seal(JSON.stringify({ t: 'req', id, method: init.method ?? 'GET', path, headers: init.headers ?? {}, body })));
        return head;
    }
    async cancel(id: string) { this.ws.send(await this.session.seal(JSON.stringify({ t: 'cancel', id }))); }
    close() { this.ws.close(); }
}
function concatAll(parts: Uint8Array[]) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/** Pair a new device from a pairing link: E2E connect, claim the ticket, return the device credential. */
export async function pairFromLink(link: string, deviceName: string) {
    const p = decodePairingLink(link);
    if (!p.relay || !p.code) throw Error('Link has no relay; pair locally with the short code instead');
    const conn = await RemoteConnection.connect({ relay: p.relay, code: p.code });
    try {
        const r = await conn.fetch('/remote/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: p.ticket, name: deviceName }) });
        const out = await r.json();
        if (r.status !== 200) throw Error('Pairing failed: ' + (out.error ?? r.status));
        return { relay: p.relay, code: p.code, deviceId: out.deviceId as string, token: out.token as string };
    } finally { conn.close(); }
}
