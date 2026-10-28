#!/usr/bin/env node
/** User-owned installation only. No system services, downloads of executables or OS changes. */
import { cpSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { daemonCommand, privateEnvironment, readConfig } from './launch-harness.mjs';

const args = process.argv.slice(2), command = args.shift() || 'help';
const option = name => { const i = args.indexOf(name); if (i < 0) return; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${name} needs a value`); return args[i + 1]; };
const root = resolve(option('--root') || join(homedir(), '.local/share/pibo-harness'));
const stateFile = join(root, 'install.json'), configFile = join(root, 'config.json'), data = join(root, 'var');
const id = () => new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + randomBytes(4).toString('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => { const tmp = file + '.tmp-' + randomBytes(4).toString('hex'); writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(tmp, file); };
const copy = (from, to) => cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,80}$/.test(value);
const childPath = (kind, name) => { if (!validId(name)) throw Error('Invalid managed directory ID'); return join(root, kind, name); };
const delay = ms => new Promise(r => setTimeout(r, ms));
const existsProcess = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
function checkDir(path) { if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw Error(`Managed path must be a real directory: ${path}`); }
function state() {
  const s = json(stateFile);
  if (s.version !== 1 || s.root !== root || !validId(s.current)) throw Error('Not a recognized Pibo harness installation');
  for (const p of [root, join(root, 'releases'), data, join(data, 'runtime'), join(data, 'pi')]) checkDir(p);
  return s;
}
function discovery() {
  const file = join(data, 'runtime/daemon.json');
  if (!existsSync(file)) return;
  const d = json(file), u = new URL(d.http);
  if (!Number.isSafeInteger(d.pid) || d.pid < 1 || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || d.agentDir !== join(data, 'pi') || d.tokenFile !== join(data, 'runtime/daemon.token')) throw Error('Unexpected runtime discovery; refusing to control it');
  return existsProcess(d.pid) ? d : undefined;
}
function requireStopped() { if (discovery()) throw Error('Harness is running. Run stop first; no running data is copied or replaced.'); }
function run(exe, argv, options = {}) {
  const r = spawnSync(exe, argv, { stdio: 'inherit', ...options });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error(`Command failed (${r.status ?? r.signal}): ${exe}`);
}
function localCommand(s, action, capture = false) {
  const release = childPath('releases', s.current);
  const result = spawnSync(process.execPath, daemonCommand(release, data, readConfig(configFile), action), {
    cwd: join(data, 'workspace'), env: privateEnvironment(data), stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', timeout: 45000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Harness ${action} failed; inspect ${join(root, 'logs/server.log')}`);
  return capture ? JSON.parse(result.stdout.trim()) : undefined;
}
async function health(s) {
  const d = discovery();
  if (!d) throw Error('Harness is stopped');
  const response = await fetch(new URL('/readyz', d.http), { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw Error(`Harness not ready: HTTP ${response.status}`);
  const status = localCommand(s, 'status', true);
  console.log(JSON.stringify({ ...status, url: d.http, dataDir: data, release: s.current }, null, 2));
  if (status.model?.setupRequired) console.log('Model setup required: open the local URL → Settings → Pi login and model. No model request was made.');
  return status;
}
function snapshot(s) {
  requireStopped();
  const key = id(), dir = childPath('backups', key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(data)) copy(data, join(dir, 'var'));
  copy(configFile, join(dir, 'config.json'));
  save(join(dir, 'backup.json'), { version: 1, root, release: s.current, createdAt: new Date().toISOString() });
  return key;
}
async function install(upgrade) {
  const source = resolve(option('--source') || process.cwd());
  const nested = (parent, child) => { const p = relative(parent, child); return p === '' || (!p.startsWith('..') && !isAbsolute(p)); };
  if (nested(source, root) || nested(root, source)) throw Error('Keep the source checkout and installation in separate, non-nested directories');
  if (!existsSync(join(source, 'src/daemon/main.ts')) || json(join(source, 'package.json')).name !== 'pi-bot') throw Error('--source must be the trusted Pibo source checkout');
  const s = upgrade ? state() : undefined;
  if (!upgrade && readdirSync(root).some(n => n !== '.operation.lock')) throw Error('Choose an empty installation directory; existing files are never adopted');
  if (s) requireStopped();
  const releaseId = id(), release = childPath('releases', releaseId);
  mkdirSync(release, { recursive: true, mode: 0o700 });
  for (const name of ['package.json', 'package-lock.json', 'src', 'vendor', 'deploy']) copy(join(source, name), join(release, name));
  mkdirSync(join(release, 'scripts'));
  copy(join(source, 'scripts/apply-pi-background-bridge.mjs'), join(release, 'scripts/apply-pi-background-bridge.mjs'));
  for (const name of ['README.md', 'LICENSE']) if (existsSync(join(source, name))) copy(join(source, name), join(release, name));
  // Installation is explicit; lifecycle hooks remain disabled. Only this project's reviewed bridge/build execute.
  if (args.includes('--prepared')) {
    if (!existsSync(join(source, 'node_modules/tsx/dist/loader.mjs')) || !existsSync(join(source, 'dist/gui/index.html'))) throw Error('--prepared requires dependencies and gui:build in the trusted checkout');
    copy(join(source, 'node_modules'), join(release, 'node_modules'));
    copy(join(source, 'dist/gui'), join(release, 'dist/gui'));
    // A prepared checkout may contain local package links; reject those so this release stays self-contained.
    const { realpathSync } = await import('node:fs');
    const verify = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() && !nested(realpathSync(release), realpathSync(path))) throw Error('Prepared dependencies contain an external symlink; use a normal lockfile installation');
      if (entry.isDirectory()) verify(path);
    } };
    verify(join(release, 'node_modules'));
  } else {
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...(args.includes('--offline') ? ['--offline'] : [])], { cwd: release });
    run(process.execPath, ['scripts/apply-pi-background-bridge.mjs'], { cwd: release });
    run('npm', ['run', 'gui:build'], { cwd: release });
  }
  const lockSha256 = createHash('sha256').update(readFileSync(join(release, 'package-lock.json'))).digest('hex');
  save(join(release, 'release.json'), { id: releaseId, node: process.version, lockSha256, prepared: args.includes('--prepared'), createdAt: new Date().toISOString() });
  let backup;
  if (s) backup = snapshot(s);
  else save(configFile, { port: 4318, name: 'Pibo workspace' });
  mkdirSync(data, { recursive: true, mode: 0o700 });
  save(stateFile, { version: 1, root, current: releaseId, previous: s?.current, backup });
  console.log(JSON.stringify({ installed: releaseId, root, backup, started: false }, null, 2));
}
async function start(s) {
  if (discovery()) return health(s);
  readConfig(configFile);
  const release = childPath('releases', s.current);
  mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
  const fd = openSync(join(root, 'logs/server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [join(release, 'deploy/launch-harness.mjs'), data, configFile], { detached: true, stdio: ['ignore', fd, fd], env: privateEnvironment(data) });
  closeSync(fd);
  let error;
  child.on('error', e => { error = e; });
  child.unref();
  for (let i = 0; i < 150 && !error && child.exitCode === null; i++) {
    await delay(100);
    if (discovery()) { try { return await health(s); } catch { /* Wait for this startup only. */ } }
  }
  if (!error && child.exitCode === null) child.kill('SIGTERM');
  throw Error(`Harness startup failed${error ? ': ' + error.message : ''}; see ${join(root, 'logs/server.log')}`);
}
async function stop(s) {
  if (!discovery()) return console.log('Harness already stopped');
  localCommand(s, 'stop');
  for (let i = 0; i < 450; i++) { if (!discovery()) return console.log('Harness stopped'); await delay(100); }
  throw Error('Graceful shutdown timed out; no process was force-killed. Inspect server.log.');
}
async function main() {
  if (command === 'help') return console.log('node deploy/harness.mjs <install|upgrade|start|stop|status|health|password|backup|rollback|uninstall> [--root DIR]\ninstall/upgrade: --source CHECKOUT [--offline | --prepared]\nrollback: --backup ID (restores that release AND data; current data is archived)\nNo command installs an OS service or logs in. uninstall preserves var/, config, logs and backups.');
  if (!['install', 'upgrade', 'start', 'stop', 'status', 'health', 'password', 'backup', 'rollback', 'uninstall'].includes(command)) throw Error('Unknown command; use help');
  const flags = new Set(['--root', ...(['install', 'upgrade'].includes(command) ? ['--source', '--offline', '--prepared'] : []), ...(command === 'rollback' ? ['--backup'] : [])]);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flags.has(flag) || seen.has(flag)) throw Error(`Unknown or repeated option: ${flag}`);
    seen.add(flag);
    if (!['--offline', '--prepared'].includes(flag)) { option(flag); i++; }
  }
  if (seen.has('--offline') && seen.has('--prepared')) throw Error('Choose --offline or --prepared, not both');
  if (!['darwin', 'linux'].includes(process.platform)) throw Error('This user-process installer currently supports macOS and Linux; Windows native installation is not validated');
  if (+process.versions.node.split('.')[0] < 24) throw Error('Node.js 24 or later is required');
  process.umask(0o077);
  checkDir(root); mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, '.operation.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw Error('Another lifecycle operation owns .operation.lock; verify no installer is running before manually removing a stale lock'); }
  try {
    if (command === 'install' || command === 'upgrade') return await install(command === 'upgrade');
    const s = state();
    if (command === 'start') return await start(s);
    if (command === 'stop') return await stop(s);
    if (command === 'health' || command === 'status') return await health(s);
    if (command === 'password') { if (!discovery()) throw Error('Start the harness first'); if (!readConfig(configFile).tailnetAddress) throw Error('Configure the authenticated gateway first; see docs/harness-deployment.md'); return localCommand(s, 'service-password'); }
    if (command === 'backup') return console.log(`Backup: ${snapshot(s)}`);
    requireStopped();
    if (command === 'rollback') {
      const key = option('--backup'), dir = childPath('backups', key), b = json(join(dir, 'backup.json'));
      if (b.version !== 1 || b.root !== root || !existsSync(join(childPath('releases', b.release), 'release.json'))) throw Error('Backup release is not available in this installation');
      const saved = snapshot(s), staged = join(root, 'restore-' + id());
      if (existsSync(join(dir, 'var'))) copy(join(dir, 'var'), staged); else mkdirSync(staged, { mode: 0o700 });
      renameSync(data, join(root, 'backups', saved, 'replaced-var'));
      renameSync(staged, data);
      save(configFile, json(join(dir, 'config.json')));
      save(stateFile, { version: 1, root, current: b.release, previous: s.current, backup: saved });
      return console.log(`Restored release and data from ${key}; newer data retained in backup ${saved}. Run start explicitly.`);
    }
    if (command === 'uninstall') {
      for (const name of readdirSync(join(root, 'releases'))) {
        const dir = childPath('releases', name);
        if (!existsSync(join(dir, 'release.json')) || json(join(dir, 'release.json')).id !== name) throw Error(`Unrecognized/incomplete release retained: ${dir}`);
      }
      rmSync(join(root, 'releases'), { recursive: true });
      renameSync(stateFile, join(root, 'uninstalled-' + id() + '.json'));
      console.log(`Application releases removed. Data/config/logs/backups preserved at ${root}; no system service or other runtime changed.`);
    }
  } finally { rmSync(lock, { recursive: true }); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
