// One registered relay agent socket: forwards tunneled HTTP and WebSocket
// traffic to the local pi-bot backend.
//
// The relay only speaks the wire protocol; it does not understand pi-bot. In
// particular this session rewrites Host and Origin to the backend origin,
// because the pi-bot daemon rejects anything else (and because the relay
// strips the incoming Host before forwarding).

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { WebSocket } from 'ws';
import { BIN, decodeBinary, encodeBinary, negotiateProtocol } from './binary.mjs';

const MAX_FRAME = 32 * 1024 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const DRAIN_INTERVAL_MS = 10;
const REGISTER_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 1_000;

// Hop-by-hop headers are meaningful for one connection only. Content-Length
// is recomputed, and the relay already deletes it from tunneled requests.
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A close before registration, carrying the relay's close code. */
export class RelayCloseError extends Error {
    constructor(message, closeCode) {
        super(message);
        this.name = 'RelayCloseError';
        this.closeCode = closeCode;
    }
}

/**
 * Dial the relay, register, and resolve once it acknowledges protocol
 * negotiation. `closed` resolves when the socket goes away; `close()` asks
 * for a clean shutdown.
 */
export function connectRelay({ relayUrl, tokenHash, name, version, key, backend }) {
    const url = new URL(relayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/agent';
    url.search = '';
    url.searchParams.set('th', tokenHash);

    const ws = new WebSocket(url, {
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: MAX_FRAME,
        perMessageDeflate: false,
    });

    let session = null;
    let registered = false;
    let lastError = null;
    let registerTimer = null;
    let heartbeat = null;
    let alive = true;
    let resolveReady;
    let rejectReady;
    let resolveClosed;

    const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const closed = new Promise(resolve => {
        resolveClosed = resolve;
    });

    const failRegistration = error => {
        if (registered) return;
        if (!lastError) lastError = error;
        rejectReady(lastError);
    };

    ws.on('open', () => {
        alive = true;
        try {
            ws.send(JSON.stringify({
                t: 'register',
                tokenHash,
                name,
                ver: version,
                ...(key ? { key } : {}),
                proto: 2,
            }));
        } catch (error) {
            failRegistration(error);
            ws.terminate();
            return;
        }
        registerTimer = setTimeout(() => {
            if (registered) return;
            failRegistration(new RelayCloseError('relay did not acknowledge registration within 10 s', null));
            ws.terminate();
        }, REGISTER_TIMEOUT_MS);
        heartbeat = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (!alive) {
                ws.terminate();
                return;
            }
            alive = false;
            try {
                ws.ping();
            } catch {
                // The close handler owns cleanup.
            }
        }, HEARTBEAT_MS);
    });

    ws.on('pong', () => {
        alive = true;
    });

    ws.on('message', (data, isBinary) => {
        if (session) {
            session.handle(data, isBinary);
            return;
        }
        if (isBinary) return;
        let frame;
        try {
            frame = JSON.parse(data.toString());
        } catch {
            return;
        }
        if (frame?.t === 'registered') {
            if (registered) return;
            registered = true;
            clearTimeout(registerTimer);
            registerTimer = null;
            const proto = negotiateProtocol(2, frame.proto);
            session = new RelaySession({ ws, backend, proto });
            resolveReady({ proto, session });
            return;
        }
        if (frame?.t === 'error') {
            const error = new RelayCloseError(`relay rejected registration: ${frame.message || 'unknown error'}`, null);
            error.fatal = true;
            lastError = error;
            rejectReady(error);
        }
    });

    ws.on('error', error => {
        if (!lastError) lastError = error;
        rejectReady(lastError);
    });

    // Without this listener a non-101 handshake can leave the client hanging.
    ws.on('unexpected-response', (_request, response) => {
        const error = new RelayCloseError(`relay handshake failed with HTTP ${response.statusCode}`, null);
        error.fatal = response.statusCode >= 400 && response.statusCode < 500;
        lastError = error;
        rejectReady(error);
        response.resume();
        ws.terminate();
    });

    ws.on('close', (code, reason) => {
        clearTimeout(registerTimer);
        clearInterval(heartbeat);
        session?.dispose();

        const detail = reason?.length ? `: ${reason.toString()}` : '';
        if (!registered) {
            if (lastError instanceof RelayCloseError) {
                lastError.closeCode ??= code;
                rejectReady(lastError);
            } else if (lastError) {
                rejectReady(new RelayCloseError(`${lastError.message} (close ${code}${detail})`, code));
            } else {
                rejectReady(new RelayCloseError(`relay closed before registration (${code}${detail})`, code));
            }
        }
        resolveClosed({ code, reason: reason?.toString() || '' });
    });

    const close = () => {
        if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) return;
        try {
            ws.close(1000, 'agent stopping');
        } catch {
            ws.terminate();
        }
        const timer = setTimeout(() => {
            if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        }, CLOSE_TIMEOUT_MS);
        timer.unref?.();
    };

    return { ready, closed, close, get session() { return session; } };
}

