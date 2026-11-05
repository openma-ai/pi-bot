import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

/** Minimal in-process relay speaking alma-relay protocol 1 (JSON frames), enough for CI. */
export async function fakeRelay() {
    const server = createServer((req, res) => {
        const m = req.url!.match(/^\/c\/([^/]+)(\/.*)$/);
        const agent = m && agents.get(createHash('sha256').update(m[1]!).digest('hex'));
        if (!agent) { res.writeHead(502); res.end(); return; }
        const id = 'h' + next++;
        httpWaiters.set(id, res);
        agent.send(JSON.stringify({ t: 'hreq', id, method: req.method, path: m![2], headers: {} }));
    });
    const agents = new Map<string, WebSocket>(), sockets = new Map<string, WebSocket>(), httpWaiters = new Map<string, any>();
    const seen: { bytes: number; text: boolean; data: Buffer }[] = [];
    let next = 1;
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
        const url = new URL(req.url!, 'http://x');
        if (url.pathname === '/agent') {
            ws.on('close', () => { for (const [k, v] of agents) if (v === ws) agents.delete(k); });
            ws.on('message', (d: Buffer) => {
                const f = JSON.parse(d.toString());
                if (f.t === 'register') { agents.set(f.tokenHash, ws); ws.send(JSON.stringify({ t: 'registered' })); }
                if (f.t === 'wmsg') { const c = sockets.get(f.id); c?.send(f.b !== undefined ? Buffer.from(f.b, 'base64') : f.s, { binary: f.b !== undefined }); }
                if (f.t === 'werr' || f.t === 'wclose') sockets.get(f.id)?.close();
                if (f.t === 'hres') httpWaiters.get(f.id)?.writeHead(f.status);
                if (f.t === 'hend') httpWaiters.get(f.id)?.end();
            });
            return;
        }
        const m = url.pathname.match(/^\/c\/([^/]+)(\/.*)$/);
        const agent = m && agents.get(createHash('sha256').update(m[1]!).digest('hex'));
        if (!agent) return ws.close();
        const id = 'w' + next++;
        sockets.set(id, ws);
        agent.send(JSON.stringify({ t: 'wopen', id, path: m![2] }));
        ws.on('message', (d: Buffer, binary: boolean) => {
            seen.push({ bytes: d.length, text: !binary, data: Buffer.from(d) });
            agent.send(JSON.stringify(binary ? { t: 'wmsg', id, b: d.toString('base64') } : { t: 'wmsg', id, s: d.toString() }));
        });
        ws.on('close', () => agent.send(JSON.stringify({ t: 'wclose', id })));
    }));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return { url: 'http://127.0.0.1:' + (server.address() as any).port, seen, close: () => { for (const c of wss.clients) c.terminate(); server.close(); } };
}

