import { ServicePassword } from './service-password.ts';
/** Explicit private-network ingress. The ordinary runtime remains loopback-only. */
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function tailnetAddress(host: string) {
    const parts = host.split('.').map(Number);
    return parts.length === 4 && parts.every((n, i) => Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === host.split('.')[i]) && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}
export interface TailnetListener {
    host: string;
    port: number;
    listenMode?: 'interface' | 'serve-loopback';
    serviceOrigin?: string;
}
/** No automatic bind fallback: a missing Tailnet interface must fail closed. */
export function tailnetBindAddress(options: TailnetListener) {
    if (!tailnetAddress(options.host) || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
        throw Error('Tailnet ingress requires an explicit 100.64.0.0/10 address and port');
    if (options.listenMode !== undefined && !['interface', 'serve-loopback'].includes(options.listenMode))
        throw Error('Unknown Tailnet listener mode');
    if(options.serviceOrigin){
        const u=new URL(options.serviceOrigin);
        if(options.listenMode!=='serve-loopback'||u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('HTTPS service origin requires explicit loopback proxy mode');
    }
    return options.listenMode === 'serve-loopback' ? '127.0.0.1' : options.host;
}
export function createTailnetGateway(options: TailnetListener & {
    runtime: {
        url: string;
        token: string;
    };
    dataDir: string;
    name?: string;
}) {
    tailnetBindAddress(options);
    const target = new URL(options.runtime.url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash)
        throw Error('Gateway target must be loopback');
    const password = new ServicePassword(options.dataDir);
    const sessionMs = 30 * 24 * 60 * 60 * 1000;
    const store = join(options.dataDir, 'tailnet-devices.json');
    let devices: Record<string, {
        hash: string;
        createdAt: string;
        expiresAt?: number;
        passwordGeneration?:string;
    }> = {};
    try {
        devices = JSON.parse(readFileSync(store, 'utf8'));
    }
    catch (e: any) {
        if (e.code !== 'ENOENT')
            throw Error('Invalid paired-device store');
    }
    if (!devices || typeof devices !== 'object' || Array.isArray(devices) || Object.keys(devices).length > 32 || Object.entries(devices).some(([id, d]) => !/^[a-f0-9]{32}$/.test(id) || !d || !/^[a-f0-9]{64}$/.test(d.hash) || typeof d.createdAt !== 'string'))
        throw Error('Invalid paired-device store');
    const persist = () => {
        const tmp = store + '.' + randomBytes(8).toString('hex');
        writeFileSync(tmp, JSON.stringify(devices), {
            mode: 0o600, flag: 'wx'
        });
        renameSync(tmp, store);
    };
    let pairing: {
        hash: string;
        expires: number;
        attempts: number;
    } | undefined;
    const connections = new Map<string, Set<{
        destroy(): void;
    }>>();
    const identity = (req: IncomingMessage) => {
        const auth = String(req.headers.authorization || '');
        if (!/^Bearer [a-f0-9]{64}$/.test(auth))
            return undefined;
        const hash = digest(auth.slice(7));
        return Object.entries(devices).find(([, d]) => same(d.hash, hash) && (d.expiresAt ? d.expiresAt > Date.now() && d.passwordGeneration === password.generation : !password.configured))?.[0];
    };
    const allowed = (path: string) => path === '/rpc' || path === '/events' || path.startsWith('/api/') || path.startsWith('/pi/') || path.startsWith('/credential/');
    const valid = (req: IncomingMessage) => !!req.url && req.url.startsWith('/') && !req.url.startsWith('//') && !req.url.includes('\\') && [`${options.host}:${options.port}`, ...(options.serviceOrigin?[new URL(options.serviceOrigin).host]:[])].includes(req.headers.host || '') && !req.headers.origin;
    const headers = (req: IncomingMessage) => {
        const h: IncomingMessage["headers"] = {
            ...req.headers, host: target.host, authorization: 'Bearer ' + options.runtime.token, origin: 'http://' + target.host
        };
        delete h.cookie;
        delete h['x-pibot-csrf'];
        delete h['proxy-authorization'];
        delete h['proxy-connection'];
        delete h['forwarded'];
        delete h['x-forwarded-for'];
        delete h['x-forwarded-host'];
        delete h['x-forwarded-proto'];
        return h;
    };
    const track = (id: string, socket: any) => {
        let set = connections.get(id);
        if (!set)
            connections.set(id, set = new Set());
        if (set.has(socket)) return;
        set.add(socket);
        socket.once('close', () => set!.delete(socket));
    };
    const server = createServer(async (req, res) => {
        const json = (value: unknown, status = 200) => {
            res.writeHead(status, {
                'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
            });
            res.end(JSON.stringify(value));
        };
        if (!valid(req))
            return json({
                error: 'Invalid host/origin'
            }, 403);
        const path = new URL(req.url || '/', 'http://gateway').pathname;
        if (path === '/pibo/service' && req.method === 'GET')
            return json({
                service: 'pibo', protocolVersion: '2026-10-13', name: options.name || 'Pibo workspace', auth: 'password', passwordConfigured: password.configured, pairing: !password.configured && !!pairing && pairing.expires > Date.now()
            });
        if (path === '/pibo/login' && req.method === 'POST') {
            let body='';
            try {for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048){json({error:'Too large'},413);req.destroy();return;}}}catch{return;}
            let value;try{value=JSON.parse(body);}catch{return json({error:'Invalid request'},400);}
            const result=await password.verify(value?.password);
            if(result!=='ok')return json({error:result==='limited'?'Try later':'Service login failed'},result==='limited'?429:401);
            // Expired and legacy pairing records never regain authority after password setup.
            for(const [id,d] of Object.entries(devices))if(!d.expiresAt||d.expiresAt<=Date.now()){for(const c of connections.get(id)||[])c.destroy();connections.delete(id);delete devices[id];}
            if(Object.keys(devices).length>=32)return json({error:'Session limit; revoke an old session locally'},409);
            const token=randomBytes(32).toString('hex'),id=randomBytes(16).toString('hex');
            devices[id]={hash:digest(token),createdAt:new Date().toISOString(),expiresAt:Date.now()+sessionMs,passwordGeneration:password.generation};
            try{persist();}catch{delete devices[id];return json({error:'Cannot save session'},500);}
            return json({token,deviceId:id,expiresAt:devices[id]!.expiresAt});
        }
        if (path === '/pibo/pair' && req.method === 'POST') {
            if (password.configured || !pairing || pairing.expires <= Date.now() || pairing.attempts >= 5)
                return json({
                    error: 'Pairing is closed or expired'
                }, 403);
            const attempt = pairing;
            let body = '';
            try {
                for await (const chunk of req) {
                    body += chunk;
                    if (Buffer.byteLength(body) > 1024) {
                        json({
                            error: 'Too large'
                        }, 413);
                        req.destroy();
                        return;
                    }
                }
            }
            catch {
                return;
            }
            let code: string;
            try {
                code = JSON.parse(body).code;
            }
            catch {
                return json({
                    error: 'Invalid request'
                }, 400);
            }
            if (pairing !== attempt || attempt.expires <= Date.now() || attempt.attempts >= 5)
                return json({
                    error: 'Pairing is closed or expired'
                }, 403);
            pairing.attempts++;
            if (typeof code !== 'string' || !same(pairing.hash, digest(code)))
                return json({
                    error: 'Invalid pairing code'
                }, 403);
            if (Object.keys(devices).length >= 32)
                return json({
                    error: 'Device limit'
                }, 409);
            const token = randomBytes(32).toString('hex'), id = randomBytes(16).toString('hex');
            devices[id] = {
                hash: digest(token), createdAt: new Date().toISOString()
            };
            try {
                persist();
            }
            catch {
                delete devices[id];
                return json({
                    error: 'Cannot save pairing'
                }, 500);
            }
            pairing = undefined;
            return json({
                deviceId: id, token
            });
        }
        const id = identity(req);
        if (!id)
            return json({
                error: 'Service login required'
            }, 401);
        if(path==='/pibo/logout'&&req.method==='POST'){
            res.setHeader('connection','close');connections.get(id)?.delete(req.socket);
            try{revoke(id);return json({ok:true});}catch{return json({error:'Cannot revoke session'},500);}
        }
        if (path === '/pibo/ready' && req.method === 'GET') {
            const probe = httpRequest(new URL('/readyz', target), {
                headers: {
                    host: target.host
                }
            }, up => {
                json({
                    service: 'pibo', ready: up.statusCode === 200
                }, up.statusCode === 200 ? 200 : 503);
                up.resume();
            });
            probe.setTimeout(5000, () => probe.destroy());
            probe.on('error', () => json({
                error: 'Runtime unavailable'
            }, 503));
            probe.end();
            return;
        }
        if (!allowed(path))
            return json({
                error: 'Not found'
            }, 404);
        track(id, req.socket);
        const up = httpRequest(new URL(req.url!, target), {
            method: req.method, headers: headers(req)
        }, reply => {
            const h = {
                ...reply.headers
            };
            delete h['set-cookie'];
            res.writeHead(reply.statusCode || 502, h);
            reply.pipe(res);
        });
        req.on('aborted', () => up.destroy());
        res.on('close', () => up.destroy());
        up.on('error', () => {
            if (!res.headersSent)
                json({
                    error: 'Runtime unavailable'
                }, 502);
            else
                res.destroy();
        });
        req.pipe(up);
    });
    server.on('upgrade', (req, socket, head) => {
        const id = identity(req);
        const path = new URL(req.url || '/', 'http://gateway').pathname;
        if (!valid(req) || !id || !/^\/api\/desktop\/[^/]+\/ws$/.test(path)) {
            socket.destroy();
            return;
        }
        track(id, socket);
        const remote = connect(Number(target.port), '127.0.0.1', () => {
            const h = headers(req);
            const text = Object.entries(h).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\r\n');
            remote.write(`${req.method} ${req.url} HTTP/1.1\r\n${text}\r\n\r\n`);
            if (head.length)
                remote.write(head);
            socket.pipe(remote).pipe(socket);
        });
        remote.on('error', () => socket.destroy());
        socket.on('error', () => remote.destroy());
        socket.on('close', () => remote.destroy());
    });
    const revoke = (id: string) => {
            if (!devices[id])
                return false;
            const old = devices[id];
            delete devices[id];
            try {
                persist();
            }
            catch (e) {
                devices[id] = old;
                throw e;
            }
            for (const c of connections.get(id) || [])
                c.destroy();
            connections.delete(id);
            return true;
    };
    const expiry = setInterval(()=>{for(const [id,d] of Object.entries(devices))if(d.expiresAt && d.expiresAt<=Date.now()){for(const c of connections.get(id)||[])c.destroy();try{revoke(id);}catch{/* Expired records stay denied even if disk is full. */}}},1000);
    expiry.unref();server.once('close',()=>clearInterval(expiry));
    server.maxConnections = 128;
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    return {
        server, beginPairing() {
            if(password.configured)throw Error('Password authentication enabled; use service login');
            const code = randomBytes(12).toString('hex');
            pairing = {
                hash: digest(code), expires: Date.now() + 120000, attempts: 0
            };
            return {
                code, expiresAt: new Date(pairing.expires).toISOString()
            };
        }, cancelPairing() {
            pairing = undefined;
        }, listDevices() {
            return Object.entries(devices).map(([id, d]) => ({
                id, createdAt: d.createdAt, expiresAt:d.expiresAt
            }));
        }, revoke,
        async setPassword(value: unknown) {
            await password.set(value);
            pairing=undefined;
            for(const set of connections.values())for(const socket of set)socket.destroy();
            connections.clear();devices={};persist();
            return {configured:true};
        }, async close() {
            pairing = undefined;
            for (const set of connections.values())
                for (const c of set)
                    c.destroy();
            await new Promise<void>(yes => server.close(() => yes()));
        }
    };
}
export async function listenTailnetGateway(options: Parameters<typeof createTailnetGateway>[0]) {
    const gateway = createTailnetGateway(options);
    await new Promise<void>((yes, no) => {
        gateway.server.once('error', no);
        gateway.server.listen(options.port, tailnetBindAddress(options), () => {
            gateway.server.off('error', no);
            yes();
        });
    });
    return gateway;
}
