/**
 * Optional relay agent (off unless a relay URL is configured). Speaks the
 * alma-relay wire protocol (docs: yetone/alma-relay docs/PROTOCOL.md, proto 2
 * with proto 1 fallback) and serves ONLY end-to-end encrypted tunnels on
 * `/__pibot_e2e__`. Plaintext `hreq` gets 403 and any other `wopen` gets
 * `werr`, because only the relay itself could have sent them.
 *
 * Inside an established E2E session, requests are replayed against the
 * daemon's loopback HTTP API, which enforces paired-device auth itself.
 */
import WebSocket from 'ws';
import { E2E_PATH, daemonHandshake, routeToken, routeTokenHash, unb64u, b64u, type E2ESession } from '../../sdk/protocol/remote-e2e.ts';

const BIN = { HCHUNK: 1, HBODY: 2, WBIN: 3, WTEXT: 4 } as const;
function encodeBinary(kind: number, id: string, payload: Uint8Array) {
    const idb = Buffer.from(id, 'utf8');
    return Buffer.concat([Buffer.from([kind, idb.length]), idb, Buffer.from(payload)]);
}
function decodeBinary(data: Buffer) {
    if (data.length < 2) return undefined;
    const kind = data[0]!, n = data[1]!;
    return { kind, id: data.subarray(2, 2 + n).toString('utf8'), payload: data.subarray(2 + n) };
}

export interface RelayAgentOptions {
    relayUrl: string;
    connectCode: () => string;
    localUrl: string;
    registrationKey?: string;
    name?: string;
    /** Observability without secrets: frame kind and size only. */
    onFrame?: (info: { dir: 'in' | 'out'; kind: string; bytes: number; sample?: string }) => void;
    log?: (line: string) => void;
}

const HOP = new Set(['host', 'origin', 'cookie', 'connection', 'upgrade', 'content-length', 'transfer-encoding', 'keep-alive', 'x-pibot-csrf']);

