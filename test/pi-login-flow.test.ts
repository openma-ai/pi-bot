import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiLoginFlow, type PiLoginState } from '../src/gui/pi-login-flow.ts';

const deferred = () => {
    let resolve!: (value: any) => void, reject!: (error: unknown) => void;
    const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const fixture = () => {
    const calls: { path: string; body?: any; result: ReturnType<typeof deferred> }[] = [];
    const changes: (PiLoginState | undefined)[] = [];
    const flow = createPiLoginFlow((path, body) => {
        const result = deferred(); calls.push({ path, body, result });
        if (path.endsWith('/cancel')) result.resolve({ cancelled: true });
        return result.promise;
    }, state => changes.push(state));
    const pending = (extra = {}) => ({ id: flow.current!.id, providerId: 'openai-codex', type: 'oauth', status: 'pending', events: [], ...extra });
    const begin = async () => { const operation = flow.begin('openai-codex', 'oauth'); calls.at(-1)!.result.resolve({ id: flow.current!.id }); await operation; };
    const prompt = async () => { const operation = flow.poll(); calls.at(-1)!.result.resolve(pending({ prompt: { id: 'prompt', type: 'select' } })); await operation; };
    return { flow, calls, changes, pending, begin, prompt };
};
const lost = () => Object.assign(new Error('connection interrupted'), { code: 'connectionLost', submitted: true });

test('begin publishes a stable request id and rejects repeated clicks without another POST', async () => {
    const { flow, calls } = fixture();
    const operation = flow.begin('openai-codex', 'oauth');
    assert.equal(flow.current!.starting, true);
    assert.equal(flow.current!.status, 'pending');
    assert.match(flow.current!.id, /^[a-f0-9-]{36}$/);
    assert.equal(calls[0].body.requestId, flow.current!.id);
    await assert.rejects(flow.begin('openai', 'oauth'), /已有登录/);
    await flow.poll(); // No premature GET/404 while start is still in flight.
    assert.equal(calls.length, 1);
    calls[0].result.resolve({ id: flow.current!.id }); await operation;
    assert.equal(flow.current!.starting, false);
    await flow.cancel();
});

test('cancel invalidates a late start and cancels the actual returned id without restoring UI', async () => {
    const { flow, calls, changes } = fixture();
    const operation = flow.begin('openai-codex', 'oauth'), provisional = flow.current!.id;
    await flow.cancel();
    assert.equal(flow.current, undefined);
    assert.equal(calls[1].path, `login/${provisional}/cancel`);
    const count = changes.length;
    calls[0].result.resolve({ id: 'actual-server-id' }); await operation;
    assert.equal(calls[2].path, 'login/actual-server-id/cancel');
    assert.equal(changes.length, count);
});

test('cancel followed by a new flow ignores late reads and input responses from the old flow', async () => {
    for (const action of ['poll', 'answer']) {
        const { flow, calls, changes, begin, prompt, pending } = fixture();
        await begin(); await prompt();
        const oldState = pending({ status: 'complete' });
        const operation = action === 'poll' ? flow.poll() : flow.answer('prompt', 'device_code');
        const request = calls.at(-1)!;
        await flow.cancel(); await begin();
        const fresh = flow.current, count = changes.length;
        request.result.resolve(action === 'poll' ? oldState : { submitted: true }); await operation;
        assert.equal(flow.current, fresh);
        assert.equal(changes.length, count);
        await flow.cancel();
    }
});

test('ambiguous start response is recovered only by GET and terminal states stop polling', async () => {
    const { flow, calls, pending } = fixture();
    const operation = flow.begin('openai-codex', 'oauth'), id = flow.current!.id;
    calls[0].result.reject(lost()); await operation;
    assert.equal(flow.current!.uncertain, true);
    assert.equal(flow.current!.starting, false);
    const read = flow.poll();
    assert.equal(calls[1].path, `login/${id}`);
    assert.equal(calls[1].body, undefined);
    calls[1].result.resolve(pending({ status: 'complete' })); await read;
    assert.equal(flow.current!.status, 'complete');
    assert.equal(flow.current!.uncertain, false);
    await flow.poll();
    assert.equal(calls.length, 2);
    flow.dispose();
    assert.equal(calls.length, 2);
});

test('known pre-dispatch denial is failed rather than an unknown submitted operation', async () => {
    const { flow, calls } = fixture();
    const operation = flow.begin('openai-codex', 'oauth');
    calls[0].result.reject(Object.assign(new Error('policy denied'), { code: 'nativePolicyDenied', submitted: false }));
    await operation;
    assert.equal(flow.current!.status, 'failed');
    assert.equal(flow.current!.uncertain, false);
    assert.equal(flow.current!.errorCode, 'nativePolicyDenied');
    await flow.poll(); flow.dispose();
    assert.equal(calls.length, 1, 'denied start was never dispatched and must not be replayed or cancelled remotely');
});

test('404 after a lost start ends the local flow without restarting OAuth', async () => {
    const { flow, calls } = fixture();
    const operation = flow.begin('openai-codex', 'oauth');
    calls[0].result.reject(lost()); await operation;
    const read = flow.poll();
    calls[1].result.reject(Object.assign(new Error('Login expired'), { code: 'loginExpired', status: 404 })); await read;
    assert.equal(flow.current!.status, 'failed');
    assert.equal(flow.current!.uncertain, false);
    await flow.poll(); assert.equal(calls.length, 2);
});

test('answer invalidates an older read and never stores the entered value in state', async () => {
    const { flow, calls, changes, begin, prompt, pending } = fixture();
    await begin(); await prompt();
    const old = pending({ prompt: { id: 'prompt', type: 'secret' } });
    const read = flow.poll(), oldRead = calls.at(-1)!;
    const input = flow.answer('prompt', 'fixture-private-answer'), sent = calls.at(-1)!;
    await assert.rejects(flow.answer('prompt', 'fixture-private-answer'), /已失效/);
    sent.result.resolve({ submitted: true }); await input;
    const freshRead = flow.poll(), freshRequest = calls.at(-1)!;
    assert.notEqual(freshRequest, sent, 'an older hung read must not block a fresh status request');
    freshRequest.result.resolve(pending({ prompt: { id: 'next-prompt', type: 'select' } })); await freshRead;
    oldRead.result.resolve(old); await read;
    assert.equal(flow.current!.prompt?.id, 'next-prompt');
    assert.ok(!JSON.stringify(changes).includes('fixture-private-answer'));
    await flow.cancel();
});

test('late start connection loss after cancel only sends cleanup, never restores an uncertain flow', async () => {
    const { flow, calls, changes } = fixture();
    const operation = flow.begin('openai-codex', 'oauth'), id = flow.current!.id;
    await flow.cancel();
    const count = changes.length;
    calls[0].result.reject(lost()); await operation;
    assert.equal(flow.current, undefined);
    assert.equal(changes.length, count);
    assert.deepEqual(calls.map(call => call.path), ['login', `login/${id}/cancel`, `login/${id}/cancel`]);
});

test('failed input response is recovered with a read and late input failure cannot overwrite a new flow', async () => {
    const { flow, calls, begin, prompt, pending } = fixture();
    await begin(); await prompt();
    const submitted = flow.answer('prompt', 'device_code');
    calls.at(-1)!.result.reject(lost()); await submitted;
    assert.equal(flow.current!.uncertain, true);
    const read = flow.poll();
    calls.at(-1)!.result.resolve(pending({ status: 'complete' })); await read;
    assert.equal(flow.current!.status, 'complete');
    assert.equal(calls.filter(call => call.path.endsWith('/input')).length, 1);
    await begin(); await prompt();
    const late = flow.answer('prompt', 'device_code'), oldRequest = calls.at(-1)!;
    await flow.cancel(); await begin();
    const fresh = flow.current;
    oldRequest.result.reject(lost()); await late;
    assert.equal(flow.current, fresh);
    await flow.cancel();
});

test('dispose cancels pending work and suppresses every later callback including late start cleanup', async () => {
    for (const action of ['begin', 'poll', 'answer']) {
        const { flow, calls, changes, begin, prompt, pending } = fixture();
        if (action !== 'begin') { await begin(); await prompt(); }
        const operation = action === 'begin' ? flow.begin('openai-codex', 'oauth') : action === 'poll' ? flow.poll() : flow.answer('prompt', 'device_code');
        const late = calls.at(-1)!, response = action === 'begin' ? { id: flow.current!.id } : action === 'poll' ? pending() : { submitted: true };
        flow.dispose();
        const count = changes.length;
        assert.equal(flow.current, undefined);
        late.result.resolve(response); await operation;
        assert.equal(changes.length, count);
        assert.equal(flow.current, undefined);
        assert.equal(calls.filter(c => c.path.endsWith('/cancel')).length, action === 'begin' ? 2 : 1);
        await assert.rejects(flow.begin('openai', 'oauth'), /已关闭/);
        flow.dispose();
    }
});
