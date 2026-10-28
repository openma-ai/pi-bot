// Offline, reproducible staging from the installed locked dependencies and Node.
// No downloads, npm install hooks, credentials, or user runtime data are involved.
import {cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, readdirSync, lstatSync, statSync, rmSync, chmodSync, renameSync} from 'node:fs';
import {resolve, join, dirname, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {boundHarnessPackageSearch} from './harness-resource-boundary.mjs';

const client = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(client, '../..');
const output = join(client, '.harness-build');
const staging = join(client, `.harness-build-${process.pid}`);
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('The bundled harness build is verified for macOS arm64 only. Other desktop targets need their own trusted Node/native dependency build.');
if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Build the desktop harness using the project-supported Node 24.');
const node = realpathSync(process.execPath);
const libraries = spawnSync('otool', ['-L', node], {encoding: 'utf8'});
if (libraries.status !== 0 || libraries.stdout.split('\n').slice(1).filter(Boolean).some(line => !/^\s+(\/System\/Library\/|\/usr\/lib\/)/.test(line))) throw Error('Node must be self-contained and link only Apple system libraries.');
const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const lockText = readFileSync(join(repo, 'package-lock.json'), 'utf8');
const lock = JSON.parse(lockText);
const required = new Set(Object.entries(lock.packages).filter(([path, info]) => path && !info.dev).map(([path]) => path));
// tsx is a build/dev dependency in the repo but is the shipped TypeScript loader.
function addLoader(path) {
  if (required.has(path)) return;
  const entry = lock.packages[path];
  if (!entry) throw Error(`Missing locked loader package: ${path}`);
  required.add(path);
  for (const name of Object.keys({...entry.dependencies, ...entry.optionalDependencies})) {
    let cursor = path;
    let dependency;
    while (cursor) {
      const candidate = `${cursor}/node_modules/${name}`;
      if (lock.packages[candidate]) { dependency = candidate; break; }
      const index = cursor.lastIndexOf('/node_modules/');
      cursor = index < 0 ? '' : cursor.slice(0, index);
    }
    addLoader(dependency || `node_modules/${name}`);
  }
}
addLoader('node_modules/tsx');
// tsx reads the installed TypeScript version while parsing its explicit config.
// Supplying the locked package keeps that lookup inside the app as well.
addLoader('node_modules/typescript');
mkdirSync(staging, {recursive: true});
try {
  mkdirSync(join(staging, 'bin'));
  cpSync(node, join(staging, 'bin/node'));
  chmodSync(join(staging, 'bin/node'), 0o755);
  cpSync(join(repo, 'src'), join(staging, 'src'), {recursive: true, dereference: true});
  cpSync(join(repo, 'vendor'), join(staging, 'vendor'), {recursive: true, dereference: true});
  cpSync(join(client, 'harness/launcher.mjs'), join(staging, 'launcher.mjs'));
  cpSync(join(client, 'harness/tsconfig.json'), join(staging, 'tsconfig.json'));
  // The background bridge is a required local dependency patch, never a network install.
  const patch = spawnSync(node, [join(repo, 'scripts/apply-pi-background-bridge.mjs')], {cwd: repo, encoding: 'utf8'});
  if (patch.status !== 0) throw Error('Cannot prepare the required Pi background bridge.');
  let copied = 0;
  for (const path of [...required].sort()) {
    const source = join(repo, path);
    const entry = lock.packages[path];
    if (!existsSync(source)) {
      if (entry.optional) continue; // Other-platform optional native packages are not installed.
      throw Error(`Required installed dependency is missing: ${path}`);
    }
    if (entry.link) throw Error(`Linked dependency cannot be shipped: ${path}`);
    mkdirSync(dirname(join(staging, path)), {recursive: true});
    cpSync(source, join(staging, path), {recursive: true, dereference: true, filter: file => relative(source, file).split(sep)[0] !== 'node_modules'});
    copied++;
  }
  writeFileSync(join(staging, 'package.json'), JSON.stringify({name:'pibo-bundled-harness',version:packageJson.version,type:'module',private:true,engines:{node:'>=24 <25'}}, null, 2)+'\n');
  boundHarnessPackageSearch(staging);
  let bytes = 0;
  function inspect(dir) {
    for (const entry of readdirSync(dir, {withFileTypes:true})) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) throw Error('Bundled harness must not contain symlinks.');
      if (entry.isDirectory()) inspect(path); else bytes += statSync(path).size;
    }
  }
  inspect(staging);
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {cwd:repo, encoding:'utf8'}).stdout.trim();
  const sourceDirty = !!spawnSync('git', ['status', '--porcelain'], {cwd:repo, encoding:'utf8'}).stdout.trim();
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify({format:1,platform:process.platform,arch:process.arch,node:process.version,version:packageJson.version,sourceCommit:revision,sourceDirty,sourceCommitMeaning:'base commit; sourceDirty indicates uncommitted build inputs',lockSha256:createHash('sha256').update(lockText).digest('hex'),packages:copied,bytes}, null, 2)+'\n');
  // Only replace this script's generated staging directory, never runtime data.
  if (existsSync(output)) rmSync(output, {recursive:true});
  renameSync(staging, output);
  process.stdout.write(`Staged real desktop harness: ${output}\n${copied} packages, ${(bytes/1024/1024).toFixed(1)} MiB, Node ${process.version}; no external symlinks.\n`);
} catch (error) {
  process.stderr.write(`Harness staging failed. Partial generated files retained at ${staging}.\n`);
  throw error;
}
