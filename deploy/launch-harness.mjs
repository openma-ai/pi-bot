#!/usr/bin/env node
// Shared foreground entry for the user installation and headless container.
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export function readConfig(file) {
  const c = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const allowed = new Set(['port', 'name', 'tailnetAddress', 'serviceOrigin']);
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !allowed.has(k))) throw Error('Unknown harness configuration field');
  c.port ??= 4318;
  c.name ??= 'Pibo workspace';
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw Error('port must be 1–65535');
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 100) throw Error('name must be 1–100 characters');
  if (c.tailnetAddress) {
    const m = /^(100\.(\d+)\.(\d+)\.(\d+)):(\d+)$/.exec(c.tailnetAddress);
    if (!m || +m[2] < 64 || +m[2] > 127 || +m[3] > 255 || +m[4] > 255 || +m[5] < 1 || +m[5] > 65535 || +m[5] === c.port) throw Error('tailnetAddress must be a distinct 100.64.0.0/10 address:port');
  }
  if (c.serviceOrigin) {
    const u = new URL(c.serviceOrigin);
    if (!c.tailnetAddress || u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('serviceOrigin requires an HTTPS origin and tailnetAddress');
  }
  return c;
}

export function privateEnvironment(data) {
  // Deliberately do not inherit provider keys, global Pi config, NODE_OPTIONS or auth.
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, HOME: join(data, 'home'), PI_CODING_AGENT_DIR: join(data, 'pi'), PI_BOT_DIR: join(data, 'runtime') };
}

export function daemonCommand(release, data, config, command = 'daemon') {
  release = realpathSync(release); // macOS /tmp is a symlink; daemon's executable guard uses the canonical module URL.
  return ['--import', pathToFileURL(join(release, 'node_modules/tsx/dist/loader.mjs')).href,
    join(release, 'src/daemon/main.ts'), command, '--data-dir', join(data, 'runtime'),
    ...(command === 'daemon' ? ['--pi-dir', join(data, 'pi'), '--listen', `http://127.0.0.1:${config.port}`,
      '--static', join(release, 'dist/gui'), '--name', config.name,
      ...(config.tailnetAddress ? ['--tailnet-listen', config.tailnetAddress, '--tailnet-serve-loopback'] : []),
      ...(config.serviceOrigin ? ['--service-origin', config.serviceOrigin] : [])] : [])];
}

async function main() {
  if (+process.versions.node.split('.')[0] < 24) throw Error('Node.js 24 or later is required');
  const release = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const data = resolve(process.argv[2] || '/data');
  const config = readConfig(process.argv[3]);
  process.umask(0o077);
  for (const dir of ['runtime', 'pi', 'home', 'workspace']) mkdirSync(join(data, dir), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, daemonCommand(release, data, config), {
    cwd: join(data, 'workspace'), env: privateEnvironment(data), stdio: 'inherit'
  });
  child.on('error', e => { console.error(e.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
