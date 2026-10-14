import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createPiSettingsClient} from '../src/sdk/pi-settings-client.ts';

test('Pi settings marks unreachable reads as recoverable and never replays interrupted writes', async () => {
    let attempts = 0;
    const server = createServer(req => { attempts++; req.socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as {port:number}).port;
    const request = createPiSettingsClient('http://127.0.0.1:' + port);
    try {
        await assert.rejects(request('config'), (e: any) => e.code === 'connectionLost' && e.submitted === false && !/fetch/i.test(e.message));
        attempts = 0;
        await assert.rejects(request('model', {provider:'fixture', model:'fixture'}), (e: any) => e.code === 'connectionLost' && e.submitted === true);
        assert.equal(attempts, 1, 'an interrupted save must not be replayed');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Pi settings reports a retired runtime separately from invalid login input', async () => {
    const server = createServer((req,res) => {res.writeHead(req.url?.includes('offline') ? 502 : req.url?.includes('config') ? 410 : 400, {'content-type':'application/json'});res.end(JSON.stringify({error:'请检查登录输入'}));});
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
    const request = createPiSettingsClient('http://127.0.0.1:' + (server.address() as {port:number}).port);
    try {
        await assert.rejects(request('config'), (e:any) => e.code === 'runtimeChanged');
        await assert.rejects(request('offline'), (e:any) => e.code === 'connectionLost' && e.status === 502);
        await assert.rejects(request('login',{}), (e:any) => e.message === '请检查登录输入' && e.status === 400);
    } finally {await new Promise<void>(resolve => server.close(() => resolve()));}
});
