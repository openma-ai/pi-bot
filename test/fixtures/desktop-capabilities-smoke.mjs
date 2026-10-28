// Run only inside a disposable, network-none desktop QA container with tmpfs /data.
// It intentionally opens and stops that container's own test viewer; never point
// this script at a user's desktop service or mount persistent runtime data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (process.env.PIBO_ISOLATED_DESKTOP_QA !== '1') throw Error('Requires an explicitly isolated disposable desktop QA container');
const { token } = JSON.parse(readFileSync('/data/control.json', 'utf8'));
async function request(path, data) {
    const r = await fetch('http://127.0.0.1:8080' + path, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(15000) });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body)); return body;
}
async function until(check) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 200)); }
    throw Error('Capability transition did not complete within 12 seconds');
}
const report = { assertions: [], states: {} };
const before = await request('/capabilities');
assert.equal(before.browser.state, 'ready');
assert.equal(before.screenCapture.state, 'ready');
assert.equal(before.canOpenView, true);
assert.equal(before.vnc.state, 'unconfigured');
report.states.before = before;
assert.deepEqual((await request('/state')).bindings, []);
report.assertions.push('Detection does not bind a window or start VNC');
await request('/bind', { botId: 'isolated-capability-fixture' });
assert.equal((await request('/capabilities?botId=isolated-capability-fixture')).vnc.state, 'unconfigured');
report.assertions.push('Agent window binding does not start VNC');
const tools = await request('/tools');
assert.deepEqual(tools.computer.map(t => t.name).sort(), before.availableTools.computer.slice().sort());
report.assertions.push('Tool schemas match verified capabilities');
const operation = await request('/call', { botId: 'isolated-capability-fixture', kind: 'browser', args: { action: 'evaluate', expression: '6 * 7' } });
assert.notEqual(operation.isError, true); assert.match(JSON.stringify(operation), /42/);
report.assertions.push('Real Pi browser tool dispatch returned 42 without a model call');
await request('/bind', { botId: 'isolated-capability-fixture', openView: true });
const opened = await request('/capabilities?botId=isolated-capability-fixture');
assert.equal(opened.vnc.state, 'ready', 'The first read after explicit open must already be ready');
report.states.opened = opened;
assert.equal((await request('/state')).control ?? null, null);
report.assertions.push('Explicit open reaches RFB ready without taking control');
execFileSync('pkill', ['-x', 'x11vnc']); // This container's own disposable viewer only.
const failed = await until(async () => { const c = await request('/capabilities?botId=isolated-capability-fixture'); return c.vnc.state === 'unreachable' ? c : undefined; });
report.states.failed = failed;
assert.equal(failed.browser.state, 'ready');
report.assertions.push('Stopped viewer becomes unreachable independently of CDP');
await request('/bind', { botId: 'isolated-capability-fixture', openView: true });
const recovered = await until(async () => { const c = await request('/capabilities?botId=isolated-capability-fixture'); return c.vnc.state === 'ready' ? c : undefined; });
report.states.recovered = recovered;
report.assertions.push('A second explicit open recovers VNC; probes did not restart it');
console.log(JSON.stringify(report, null, 2));
