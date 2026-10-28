// App-owned harness only. The pipe from the native parent is its lifetime lease.
// No auth files or provider environment variables are imported from the host.
import {openSync, closeSync, readFileSync, unlinkSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
if (args[0] !== 'daemon' || !args.includes('--data-dir') || !args.includes('--pi-dir') || value('--listen') !== 'http://127.0.0.1:0') {
  throw Error('The desktop harness requires isolated data/model directories and a dynamic loopback listener.');
}
const dataDir = resolve(value('--data-dir'));
const bundleRoot = dirname(fileURLToPath(import.meta.url));
// Resolve metadata within this bundle. Generic Pi CLI ancestor discovery must
// not probe the host project, Documents folder, or global Pi configuration.
process.env.PIBOT_HARNESS_ROOT = bundleRoot;
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = join(bundleRoot, 'node_modules/@earendil-works/pi-coding-agent');
process.env.PI_CODING_AGENT_DIR = resolve(value('--pi-dir'));
process.env.TSX_TSCONFIG_PATH = join(bundleRoot, 'tsconfig.json');
mkdirSync(dataDir, {recursive: true, mode: 0o700});
const lease = join(dataDir, 'desktop-owner.json');
const owner = {pid: process.pid, nonce: randomUUID()};
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
for (let attempt = 0; ; attempt++) {
  try {
    const fd = openSync(lease, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(owner));
    closeSync(fd);
    break;
  } catch (error) {
    if (error.code !== 'EEXIST' || attempt > 0) throw Error('Cannot claim the app-owned harness directory.');
    let previous;
    try { previous = JSON.parse(readFileSync(lease, 'utf8')); } catch { throw Error('Harness lease is unreadable; no process was stopped.'); }
    if (alive(previous.pid)) throw Error('Another Pibo application owns this harness. Close that application first.');
    // Only stale leases are recovered. Never signal a PID read from a file.
    unlinkSync(lease);
  }
}
function release() {
  try {
    if (JSON.parse(readFileSync(lease, 'utf8')).nonce === owner.nonce) unlinkSync(lease);
  } catch { /* A crashed process leaves a stale lease for the next start. */ }
}
process.once('exit', release);
let runtime;
let stopping = false;
let requestedStop = false;
async function stop() {
  requestedStop = true;
  if (stopping || !runtime) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 8000);
  deadline.unref();
  try { await runtime.close(); } finally { release(); process.exit(0); }
}
process.stdin.once('end', () => void stop());
process.stdin.once('error', () => void stop());
process.stdin.resume();
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
try {
  process.stderr.write('Pibo harness: importing runtime\n');
  const {main} = await import('./src/daemon/main.ts');
  process.stderr.write('Pibo harness: starting runtime\n');
  runtime = await main(args);
  process.stderr.write('Pibo harness: ready\n');
  if (requestedStop) await stop();
} catch (error) {
  // Native reports a bounded startup failure; no configuration or secrets are printed.
  process.stderr.write(`Pibo harness startup failed (${error?.name || 'Error'}).\n`);
  release();
  process.exit(1);
}
