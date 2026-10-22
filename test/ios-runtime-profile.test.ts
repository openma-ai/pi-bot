import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import { RuntimeProfileSchema, RuntimeStatusSchema } from '../src/sdk/protocol/client-runtime.ts';
test('new remote-only iOS client can report zero profiles and preserve an approved host pin', () => {
  assert.equal(Value.Check(RuntimeStatusSchema, { profiles: [], active: null, connecting: false, remoteOnly: true }), true);
  const p = { id: 'ios-fixture', name: 'fixture', mode: 'ssh', host: 'fixture@127.0.0.1', projectDir: '/tmp/fixture', dataDir: '/tmp/fixture', serverPort: 0, hostKey: 'ssh-ed25519 public-fixture-key' };
  assert.equal(Value.Check(RuntimeProfileSchema, p), true);
  for(const field of ['password','privateKey','passphrase','answers']) assert.equal(Value.Check(RuntimeProfileSchema, { ...p, [field]: 'must-never-be-profile-data' }), false);
  assert.equal(Value.Check(RuntimeProfileSchema, { ...p, hostKey: 'a'.repeat(4097) }), false);
});
test('embedded transport metadata is optional and never contains Tailnet credentials', () => {
  const p = {mode:'ssh', host:'user@server.tail.ts.net', projectDir:'~/pi-bot', dataDir:'/runtime', serverPort:0, embeddedTailscale:true};
  assert.equal(Value.Check(RuntimeProfileSchema,p),true);
  for(const field of ['authKey','tailscaleAuthKey','stateDir']) assert.equal(Value.Check(RuntimeProfileSchema,{...p,[field]:'secret'}),false);
  assert.equal(Value.Check(RuntimeProfileSchema,{...p,embeddedTailscale:'true'}),false);
});
test('native direct Tailnet profile needs only device address and service port, never SSH or secrets',()=>{
 const p={mode:'tailnet',host:'100.100.1.2',serverPort:4319,embeddedTailscale:true,dataDir:''};assert.equal(Value.Check(RuntimeProfileSchema,p),true);
 for(const field of ['token','authKey','privateKey','password','projectDir','hostKey'])assert.equal(Value.Check(RuntimeProfileSchema,{...p,[field]:'secret'}),false);
 for(const host of ['127.0.0.1','example.com','user@100.100.1.2','100.63.1.2'])assert.equal(Value.Check(RuntimeProfileSchema,{...p,host}),false);
});
