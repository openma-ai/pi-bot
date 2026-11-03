import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceRegistry } from '../remote/devices.ts';
import { WebSocket, WebSocketServer } from 'ws';
import { Value } from 'typebox/value';
import { clientRuntimeMethods } from '../../sdk/protocol/client-runtime.ts';
import type { RuntimeManager } from './runtime-manager.ts';
/** GUI shell and SSH transport only: this process never creates a bot runtime/database. */
export async function listenClientHost(manager: RuntimeManager, options: {
    port?: number;
    staticDir?: string;
    bind?: '127.0.0.1' | '0.0.0.0';
    /** Where paired browser devices persist (`--client-dir`). Defaults to an ephemeral dir. */
    pairingDir?: string;
} = {}) {
    // Browsers are untrusted until paired: only the host bearer (CLI/native shell, never a
    // browser) or a paired-device cookie passes. There are no anonymous sessions.
    const token = randomBytes(32).toString('hex');
    const ephemeral = options.pairingDir ? undefined : mkdtempSync(join(tmpdir(), 'pibot-client-'));
    const pairingDir = options.pairingDir ?? ephemeral!;
    mkdirSync(pairingDir, { recursive: true, mode: 0o700 });
    const registry = new DeviceRegistry(pairingDir);
    const root = resolve(options.staticDir ?? 'dist/gui');
    const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    // Cookies are hostname-scoped, not port-scoped. Native and container clients
    // may both be open on 127.0.0.1, so each listener owns a distinct cookie.
    const cookieName = () => 'pibot_client_' + (server.address() as any)?.port;
    const cookie = (req: IncomingMessage) => req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(cookieName() + '='))?.slice(cookieName().length + 1);
    const authenticate = (req: IncomingMessage, write = false) => {
        if (equal(String(req.headers.authorization ?? ''), 'Bearer ' + token))
            return 'host';
        const id = registry.authenticate(cookie(req));
        return id && (!write || equal(String(req.headers['x-pibot-csrf'] ?? ''), registry.csrf(id))) ? 'device:' + id : undefined;
    };
    const csrfFor = (req: IncomingMessage) => {
        const id = registry.authenticate(cookie(req));
        return id ? registry.csrf(id) : '';
    };
    const json = (res: ServerResponse, value: unknown, status = 200) => {
        res.writeHead(status, {
            'content-type': 'application/json', 'cache-control': 'no-store'
        });
        res.end(JSON.stringify(value));
    };
    const relays = new Set<() => void>();
    const detach = manager.onRetire(() => {
        for (const stop of relays)
            stop();
        relays.clear();
    });
    const bootstrap = (req: IncomingMessage, res: ServerResponse) => {
        const id = registry.authenticate(cookie(req));
        if (!id) {
            res.writeHead(302, { location: '/pair', 'cache-control': 'no-store' });
            return res.end();
        }
        const file = resolve(root, 'index.html');
        const html = existsSync(file) ? readFileSync(file, 'utf8') : '<!doctype html><html><head></head><body>Build GUI with npm run gui:build</body></html>';
        res.writeHead(200, {
            'content-type': 'text/html', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff'
        });
        res.end(html.replace('</head>', `<meta name="pibot-client" content="true"><meta name="pibot-csrf" content="${registry.csrf(id)}"></head>`));
    };
    const allowed = (path: string) => path === '/rpc' || path.startsWith('/events?') || path === '/events' || /^\/pi\/[a-zA-Z0-9/-]+$/.test(path) || /^\/credential\/[a-zA-Z0-9_-]+$/.test(path) || /^\/api\/desktop\/[^/]+\/screen(?:\?.*)?$/.test(path) || /^\/api\/bot\/[^/]+\/avatar\/[a-f0-9]{64}$/.test(path) || /^\/remote\/(admin|invite|devices|devices\/revoke)$/.test(path);
    const server = createServer(async (req, res) => {
        const expected = '127.0.0.1:' + (server.address() as any)?.port;
        if (req.headers.host !== expected || (req.headers.origin && req.headers.origin !== 'http://' + expected))
            return json(res, {
                error: 'Invalid origin'
            }, 403);
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/pair' && req.method === 'GET') {
            if (registry.authenticate(cookie(req))) {
                res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
                return res.end();
            }
            res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
            return res.end(CLIENT_PAIR_PAGE);
        }
        if (url.pathname === '/client/pair' && req.method === 'POST') {
            let body = '';
            for await (const b of req) {
                body += b;
                if (body.length > 1024) return json(res, { error: 'Input too large' }, 413);
            }
            let input: any;
            try { input = JSON.parse(body); } catch { return json(res, { error: 'Invalid request' }, 400); }
            const result = registry.claim(input?.ticket, input?.name);
            if (result === 'closed') return json(res, { error: 'Pairing is closed or expired' }, 403);
            if (result === 'invalid') return json(res, { error: 'Invalid pairing code' }, 403);
            if (result === 'full') return json(res, { error: 'Device limit' }, 409);
            res.setHeader('set-cookie', `${cookieName()}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
            return json(res, { deviceId: result.deviceId });
        }
        if (url.pathname === '/client/pair-code' && req.method === 'POST') {
            // Host bearer only (the `pi-bot pair --client` CLI): a paired browser cannot mint codes either.
            if (authenticate(req) !== 'host') return json(res, { error: 'Authentication required' }, 401);
            const t = registry.issueTicket('host');
            return json(res, { code: t.display, expiresAt: t.expiresAt, url: 'http://' + expected + '/pair' });
        }
        if (url.pathname === '/client/devices' && req.method === 'GET') {
            if (authenticate(req) !== 'host') return json(res, { error: 'Authentication required' }, 401);
            return json(res, { devices: registry.list() });
        }
        if (url.pathname === '/client/devices/revoke' && req.method === 'POST') {
            if (authenticate(req) !== 'host') return json(res, { error: 'Authentication required' }, 401);
            let body = '';
            for await (const b of req) body += b;
            try { return json(res, { revoked: registry.revoke(JSON.parse(body).id) }); } catch { return json(res, { error: 'Invalid request' }, 400); }
        }
        if (url.pathname === '/client/rpc' && req.method === 'POST') {
            if (!authenticate(req, true))
                return json(res, {
                    error: 'Authentication required'
                }, 401);
            let body = '';
            try {
                for await (const b of req) {
                    body += b;
                    if (Buffer.byteLength(body) > 20000)
                        return json(res, {
                            error: 'Input too large'
                        }, 413);
                }
                const frame = JSON.parse(body), method = frame.method as keyof typeof clientRuntimeMethods, schema = clientRuntimeMethods[method];
                if (!schema || !Value.Check(schema.params, frame.params))
                    return json(res, {
                        jsonrpc: '2.0', id: frame.id ?? null, error: {
                            code: -32602, message: '请检查连接配置'
                        }
                    });
                try {
                    const result = method === 'runtime/status' ? manager.status() : method === 'runtime/configure' ? manager.configure(frame.params.profile) : method === 'runtime/disconnect' ? manager.disconnect() : method === 'runtime/remove' ? manager.remove(frame.params.id) : await manager.connect(frame.params.profile);
                    return json(res, {
                        jsonrpc: '2.0', id: frame.id, result
                    });
                }
                catch (e) {
                    return json(res, {
                        jsonrpc: '2.0', id: frame.id, error: {
                            code: -32000, message: (e as Error).message
                        }
                    });
                }
            }
            catch {
                return json(res, {
                    error: 'Invalid request'
                }, 400);
            }
        }
        const match = url.pathname.match(/^\/runtime\/([a-f0-9-]+)(\/.*)?$/);
        if (match) {
            if (req.method === 'GET' && (!match[2] || match[2] === '/') && !url.search)
                return bootstrap(req, res);
            if (!authenticate(req, req.method !== 'GET'))
                return json(res, {
                    error: 'Authentication required'
                }, 401);
            let target;
            try {
                target = manager.route(match[1]);
            }
            catch {
                return json(res, {
                    error: '连接已切换'
                }, 410);
            }
            const path = (match[2] || '/') + url.search;
            if (path === '/')
                return bootstrap(req, res);
            if (!allowed(path))
                return json(res, {
                    error: 'Not found'
                }, 404);
            const upstream = httpRequest(target.url + path, {
                method: req.method, headers: {
                    host: target.host, authorization: 'Bearer ' + target.token, ...(req.headers['content-type'] ? {
                        'content-type': req.headers['content-type']
                    } : {}), ...(req.headers['x-pibot-connection'] ? {
                        'x-pibot-connection': req.headers['x-pibot-connection']
                    } : {}), ...(req.headers['last-event-id'] ? {
                        'last-event-id': req.headers['last-event-id']
                    } : {})
                }
            }, response => {
                const headers = {
                    'content-type': response.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'same-origin'
                };
                if (path.startsWith('/credential/') && req.method === 'GET' && response.statusCode === 200) {
                    // The broker's private form keeps location.pathname, but must use client-host CSRF.
                    let html = '';
                    response.on('data', b => {
                        html += b;
                    });
                    response.on('end', () => {
                        if (!res.destroyed) {
                            res.writeHead(200, headers);
                            res.end(html.replace("'X-PiBot-CSRF':\"\"", "'X-PiBot-CSRF':" + JSON.stringify(csrfFor(req))));
                        }
                    });
                }
                else {
                    res.writeHead(response.statusCode ?? 502, headers);
                    response.pipe(res);
                }
            });
            const stop = () => {
                upstream.destroy();
                res.destroy();
            };
            relays.add(stop);
            res.on('close', () => {
                relays.delete(stop);
                upstream.destroy();
            });
            upstream.on('error', () => {
                if (!res.headersSent)
                    json(res, {
                        error: 'Server 连接中断'
                    }, 502);
                else
                    res.destroy();
            });
            // SSE has no timeout; ordinary requests are bounded.
            if (!path.startsWith('/events'))
                upstream.setTimeout(35000, () => upstream.destroy());
            req.pipe(upstream);
            return;
        }
        if (req.method !== 'GET')
            return json(res, {
                error: 'Not found'
            }, 404);
        if (url.pathname === '/')
            return bootstrap(req, res);
        const file = resolve(root, '.' + url.pathname);
        if (!file.startsWith(root + '/') || !existsSync(file))
            return json(res, {
                error: 'Not found'
            }, 404);
        const types: Record<string, string> = {
            '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html'
        };
        res.writeHead(200, {
            'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff'
        });
        res.end(readFileSync(file));
    });
    const ws = new WebSocketServer({
        noServer: true
    });
    server.on('upgrade', (req, socket, head) => {
        const expected = '127.0.0.1:' + (server.address() as any).port;
        const match = new URL(req.url ?? '/', 'http://localhost').pathname.match(/^\/runtime\/([a-f0-9-]+)(\/api\/desktop\/[^/]+\/ws)$/);
        if (req.headers.host !== expected || req.headers.origin !== 'http://' + expected || !authenticate(req) || !match) {
            socket.destroy();
            return;
        }
        let target;
        try {
            target = manager.route(match[1]);
        }
        catch {
            socket.destroy();
            return;
        }
        ws.handleUpgrade(req, socket, head, client => {
            const upstream = new WebSocket(target.url.replace('http:', 'ws:') + match[2], {
                headers: {
                    host: target.host, origin: 'http://' + target.host, authorization: 'Bearer ' + target.token
                }
            });
            const pending: {
                data: any;
                binary: boolean;
            }[] = [];
            let bytes = 0;
            client.on('message', (data, binary) => {
                if (upstream.readyState === WebSocket.OPEN)
                    upstream.send(data, {
                        binary
                    });
                else if (upstream.readyState === WebSocket.CONNECTING && (bytes += Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data instanceof ArrayBuffer ? data.byteLength : data.length) <= 1048576)
                    pending.push({
                        data, binary
                    });
                else
                    client.close();
            });
            upstream.on('open', () => {
                for (const p of pending)
                    upstream.send(p.data, {
                        binary: p.binary
                    });
                pending.length = 0;
            });
            upstream.on('message', (data, binary) => {
                if (client.readyState === WebSocket.OPEN)
                    client.send(data, {
                        binary
                    });
            });
            const stop = () => {
                client.terminate();
                upstream.terminate();
            };
            relays.add(stop);
            client.on('close', () => {
                relays.delete(stop);
                upstream.close();
            });
            upstream.on('close', () => client.close());
            client.on('error', () => upstream.terminate());
            upstream.on('error', () => client.close());
        });
    });
    await new Promise<void>((done, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 4317, options.bind ?? '127.0.0.1', done);
    });
    const hostUrl = 'http://127.0.0.1:' + (server.address() as any).port;
    if (options.pairingDir) {
        // Lets `pi-bot pair --client` (same user) mint browser pairing codes. Removed on close.
        writeFileSync(join(pairingDir, 'client.token'), token + '\n', { mode: 0o600 });
        writeFileSync(join(pairingDir, 'client-host.json'), JSON.stringify({ url: hostUrl }) + '\n', { mode: 0o600 });
    }
    return {
        server, url: hostUrl, token, registry,
        /** One-time browser pairing code (printed on the host terminal only). */
        issuePairingCode() { return registry.issueTicket('host'); },
        async close() {
            detach();
            for (const stop of relays)
                stop();
            ws.close();
            server.closeAllConnections();
            await new Promise<void>(done => server.close(() => done()));
            if (options.pairingDir) rmSync(join(pairingDir, 'client.token'), { force: true });
            if (ephemeral) rmSync(ephemeral, { recursive: true, force: true });
        }
    };
}

const CLIENT_PAIR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Pair this browser · pi-bot</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
<h1>Pair this browser</h1><p>This browser is not paired with the pi-bot client. Enter the short code printed in the terminal that runs <code>pi-bot client</code>, or run <code>pi-bot pair --client</code> for a new one.</p>
<form><input aria-label="Pairing code" name="code" autocomplete="off" required placeholder="XXXXX-XXXXX"> <button>Pair</button></form><p id="status"></p>
<script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/client/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:document.querySelector('input').value,name:navigator.userAgent.slice(0,64)})});if(r.ok)location.href='/';else document.querySelector('#status').textContent='Pairing failed.';};</script></body></html>`;