/**
 * A protocol-1 or protocol-2 relay session. Protocol 2 adds binary payload
 * frames and streamed request bodies; the JSON forms remain accepted.
 */
class RelaySession {
    constructor({ ws, backend, proto }) {
        this.ws = ws;
        this.backend = backend;
        this.proto = proto;
        this.http = new Map();
        this.sockets = new Map();
        this.disposed = false;
    }

    handle(data, isBinary) {
        if (this.disposed) return;
        if (isBinary) {
            if (this.proto < 2) return;
            const frame = decodeBinary(data);
            if (!frame) return;
            if (frame.kind === BIN.HBODY) this.onBody(frame.id, frame.data);
            else if (frame.kind === BIN.WBIN) this.onSocketMessage(frame.id, frame.data, true);
            else if (frame.kind === BIN.WTEXT) this.onSocketMessage(frame.id, frame.data, false);
            return;
        }

        let frame;
        try {
            frame = JSON.parse(data.toString());
        } catch {
            return;
        }
        if (!frame || typeof frame !== 'object') return;

        switch (frame.t) {
            case 'hreq':
                this.onRequest(frame);
                break;
            case 'hreqend':
                this.onBodyEnd(frame.id);
                break;
            case 'hcancel':
                this.cancelRequest(frame.id);
                break;
            case 'wopen':
                this.onOpenSocket(frame);
                break;
            case 'wmsg':
                if (typeof frame.s === 'string') this.onSocketMessage(frame.id, frame.s, false);
                else if (typeof frame.b === 'string') this.onSocketMessage(frame.id, Buffer.from(frame.b, 'base64'), true);
                break;
            case 'wclose':
                this.onCloseSocket(frame.id, frame.code, frame.reason);
                break;
            case 'hchunk':
                // Relays only send response bodies one way. A JSON HCHUNK from
                // a future relay can be ignored safely.
                break;
        }
    }

    send(frame) {
        if (this.ws.readyState !== WebSocket.OPEN) return;
        try {
            this.ws.send(JSON.stringify(frame));
        } catch {
            // The close handler disposes the session.
        }
    }

    sendBinary(kind, id, payload) {
        if (this.ws.readyState !== WebSocket.OPEN) return;
        try {
            this.ws.send(encodeBinary(kind, id, payload));
        } catch {
            // The close handler disposes the session.
        }
    }

    sendBody(id, bytes) {
        if (this.proto >= 2) {
            this.sendBinary(BIN.HCHUNK, id, bytes);
        } else {
            this.send({ t: 'hchunk', id, b: Buffer.from(bytes).toString('base64') });
        }
    }

    onRequest(frame) {
        const id = String(frame.id);
        if (!id || this.http.has(id)) return;

        const method = String(frame.method || 'GET').toUpperCase();
        const stream = frame.stream === true;
        const body = !stream && typeof frame.b === 'string' ? Buffer.from(frame.b, 'base64') : null;
        const record = {
            id,
            method,
            stream,
            req: null,
            res: null,
            done: false,
            canceled: false,
            bodyDone: false,
            headSent: false,
            paused: false,
            timer: null,
        };
        this.http.set(id, record);

        let path;
        try {
            path = normalizePath(frame.path);
        } catch (error) {
            this.http.delete(id);
            this.send({ t: 'herr', id, message: error.message });
            return;
        }
        const request = this.backend.protocol === 'https:' ? httpsRequest : httpRequest;
        let req;
        try {
            req = request({
                protocol: this.backend.protocol,
                hostname: this.backend.hostname,
                port: this.backend.port,
                method,
                path,
                headers: this.requestHeaders(frame.headers, body, stream, method),
            }, res => this.onResponse(record, res));
        } catch (error) {
            this.http.delete(id);
            this.send({ t: 'herr', id, message: error.message });
            return;
        }

        record.req = req;
        req.on('error', error => this.fail(record, error.message));
        if (stream) return;
        req.end(body ?? undefined);
    }

