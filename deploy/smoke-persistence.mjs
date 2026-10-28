#!/usr/bin/env node
// Bounded, opt-in QA using a cached image only. Keeps its container, volume and evidence.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function option(key) { const i = args.indexOf(key); if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Required: ${key}`); return args[i + 1]; }
const image = option('--image'), name = option('--name'), out = resolve(option('--out'));
if (!/^pibo-[a-z0-9-]*qa-[a-z0-9-]+$/.test(name)) throw Error('Use a new pibo-…qa-… container name');
const volume = name + '-data', source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(out, { mode: 0o700 }); // Refuse an existing evidence directory.
process.umask(0o077);
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function docker(argv, allowFailure = false) {
  appendFileSync(join(out, 'commands.sh'), 'docker ' + argv.map(quote).join(' ') + '\n');
  const r = spawnSync('docker', argv, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 60000 });
  appendFileSync(join(out, 'execution.jsonl'), JSON.stringify({ argv, exitCode: r.status,
    stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message }) + '\n');
  if (!allowFailure && (r.error || r.status !== 0)) throw Error(`docker ${argv[0]} failed; see ${out}/execution.jsonl`);
  return r;
}
let created = false;
const result = { name, volume, image, source, phases: [], dataKiB: [] };
function measure() {
  const value = Number(docker(['exec', name, 'du', '-sk', '/data']).stdout.trim().split(/\s+/)[0]);
  if (!Number.isFinite(value) || value > 20480) throw Error(`QA data limit exceeded: ${value} KiB; stop and report`);
  result.dataKiB.push(value);
}
function stop() {
  docker(['stop', '--time', '45', name]);
  const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', name]).stdout);
  if (state.Status !== 'exited' || state.ExitCode !== 0) throw Error(`Expected stopped exit 0, got ${state.Status}/${state.ExitCode}`);
  return { status: state.Status, exitCode: state.ExitCode };
}
try {
  if (docker(['container', 'inspect', name], true).status === 0 || docker(['container', 'inspect', name + '-init'], true).status === 0 || docker(['volume', 'inspect', volume], true).status === 0) throw Error('Use an unused name; existing containers/volumes are never adopted');
  result.imageId = docker(['image', 'inspect', '--format', '{{.Id}}', image]).stdout.trim();
  docker(['volume', 'create', '--label', 'io.pibo.qa=' + name, volume]);
  // No image data is copied into the new volume. This one-shot process only sets its owner.
  docker(['run', '--name', name + '-init', '--label', 'io.pibo.qa=' + name, '--pull=never',
    '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
    '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges', '--memory', '32m', '--pids-limit', '16',
    '--mount', `type=volume,source=${volume},target=/data,volume-nocopy`, '--entrypoint', '/bin/sh', result.imageId,
    '-c', 'chown 1000:1000 /data && chmod 700 /data']);
  const mounts = ['src', 'vendor', 'package.json', 'deploy', 'dist/gui'].flatMap(part => [
    '--mount', `type=bind,source=${join(source, part)},target=/qa/${part},readonly`
  ]);
  docker(['run', '-d', '--name', name, '--label', 'io.pibo.qa=' + name, '--pull=never',
    '--network', 'none', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '1000:1000', '--memory', '768m', '--cpus', '1', '--pids-limit', '256',
    '--tmpfs', '/tmp:rw,size=32m,mode=1777', '--tmpfs', '/qa:rw,size=4m,uid=1000,gid=1000,mode=700',
    '--mount', `type=volume,source=${volume},target=/data,volume-nocopy`, ...mounts,
    '--entrypoint', '/bin/sh', result.imageId, '-c',
    'ln -s /app/node_modules /qa/node_modules; exec node /qa/deploy/launch-harness.mjs /data']);
  created = true;
  const probe = phase => JSON.parse(docker(['exec', name, 'node', '--import', '/app/node_modules/tsx/dist/loader.mjs',
    '/qa/deploy/persistence-probe.mjs', phase]).stdout.trim());
  result.phases.push(probe('write')); measure();
  result.firstStop = stop();
  docker(['start', name]);
  result.phases.push(probe('verify')); measure();
  result.finalStop = stop();
  const settings = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig}}', name]).stdout);
  result.networkMode = settings.NetworkMode;
  result.publishedPorts = settings.PortBindings;
  result.memoryBytes = settings.Memory;
  result.readOnlyRootfs = settings.ReadonlyRootfs;
  if (settings.NetworkMode !== 'none' || Object.keys(settings.PortBindings || {}).length) throw Error('Unexpected network configuration');
  result.complete = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
  if (created) { docker(['logs', '--tail', '60', name], true); docker(['stop', '--time', '45', name], true); }
} finally {
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
