import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { Value } from 'typebox/value';
import { clientRuntimeMethods } from '../../sdk/protocol/client-runtime.ts';
import type { RuntimeManager } from './runtime-manager.ts';
/** GUI shell and SSH transport only: this process never creates a bot runtime/database. */
export async function listenClientHost(manager: RuntimeManager, options: {
    port?: number;
    staticDir?: string;
    bind?: '127.0.0.1' | '0.0.0.0';
} = {}) {
    const token = randomBytes(32).toString('hex'), sessions = new Map<string, string>();
    const root = resolve(options.staticDir ?? 'dist/gui');
    const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    // Cookies are hostname-scoped, not port-scoped. Native and container clients
    // may both be open on 127.0.0.1, so each listener owns a distinct cookie.
    const cookieName = () => 'pibot_client_' + (server.address() as any)?.port;
    const cookie = (req: IncomingMessage) => req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(cookieName() + '='))?.slice(cookieName().length + 1);
    const authenticate = (req: IncomingMessage, write = false) => {
        if (equal(String(req.headers.authorization ?? ''), 'Bearer ' + token))
            return 'host';
        const id = cookie(req), csrf = id ? sessions.get(id) : undefined;
        return csrf && (!write || equal(String(req.headers['x-pibot-csrf'] ?? ''), csrf)) ? id : undefined;
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
        let id = cookie(req);
        if (!id || !sessions.has(id)) {
            id = randomBytes(32).toString('hex');
            if (sessions.size >= 256)
                sessions.delete(sessions.keys().next().value!);
            sessions.set(id, randomBytes(32).toString('hex'));
        }
        res.setHeader('set-cookie', `${cookieName()}=${id}; HttpOnly; SameSite=Strict; Path=/`);
        const file = resolve(root, 'index.html');
        const html = existsSync(file) ? readFileSync(file, 'utf8') : '<!doctype html><html><head></head><body>Build GUI with npm run gui:build</body></html>';
        res.writeHead(200, {
            'content-type': 'text/html', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff'
        });
        res.end(html.replace('</head>', `<meta name="pibot-client" content="true"><meta name="pibot-csrf" content="${sessions.get(id)}"></head>`));
    };
    const allowed = (path: string) => path === '/rpc' || path.startsWith('/events?') || path === '/events' || /^\/pi\/[a-zA-Z0-9/-]+$/.test(path) || /^\/credential\/[a-zA-Z0-9_-]+$/.test(path) || /^\/api\/desktop\/[^/]+\/screen(?:\?.*)?$/.test(path) || /^\/api\/bot\/[^/]+\/avatar\/[a-f0-9]{64}$/.test(path);
    const server = createServer(async (req, res) => {
        const expected = '127.0.0.1:' + (server.address() as any)?.port;
        if (req.headers.host !== expected || (req.headers.origin && req.headers.origin !== 'http://' + expected))
            return json(res, {
                error: 'Invalid origin'
            }, 403);
        const url = new URL(req.url ?? '/', 'http://localhost');
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
                            res.end(html.replace("'X-PiBot-CSRF':\"\"", "'X-PiBot-CSRF':" + JSON.stringify(sessions.get(cookie(req) ?? '') ?? '')));
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
    return {
        server, url: 'http://127.0.0.1:' + (server.address() as any).port, token, async close() {
            detach();
            for (const stop of relays)
                stop();
            ws.close();
            server.closeAllConnections();
            await new Promise<void>(done => server.close(() => done()));
        }
    };
}
