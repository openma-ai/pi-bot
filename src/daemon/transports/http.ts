import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { ModelConnectionError } from '../../pi/model-connection-error.ts';
import { PiBotError, classifyError } from '../core/errors.ts';
import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { listenTailnetGateway, type TailnetListener } from './tailnet-gateway.ts';
import { avatarFile } from '../avatar-media.ts';
import { watchDesktopViewer } from './websocket-liveness.ts';
export async function listenHttp(daemon: PiBotDaemon, options: {
    port?: number;
    staticDir?: string;
    tailnet?: TailnetListener & {name?:string};
} = {}) {
    const token = randomBytes(32).toString('hex');
    writeFileSync(join(daemon.dataDir, 'daemon.token'), token, {
        mode: 0o600
    });
    let gateway: Awaited<ReturnType<typeof listenTailnetGateway>> | undefined;
    const sessions = new Map<string, string>();
    const owners = new Map<string, string>();
    const streams = new Set<any>();
    const root = resolve(options.staticDir ?? process.env.PI_BOT_STATIC_DIR ?? 'dist/gui');
    const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    const cookie = (req: IncomingMessage) => req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith('pibot_session='))?.slice(14);
    const authenticate = (req: IncomingMessage, write = false) => {
        const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
        if (bearer && same(bearer, token))
            return 'host';
        const id = cookie(req);
        if (!id || !sessions.has(id))
            return undefined;
        if (write && !same(String(req.headers['x-pibot-csrf'] ?? ''), sessions.get(id)!))
            return 'csrf-invalid';
        return id;
    };
    const server = createServer(async (req, res) => {
        const json = (value: unknown, status = 200) => {
            res.writeHead(status, {
                'content-type': 'application/json', 'cache-control': 'no-store'
            });
            res.end(JSON.stringify(value));
        };
        const url = new URL(req.url ?? '/', 'http://localhost');
        const expected = '127.0.0.1:' + (server.address() as any)?.port;
        if (req.headers.host !== expected)
            return json({
                error: 'Invalid host'
            }, 403);
        if (req.headers.origin && req.headers.origin !== 'http://' + expected)
            return json({
                error: 'Invalid origin'
            }, 403);
        if (url.pathname === '/readyz' || url.pathname === '/healthz') {
            if (req.headers.origin)
                return json({
                    error: 'Origin not permitted'
                }, 403);
            return json({
                status: daemon.status
            }, url.pathname === '/healthz' || daemon.status === 'ready' ? 200 : 503);
        }
        if (url.pathname === '/tailnet/admin' && req.method === 'POST') {
            if (authenticate(req, true) !== 'host' || req.headers.origin) return json({error:'Forbidden'},403);
            if (!gateway) return json({error:'Tailnet listener is disabled'},409);
            let text=''; for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>1024)return json({error:'Too large'},413);}
            try {const input=JSON.parse(text); if(input.action==='password')return json(await gateway.setPassword(input.password)); if(input.action==='pair')return json(gateway.beginPairing());
                if(input.action==='cancel'){gateway.cancelPairing();return json({ok:true});}
                if(input.action==='revoke')return json({revoked:gateway.revoke(String(input.id))});
                if(input.action==='list')return json({devices:gateway.listDevices()});
                return json({error:'Unknown action'},400);
            }catch{return json({error:'Invalid request'},400);}
        }
        // Direct host form channel: auth answers never enter JSON-RPC or durable events.
        if (url.pathname.startsWith('/pi/')) {
            const identity = authenticate(req, req.method !== 'GET');
            if (!identity)
                return json({
                    error: 'Authentication required'
                }, 401);
            if (identity === 'csrf-invalid')
                return json({
                    error: 'CSRF check failed'
                }, 403);
            if (daemon.status !== 'ready')
                return json({
                    error: '服务正在关闭'
                }, 503);
            const settings = daemon.piSettings;
            if (!settings)
                return json({
                    error: 'Pi 配置不可用，请检查本机 Pi 配置文件'
                }, 503);
            try {
                if (req.method === 'GET' && url.pathname === '/pi/config')
                    return json({
                        ...await settings.state(), reloadPending: daemon.piConfigurationPending
                    });
                const match = url.pathname.match(/^\/pi\/login\/([a-zA-Z0-9-]+)(?:\/(input|cancel))?$/);
                if (req.method === 'GET' && match && !match[2]) {
                    const state = settings.loginState(match[1]);
                    return json(state);
                }
                if (req.method !== 'POST')
                    return json({
                        error: 'Not found'
                    }, 404);
                let body = '';
                for await (const chunk of req) {
                    body += chunk;
                    if (Buffer.byteLength(body) > 20000)
                        return json({
                            error: 'Input too large'
                        }, 413);
                }
                const value = JSON.parse(body || '{}');
                if (url.pathname === '/pi/connections/save') { const result=await settings.saveConnection(value); await daemon.requestPiReload(); return json(result); }
                if (url.pathname === '/pi/connections/remove') { const result=settings.removeConnection(value.connectionId,value.expectedRevision); await daemon.requestPiReload(); return json(result); }
                if (url.pathname === '/pi/login')
                    return json(settings.startLogin(value.provider, value.type, value.requestId, value.connectionId));
                if (url.pathname === '/pi/model') {
                    await settings.selectModel(value.provider, value.model, value.thinkingLevel, value.connectionId);
                    return json(await daemon.requestPiReload());
                }
                if (url.pathname === '/pi/logout') {
                    await settings.logout(value.provider, value.connectionId);
                    return json(await daemon.requestPiReload());
                }
                if (match && match[2] === 'input') {
                    settings.answer(match[1], value.promptId, value.value);
                    return json({
                        submitted: true
                    });
                }
                if (match && match[2] === 'cancel') {
                    settings.cancel(match[1]);
                    return json({
                        cancelled: true
                    });
                }
                if (url.pathname === '/pi/reload')
                    return json(await daemon.requestPiReload());
                return json({
                    error: 'Not found'
                }, 404);
            }
            catch (error) {
                // Only explicit public domain errors cross this direct form channel.
                // Do not classify arbitrary SDK exception text or trust a spoofed name.
                const known = error instanceof PiBotError || error instanceof ModelConnectionError ? classifyError(error) : undefined;
                return json({
                    error: known?.message ?? 'Pi 操作失败，请重试'
                }, known?.reason === 'notFound' ? 404 : known?.reason === 'conflict' ? 409 : 400);
            }
        }
        if (url.pathname === '/rpc' && req.method === 'POST') {
            const identity = authenticate(req, true);
            if (!identity)
                return json({
                    error: 'Authentication required'
                }, 401);
            if (identity === 'csrf-invalid')
                return json({
                    error: 'CSRF check failed'
                }, 403);
            let body = '';
            try {
                for await (const chunk of req) {
                    body += chunk;
                    if (Buffer.byteLength(body) > 1024 * 1024)
                        return json({
                            error: 'Message too large'
                        }, 413);
                }
                let frames: any;
                try {
                    frames = JSON.parse(body);
                }
                catch {
                    return json({
                        jsonrpc: '2.0', id: null, error: {
                            code: -32700, message: 'Parse error', data: {
                                reason: 'invalidParams', retryable: false
                            }
                        }
                    });
                }
                const batch = Array.isArray(frames);
                if (batch && (frames.length === 0 || frames.length > 32))
                    return json({
                        error: 'Invalid batch'
                    }, 400);
                let connection = daemon.connections.get(String(req.headers['x-pibot-connection'] ?? ''));
                if (connection && owners.get(connection.id) !== identity)
                    return json({
                        error: 'Connection owner mismatch'
                    }, 403);
                if (!connection) {
                    const first = batch ? frames[0] : frames;
                    if (first?.method !== 'initialize')
                        return json({
                            error: 'Connection not found'
                        }, 404);
                    if (daemon.connections.size >= 256)
                        return json({
                            error: 'Too many connections'
                        }, 503);
                    connection = daemon.connect(identity === 'host' ? 'http' : 'browser');
                    owners.set(connection.id, identity);
                    connection.fileOwner = createHash("sha256").update(identity).digest("hex");
                }
                const results = [];
                for (const frame of batch ? frames : [frames]) {
                    const result = await connection.request(frame);
                    if (result)
                        results.push(result);
                }
                if (!results.length) {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                return json(batch ? results : results[0]);
            }
            catch {
                return json({
                    jsonrpc: '2.0', id: null, error: {
                        code: -32603, message: 'Internal error', data: {
                            reason: 'internal', retryable: false
                        }
                    }
                });
            }
        }
        if (url.pathname.startsWith('/credential/')) {
            const identity = authenticate(req, req.method === 'POST');
            if (!identity)
                return json({
                    error: 'Authentication required'
                }, 401);
            if (identity === 'csrf-invalid')
                return json({
                    error: 'CSRF check failed'
                }, 403);
            const id = url.pathname.slice('/credential/'.length);
            const form = daemon.credentials.readForm(id);
            if (!form)
                return json({
                    error: 'Credential form unavailable'
                }, 404);
            if (req.method === 'GET') {
                const csrf = sessions.get(cookie(req) ?? '') ?? '';
                const label = form.label.replace(/[&<>"']/g, c => ({
                    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
                }[c]!));
                res.writeHead(200, {
                    'content-type': 'text/html', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer'
                });
                res.end(`<!doctype html><html><head><title>Credential input</title></head><body><h1>${label}</h1><p>Value goes directly to the host credential broker.</p><form><input aria-label="Credential" name="secret" type="password" autocomplete="off" required><button>Submit</button></form><p id="status"></p><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const input=document.querySelector('input');const value=input.value;input.value='';const result=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json','X-PiBot-CSRF':${JSON.stringify(csrf)}},body:JSON.stringify({secret:value})});document.querySelector('#status').textContent=result.ok?'Submitted. You can close this page.':'Submission failed.';};</script></body></html>`);
                return;
            }
            if (req.method === 'POST') {
                let body = '';
                try {
                    for await (const chunk of req) {
                        body += chunk;
                        if (body.length > 20000)
                            throw Error();
                    }
                    const value = JSON.parse(body);
                    daemon.credentials.submit(id, form.scope, value.secret);
                    return json({
                        submitted: true
                    });
                }
                catch {
                    return json({
                        error: 'Credential submission failed'
                    }, 400);
                }
            }
            return json({
                error: 'Not found'
            }, 404);
        }
        if (url.pathname === '/events' && req.method === 'GET') {
            const identity = authenticate(req);
            if (!identity)
                return json({
                    error: 'Authentication required'
                }, 401);
            const c = daemon.connections.get(url.searchParams.get('connection') ?? '');
            if (!c)
                return json({
                    error: 'Connection not found'
                }, 404);
            if (owners.get(c.id) !== identity)
                return json({
                    error: 'Connection owner mismatch'
                }, 403);
            let resume: any;
            if (req.headers['last-event-id'] !== undefined) {
                const after = Number(req.headers['last-event-id']);
                try {
                    if (!Number.isSafeInteger(after) || after < 0)
                        throw Error();
                    resume = daemon.log.read(after);
                }
                catch {
                    return json({
                        error: 'cursorExpired'
                    }, 409);
                }
            }
            res.writeHead(200, {
                'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no'
            });
            res.flushHeaders();
            streams.add(res);
            let blocked = false;
            const send = (frame: any) => {
                if (blocked)
                    return false;
                const seq = frame.seq;
                const method = frame.id !== undefined ? 'request' : frame.method;
                blocked = !res.write((seq !== undefined && seq !== null ? 'id: ' + seq + '\n' : '') + 'event: ' + method + '\ndata: ' + JSON.stringify(frame) + '\n\n');
                return true;
            };
            if (resume)
                c.replay(Number(req.headers['last-event-id']));
            const detach = c.attach(send);
            res.on('drain', () => {
                blocked = false;
                c.flush();
            });
            const heartbeat = setInterval(() => {
                if (!blocked)
                    blocked = !res.write(':keepalive\n\n');
            }, 15000);
            heartbeat.unref();
            res.on('close', () => {
                clearInterval(heartbeat);
                detach();
                streams.delete(res);
                c.close('disconnected');
                owners.delete(c.id);
            });
            return;
        }
        const avatar = url.pathname.match(/^\/api\/bot\/([^/]+)\/avatar\/([a-f0-9]{64})$/);
        if (req.method === 'GET' && avatar) {
            if (!authenticate(req))
                return json({
                    error: 'Authentication required'
                }, 401);
            const bot = daemon.runtime.listBots().find(b => b.id === avatar[1]);
            const file = bot?.avatar?.picture === avatar[2] ? avatarFile(daemon.dataDir, avatar[2]) : undefined;
            if (!file)
                return json({
                    error: 'Avatar unavailable'
                }, 404);
            res.writeHead(200, {
                'content-type': file.mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff'
            });
            res.end(readFileSync(file.path));
            return;
        }
        if (req.method === 'GET' && url.pathname.match(/^\/api\/desktop\/[^/]+\/screen$/)) {
            if (!authenticate(req))
                return json({
                    error: 'Authentication required'
                }, 401);
            const id = url.pathname.split('/')[3];
            if (!daemon.desktop || !daemon.runtime.listBots().some(b => b.id === id))
                return json({
                    error: 'Unknown desktop'
                }, 404);
            try {
                const r = await daemon.desktop.request('/screen/' + id);
                res.writeHead(200, {
                    'content-type': 'image/png', 'cache-control': 'no-store'
                });
                res.end(Buffer.from(await r.arrayBuffer()));
            }
            catch {
                daemon.desktop.operationFailed('screenCapture');
                return json({
                    error: 'Desktop unavailable'
                }, 503);
            }
            return;
        }
        if (req.method !== 'GET')
            return json({
                error: 'Not found'
            }, 404);
        const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(root + '/'))
            return json({
                error: 'Not found'
            }, 404);
        let bytes: Buffer | string;
        if (url.pathname === '/') {
            let id = cookie(req);
            if (!id || !sessions.has(id)) {
                id = randomBytes(32).toString('hex');
                if (sessions.size >= 256)
                    sessions.delete(sessions.keys().next().value!);
                sessions.set(id, randomBytes(32).toString('hex'));
            }
            res.setHeader('set-cookie', `pibot_session=${id}; HttpOnly; SameSite=Strict; Path=/`);
            const html = existsSync(file) ? readFileSync(file, 'utf8') : '<!doctype html><html><head></head><body>Build GUI with npm run gui:build</body></html>';
            bytes = html.replace('</head>', `<meta name="pibot-csrf" content="${sessions.get(id)}"></head>`);
        }
        else {
            if (!existsSync(file))
                return json({
                    error: 'Not found'
                }, 404);
            bytes = readFileSync(file);
        }
        const types: Record<string, string> = {
            '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'
        };
        res.writeHead(200, {
            'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': url.pathname === '/' ? 'no-store' : 'no-cache', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff'
        });
        res.end(bytes);
    });
    const ws = new WebSocketServer({
        noServer: true
    });
    server.on('upgrade', (req, socket, head) => {
        const expected = '127.0.0.1:' + (server.address() as any).port;
        const id = new URL(req.url ?? '/', 'http://localhost').pathname.match(/^\/api\/desktop\/([^/]+)\/ws$/)?.[1];
        if (req.headers.host !== expected || req.headers.origin !== 'http://' + expected || !authenticate(req) || !id || !daemon.desktop || !daemon.runtime.listBots().some(b => b.id === id)) {
            socket.destroy();
            return;
        }
        ws.handleUpgrade(req, socket, head, client => {
            watchDesktopViewer(client);
            const remote = new WebSocket(daemon.desktop!.url.replace('http:', 'ws:') + '/ws/' + id, {
                headers: daemon.desktop!.headers()
            });
            remote.on('open', () => client.on('message', d => remote.readyState === 1 && remote.send(d)));
            remote.on('message', d => client.readyState === 1 && client.send(d));
            client.on('close', () => remote.close());
            remote.on('close', () => client.close());
            client.on('error', () => remote.close());
            remote.on('error', () => { daemon.desktop?.operationFailed('vnc'); client.close(); });
        });
    });
    await new Promise<void>(done => server.listen(options.port ?? Number(process.env.PI_BOT_GUI_PORT ?? 4317), '127.0.0.1', done));
    const url = 'http://127.0.0.1:' + (server.address() as any).port;
    if(options.tailnet) { try { gateway=await listenTailnetGateway({...options.tailnet,runtime:{url,token},dataDir:daemon.dataDir}); } catch(error){await new Promise<void>(done=>server.close(()=>done()));throw error;} }
    return {
        server, url, token, async close() {
            await gateway?.close();
            for (const res of streams)
                res.end();
            for (const c of ws.clients)
                c.terminate();
            ws.close();
            server.closeAllConnections();
            await new Promise<void>(done => server.close(() => done()));
        }
    };
}
