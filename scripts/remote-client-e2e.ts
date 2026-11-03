/**
 * Real-client end-to-end check through a deployed relay.
 * Usage: node --import tsx scripts/remote-client-e2e.ts <file containing `pi-bot pair` output>
 * Prints results only; never prints the link, code, or tokens.
 */
import { readFileSync } from 'node:fs';
import { RemoteConnection, pairFromLink, decodePairingLink } from '../src/sdk/remote/client.ts';

const out = readFileSync(process.argv[2]!, 'utf8');
const link = out.match(/pibot:\/\/pair#[A-Za-z0-9_-]+/)?.[0];
if (!link) throw Error('No pairing link in pair output');
const { relay } = decodePairingLink(link);
const step = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) process.exitCode = 1; };

const dev = await pairFromLink(link, 'e2e-client');
step('pair via relay (E2E)', !!dev.token, 'device ' + dev.deviceId);
const conn = await RemoteConnection.connect({ relay: relay!, code: dev.code });
const auth = { authorization: 'Bearer ' + dev.token };

const unpaired = await conn.fetch('/remote/devices');
step('unpaired request inside E2E rejected', unpaired.status === 401, String(unpaired.status)); await unpaired.text();

const init = await conn.fetch('/rpc', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'e2e', version: '1' }, protocolVersion: '2026-10-13' } }) });
const initBody = await init.json();
step('POST /rpc initialize through relay', init.status === 200 && !!initBody.result?.connectionId, 'status ' + init.status);
const ack = await conn.fetch('/rpc', { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-pibot-connection': initBody.result.connectionId }, body: JSON.stringify({ method: 'initialized' }) });
await ack.text();
const status = await conn.fetch('/rpc', { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-pibot-connection': initBody.result.connectionId }, body: JSON.stringify({ id: 2, method: 'daemon/status', params: {} }) });
const statusBody = await status.json();
step('POST /rpc daemon/status through relay', status.status === 200 && !statusBody.error, JSON.stringify(statusBody.result ?? statusBody.error).slice(0, 120));

const events = await conn.fetch('/events?connection=' + encodeURIComponent(initBody.result.connectionId), { headers: auth });
step('GET /events SSE head through relay', events.status === 200 && String(events.headers['content-type']).includes('text/event-stream'));

const invite = await (await conn.fetch('/remote/invite', { method: 'POST', headers: auth, body: '{}' })).json();
const second = await pairFromLink(invite.link, 'e2e-invited');
step('invite from paired device', !!second.token);
const list = await (await conn.fetch('/remote/devices', { headers: auth })).json();
step('device list', list.devices.some((d: any) => d.id === second.deviceId && d.invitedBy === dev.deviceId), list.devices.length + ' devices');
const rev = await (await conn.fetch('/remote/devices/revoke', { method: 'POST', headers: auth, body: JSON.stringify({ id: second.deviceId }) })).json();
const after = await conn.fetch('/remote/devices', { headers: { authorization: 'Bearer ' + second.token } });
step('revoked device rejected', rev.revoked && after.status === 401, String(after.status)); await after.text();

const plain = await fetch(relay + '/c/' + (await import('../src/sdk/protocol/remote-e2e.ts').then(m => m.routeToken(dev.code))) + '/remote/devices', { headers: auth });
step('plaintext request via relay refused by daemon', plain.status === 403, String(plain.status));

const rotated = await (await conn.fetch('/remote/token/rotate', { method: 'POST', headers: auth, body: '{}' })).json();
const old = await conn.fetch('/remote/devices', { headers: auth }); await old.text();
const fresh = await conn.fetch('/remote/devices', { headers: { authorization: 'Bearer ' + rotated.token } }); await fresh.text();
step('token rotation', old.status === 401 && fresh.status === 200);
conn.close();
process.exit();
