import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonCommand, privateEnvironment, readConfig } from './launch-harness.mjs';

test('gateway configuration fails closed without an explicit Tailnet address and HTTPS origin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pibo-config-test-')), file = join(dir, 'config.json');
  const config = value => { writeFileSync(file, JSON.stringify(value)); return () => readConfig(file); };
  try {
    assert.equal(readConfig().port, 4318);
    for (const bad of [{ bind: '0.0.0.0' }, { port: -1 }, { tailnetAddress: '127.0.0.1:4319' }, { tailnetAddress: '100.128.0.1:4319' }, { tailnetAddress: '100.100.100.100:4318' }, { serviceOrigin: 'https://pibo.example.com' }, { tailnetAddress: '100.100.100.100:4319', serviceOrigin: 'http://pibo.example.com' }]) assert.throws(config(bad));
    assert.equal(config({ tailnetAddress: '100.100.100.100:4319', serviceOrigin: 'https://pibo.example.com' })().serviceOrigin, 'https://pibo.example.com');
  } finally { rmSync(dir, { recursive: true }); }
});

test('launch isolates Pi, HOME, working data and rejects inherited provider credentials', () => {
  process.env.PIBO_TEST_SECRET = 'synthetic-not-a-credential';
  const env = privateEnvironment('/isolated');
  delete process.env.PIBO_TEST_SECRET;
  assert.equal(env.HOME, '/isolated/home');
  assert.equal(env.PI_CODING_AGENT_DIR, '/isolated/pi');
  assert.equal(env.PIBO_TEST_SECRET, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  const command = daemonCommand(process.cwd(), '/isolated', { port: 4321, name: 'Synthetic' });
  assert.equal(command[command.indexOf('--pi-dir') + 1], '/isolated/pi');
  assert.equal(command[command.indexOf('--listen') + 1], 'http://127.0.0.1:4321');
  assert.ok(!command.includes('--tailnet-listen'));
});