export function startRelayAgent(opts: RelayAgentOptions) {
    const log = opts.log ?? (() => {});
    let ws: WebSocket | undefined, stopped = false, retry = 1000, timer: NodeJS.Timeout | undefined, proto = 1;
    let status: 'connecting' | 'registered' | 'offline' | 'stopped' = 'connecting';
    const tunnels = new Map<string, Tunnel>();

    const sendJson = (f: any) => { if (ws?.readyState === WebSocket.OPEN) { const s = JSON.stringify(f); opts.onFrame?.({ dir: 'out', kind: f.t, bytes: s.length }); ws.send(s); } };
    const sendWs = (id: string, payload: Uint8Array | string) => {
        if (ws?.readyState !== WebSocket.OPEN) return;
        if (typeof payload === 'string') {
            opts.onFrame?.({ dir: 'out', kind: 'wmsg-text', bytes: payload.length });
            if (proto >= 2) ws.send(encodeBinary(BIN.WTEXT, id, Buffer.from(payload)));
            else ws.send(JSON.stringify({ t: 'wmsg', id, s: payload }));
        } else {
            opts.onFrame?.({ dir: 'out', kind: 'wmsg-bin', bytes: payload.length, sample: Buffer.from(payload.subarray(0, 24)).toString('hex') });
            if (proto >= 2) ws.send(encodeBinary(BIN.WBIN, id, payload));
            else ws.send(JSON.stringify({ t: 'wmsg', id, b: Buffer.from(payload).toString('base64') }));
        }
    };

    class Tunnel {
        session?: E2ESession;
        pending?: Promise<void>;
        state: 'hello' | 'confirm' | 'open' = 'hello';
        verify?: (c: any) => Promise<E2ESession>;
        aborts = new Map<string, AbortController>();
        constructor(public id: string) {}
        fail(reason: string) {
            sendJson({ t: 'wclose', id: this.id, code: 1008, reason });
            this.close();
        }
        close() { for (const a of this.aborts.values()) a.abort(); tunnels.delete(this.id); }
        chain: Promise<void> = Promise.resolve();
        onMessage(data: Buffer, text: boolean) { this.chain = this.chain.then(() => this.process(data, text)); }
        async process(data: Buffer, text: boolean) {
            if (!tunnels.has(this.id)) return;
            try {
                if (this.state === 'hello') {
                    if (!text) return this.fail('handshake');
                    const hs = await daemonHandshake(opts.connectCode(), JSON.parse(data.toString('utf8')));
                    this.verify = hs.verify; this.state = 'confirm';
                    sendWs(this.id, JSON.stringify(hs.welcome));
                    return;
                }
                if (this.state === 'confirm') {
                    if (!text) return this.fail('handshake');
                    this.session = await this.verify!(JSON.parse(data.toString('utf8')));
                    this.state = 'open';
                    return;
                }
                if (text) return this.fail('plaintext');
                const msg = JSON.parse(await this.session!.openText(new Uint8Array(data)));
                if (msg.t === 'cancel') { this.aborts.get(String(msg.id))?.abort(); return; }
                if (msg.t === 'req') void this.handle(msg);
            } catch {
                this.fail('e2e');
            }
        }
        async send(m: any) { sendWs(this.id, await this.session!.seal(JSON.stringify(m))); }
        async handle(m: any) {
            const id = String(m.id);
            const path = String(m.path ?? '/');
            if (!path.startsWith('/') || path.startsWith('//')) return this.send({ t: 'err', id, message: 'Bad path' });
            const abort = new AbortController();
            this.aborts.set(id, abort);
            try {
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(m.headers ?? {})) if (!HOP.has(k.toLowerCase())) headers[k] = String(v);
                headers['x-pibot-transport'] = 'relay-e2e';
                const method = String(m.method ?? 'GET').toUpperCase();
                const r = await fetch(opts.localUrl + path, { method, headers, body: m.body && method !== 'GET' && method !== 'HEAD' ? Buffer.from(unb64u(m.body)) : undefined, signal: abort.signal, redirect: 'manual' });
                const out: Record<string, string> = {};
                r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
                await this.send({ t: 'res', id, status: r.status, headers: out });
                if (r.body) for await (const chunk of r.body as any) await this.send({ t: 'chunk', id, b: b64u(chunk) });
                await this.send({ t: 'end', id });
            } catch (e) {
                if (this.session) await this.send({ t: 'err', id, message: abort.signal.aborted ? 'Cancelled' : 'Local request failed' }).catch(() => {});
            } finally { this.aborts.delete(id); }
        }
    }

    async function dial() {
        if (stopped) return;
        status = 'connecting';
        const token = await routeToken(opts.connectCode());
        const th = await routeTokenHash(token);
        const u = new URL(opts.relayUrl.replace(/\/+$/, '') + '/agent');
        u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
        u.searchParams.set('th', th);
        const sock = new WebSocket(u, { maxPayload: 32 * 1024 * 1024 });
        ws = sock;
        sock.on('open', () => {
            sock.send(JSON.stringify({ t: 'register', tokenHash: th, name: opts.name ?? 'pi-bot', ver: 'pi-bot', proto: 2, ...(opts.registrationKey ? { key: opts.registrationKey } : {}) }));
        });
        sock.on('message', (data: Buffer, isBinary: boolean) => {
            if (isBinary) {
                const f = decodeBinary(data);
                if (!f) return;
                opts.onFrame?.({ dir: 'in', kind: f.kind === BIN.WTEXT ? 'wmsg-text' : f.kind === BIN.WBIN ? 'wmsg-bin' : 'bin' + f.kind, bytes: f.payload.length, sample: f.kind === BIN.WBIN ? f.payload.subarray(0, 24).toString('hex') : undefined });
                const t = tunnels.get(f.id);
                if (t && (f.kind === BIN.WBIN || f.kind === BIN.WTEXT)) void t.onMessage(Buffer.from(f.payload), f.kind === BIN.WTEXT);
                return;
            }
            let f: any;
            try { f = JSON.parse(data.toString('utf8')); } catch { return; }
            opts.onFrame?.({ dir: 'in', kind: String(f.t), bytes: data.length });
            switch (f.t) {
                case 'registered': proto = f.proto === 2 ? 2 : 1; status = 'registered'; retry = 1000; log('relay: registered (protocol ' + proto + ')'); break;
                case 'error': log('relay: registration refused'); break;
                case 'hreq': // E2E only: the relay (or anyone holding the route token) gets nothing in plaintext.
                    sendJson({ t: 'hres', id: f.id, status: 403, headers: { 'content-type': 'application/json' } });
                    if (proto >= 2) sock.send(encodeBinary(BIN.HCHUNK, f.id, Buffer.from('{"error":"End-to-end encryption required"}')));
                    else sendJson({ t: 'hchunk', id: f.id, b: Buffer.from('{"error":"End-to-end encryption required"}').toString('base64') });
                    sendJson({ t: 'hend', id: f.id });
                    break;
                case 'wopen': {
                    const path = String(f.path ?? '').split('?')[0];
                    if (path !== E2E_PATH || tunnels.size >= 64) { sendJson({ t: 'werr', id: f.id, message: 'Not found' }); break; }
                    tunnels.set(f.id, new Tunnel(f.id));
                    sendJson({ t: 'wopened', id: f.id });
                    break;
                }
                case 'wmsg': {
                    const t = tunnels.get(f.id);
                    if (t) void t.onMessage(f.b !== undefined ? Buffer.from(f.b, 'base64') : Buffer.from(String(f.s ?? '')), f.b === undefined);
                    break;
                }
                case 'wclose': tunnels.get(f.id)?.close(); break;
            }
        });
        sock.on('close', (code: number) => {
            for (const t of [...tunnels.values()]) t.close();
            status = 'offline';
            if (stopped) return;
            if (code === 4000 || code === 4003 || code === 4401 || code === 4002) { log('relay: closed with ' + code + '; not redialing'); return; }
            timer = setTimeout(() => void dial(), retry);
            retry = Math.min(retry * 2, 30000);
        });
        sock.on('error', () => log('relay: connection error'));
    }
    void dial();
    return {
        get status() { return stopped ? 'stopped' : status; },
        /** Call after the connect code rotates: drops tunnels and re-registers under the new route. */
        reconnect() { if (timer) clearTimeout(timer); ws?.removeAllListeners('close'); ws?.close(); for (const t of [...tunnels.values()]) t.close(); retry = 1000; void dial(); },
        /** Drop tunnels whose requests belong to nothing anymore (e.g. on revoke the API rejects them anyway). */
        async close() { stopped = true; if (timer) clearTimeout(timer); ws?.close(); }
    };
}