    requestHeaders(input, body, stream, method) {
        const headers = {};
        for (const [name, value] of Object.entries(input || {})) {
            const key = name.toLowerCase();
            if (HOP_BY_HOP.has(key) || key === 'host' || key === 'accept-encoding'
                || key === 'content-length' || key === 'expect') continue;
            if (value !== undefined && value !== null) headers[key] = value;
        }
        headers.host = this.backend.host;
        headers['accept-encoding'] = 'identity';
        if (headers.origin) headers.origin = this.backend.origin;
        if (!stream) {
            if (body) headers['content-length'] = String(body.length);
            else if (BODY_METHODS.has(method)) headers['content-length'] = '0';
        }
        return headers;
    }

    onResponse(record, res) {
        if (record.done || record.canceled) {
            res.destroy();
            return;
        }

        record.res = res;
        record.headSent = true;
        // A backend may answer before reading the whole request body. Stop
        // accepting body bytes; the relay discards them once we answer.
        record.bodyDone = true;
        if (record.req && !record.req.writableEnded) record.req.end();

        const headers = {};
        for (const [name, value] of Object.entries(res.headers)) {
            const key = name.toLowerCase();
            if (HOP_BY_HOP.has(key)) continue;
            headers[key] = value;
        }
        this.send({ t: 'hres', id: record.id, status: res.statusCode || 200, headers });

        res.on('data', chunk => {
            if (record.done || record.canceled) return;
            this.sendBody(record.id, chunk);
            this.applyResponseBackpressure(record);
        });
        res.on('end', () => this.succeed(record));
        res.on('error', error => this.fail(record, error.message));
        res.on('aborted', () => this.fail(record, 'backend response aborted'));
    }

    onBody(id, bytes) {
        const record = this.http.get(String(id));
        if (!record || record.done || record.canceled || record.bodyDone) return;
        const chunk = Buffer.from(bytes);
        try {
            record.req.write(chunk, error => {
                if (error) {
                    this.fail(record, error.message);
                    return;
                }
                // Acknowledge only bytes the backend actually accepted. This is
                // what keeps the relay's 4 MiB upload window honest.
                if (!record.done && !record.canceled) this.send({ t: 'hack', id: record.id, n: chunk.length });
            });
        } catch (error) {
            this.fail(record, error.message);
        }
    }

    onBodyEnd(id) {
        const record = this.http.get(String(id));
        if (!record || record.done || record.canceled || record.bodyDone) return;
        record.bodyDone = true;
        if (!record.req.writableEnded) record.req.end();
    }

    cancelRequest(id) {
        const record = this.http.get(String(id));
        if (!record) return;
        record.canceled = true;
        record.done = true;
        this.http.delete(record.id);
        this.clearPause(record);
        record.res?.destroy();
        record.req?.destroy();
    }

    succeed(record) {
        if (record.done || record.canceled) return;
        record.done = true;
        this.http.delete(record.id);
        this.clearPause(record);
        this.send({ t: 'hend', id: record.id });
    }

    fail(record, message) {
        if (record.done || record.canceled) return;
        record.done = true;
        this.http.delete(record.id);
        this.clearPause(record);
        if (!record.res?.destroyed) record.res?.destroy();
        if (!record.req?.destroyed) record.req?.destroy();
        this.send({ t: 'herr', id: record.id, message });
    }

