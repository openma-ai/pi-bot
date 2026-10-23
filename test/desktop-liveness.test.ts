import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { watchDesktopViewer } from '../src/daemon/transports/websocket-liveness.ts';
test('dead viewer is terminated while responsive viewer retains desktop', async () => {
    const server = new WebSocketServer({host:'127.0.0.1',port:0});
    await once(server,'listening');
    server.on('connection', s => watchDesktopViewer(s, 20));
    const url=`ws://127.0.0.1:${(server.address() as any).port}`;
    const good=new WebSocket(url), dead=new WebSocket(url,{autoPong:false});
    const closed=once(dead,'close');
    try {
        await Promise.all([once(good,'open'),once(dead,'open')]);
        await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('No heartbeat timeout')),1000).unref())]);
        assert.equal(dead.readyState,WebSocket.CLOSED);
        assert.equal(good.readyState,WebSocket.OPEN);
        good.close();await once(good,'close');
    } finally {good.terminate();dead.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});
