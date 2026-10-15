import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import { RuntimeProfileSchema, RuntimeStatusSchema } from '../src/sdk/protocol/client-runtime.ts';
test('new remote-only iOS client can report zero profiles and preserve an approved host pin', () => {
  assert.equal(Value.Check(RuntimeStatusSchema, { profiles: [], active: null, connecting: false, remoteOnly: true }), true);
  const p = { id: 'ios-fixture', name: 'fixture', mode: 'ssh', host: 'fixture@127.0.0.1', projectDir: '/tmp/fixture', dataDir: '/tmp/fixture', serverPort: 0, hostKey: 'ssh-ed25519 public-fixture-key' };
  assert.equal(Value.Check(RuntimeProfileSchema, p), true);
  assert.equal(Value.Check(RuntimeProfileSchema, { ...p, password: 'must-never-be-profile-data' }), false);
  assert.equal(Value.Check(RuntimeProfileSchema, { ...p, hostKey: 'a'.repeat(4097) }), false);
});