    applyResponseBackpressure(record) {
        if (record.paused || this.ws.bufferedAmount <= HIGH_WATER) return;
        record.paused = true;
        record.res.pause();
        record.timer = setInterval(() => {
            if (record.done || record.canceled || this.disposed) {
                this.clearPause(record);
                return;
            }
            if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount <= LOW_WATER) {
                this.clearPause(record);
                if (!record.res.destroyed) record.res.resume();
            }
        }, DRAIN_INTERVAL_MS);
        record.timer.unref?.();
    }

    onOpenSocket(frame) {
        const id = String(frame.id);
        if (!id || this.sockets.has(id)) return;

        const record = { id, socket: null, opened: false, paused: false, timer: null };
        let path;
        try {
            path = normalizePath(frame.path);
        } catch (error) {
            this.send({ t: 'werr', id, message: error.message });
            return;
        }
        let socket;
        try {
            socket = new WebSocket(`${this.backend.wsOrigin}${path}`, {
                handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
                maxPayload: MAX_FRAME,
                perMessageDeflate: false,
                origin: this.backend.origin,
            });
        } catch (error) {
            this.send({ t: 'werr', id, message: error.message });
            return;
        }

        record.socket = socket;
        this.sockets.set(id, record);

        socket.on('open', () => {
            record.opened = true;
            this.send({ t: 'wopened', id });
        });
        socket.on('message', (data, isBinary) => {
            if (!record.opened || this.disposed) return;
            this.sendSocketMessage(id, data, isBinary);
            this.applySocketBackpressure(record);
        });
        socket.on('close', (code, reason) => {
            if (!this.sockets.delete(id)) return;
            this.clearPause(record);
            this.send({ t: 'wclose', id, code: sanitizeCloseCode(code), reason: reason.toString().slice(0, 120) });
        });
        socket.on('error', error => {
            if (!this.sockets.delete(id)) return;
            this.clearPause(record);
            this.send({ t: 'werr', id, message: error.message });
        });
    }

    sendSocketMessage(id, data, isBinary) {
        if (this.proto >= 2) {
            this.sendBinary(isBinary ? BIN.WBIN : BIN.WTEXT, id, data);
        } else if (isBinary) {
            this.send({ t: 'wmsg', id, b: Buffer.from(data).toString('base64') });
        } else {
            this.send({ t: 'wmsg', id, s: data.toString() });
        }
    }

    onSocketMessage(id, data, isBinary) {
        const record = this.sockets.get(String(id));
        if (!record || record.socket.readyState !== WebSocket.OPEN) return;
        try {
            if (isBinary) record.socket.send(Buffer.from(data), { binary: true });
            else record.socket.send(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
        } catch (error) {
            this.failSocket(record, error.message);
        }
    }

    onCloseSocket(id, code, reason) {
        const record = this.sockets.get(String(id));
        if (!record) return;
        this.sockets.delete(record.id);
        this.clearPause(record);
        try {
            record.socket.close(sanitizeCloseCode(code), String(reason || '').slice(0, 120));
        } catch {
            record.socket.terminate();
        }
    }

    applySocketBackpressure(record) {
        if (record.paused || this.ws.bufferedAmount <= HIGH_WATER) return;
        record.paused = true;
        record.socket.pause();
        record.timer = setInterval(() => {
            if (this.disposed || record.socket.readyState !== WebSocket.OPEN) {
                this.clearPause(record);
                return;
            }
            if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount <= LOW_WATER) {
                this.clearPause(record);
                record.socket.resume();
            }
        }, DRAIN_INTERVAL_MS);
        record.timer.unref?.();
    }

    failSocket(record, message) {
        if (!this.sockets.delete(record.id)) return;
        this.clearPause(record);
        record.socket.terminate();
        this.send({ t: 'werr', id: record.id, message });
    }

    clearPause(record) {
        if (record.timer) clearInterval(record.timer);
        record.timer = null;
        record.paused = false;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const record of this.http.values()) {
            record.canceled = true;
            record.done = true;
            this.clearPause(record);
            record.res?.destroy();
            record.req?.destroy();
        }
        this.http.clear();
        for (const record of this.sockets.values()) {
            this.clearPause(record);
            record.socket.terminate();
        }
        this.sockets.clear();
    }
}

function normalizePath(value) {
    const path = typeof value === 'string' && value.startsWith('/') ? value : `/${value ?? ''}`;
    if (/[\r\n]/.test(path)) throw new Error('invalid request path');
    return path;
}

function sanitizeCloseCode(code) {
    const value = Number(code);
    return value === 1000 || (value >= 3000 && value <= 4999) ? value : 1000;
}
