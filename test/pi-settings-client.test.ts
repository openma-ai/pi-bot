import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createPiSettingsClient} from '../src/sdk/pi-settings-client.ts';

test('native auth policy rejection is precise and cannot start CSRF recovery or replay', async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = (globalThis as any).window;
    let attempts = 0;
    (globalThis as any).window = {__PIBOT_NATIVE__: {}};
    globalThis.fetch = async () => {
        attempts++;
        throw {code:'secureInputRequired',message:'请在安全输入窗口提交',submitted:false};
    };
    try {
        await assert.rejects(createPiSettingsClient('/runtime/qa')('login/id/input', {value:'synthetic'}),
            (e:any) => e.code === 'secureInputRequired' && e.submitted === false && !e.message.includes('连接中断'));
        assert.equal(attempts, 1);
        globalThis.fetch = async () => { attempts++; return Response.json({error:'Authentication required'}, {status:401}); };
        await assert.rejects(createPiSettingsClient('/runtime/qa')('config'), (e:any) => e.status === 401);
        assert.equal(attempts, 2, 'native 401 must not bootstrap or replay a browser session');
    } finally {
        globalThis.fetch = originalFetch;
        if (originalWindow === undefined) delete (globalThis as any).window; else (globalThis as any).window = originalWindow;
    }
});

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
