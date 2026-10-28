// This pinned dependency assumes its process entrypoint is Pi's own CLI. Pibo's
// launcher is a different host: unbounded metadata discovery otherwise climbs
// out of the .app and asks macOS for Documents-folder access during import.
// Patch only the generated bundle copy, never the installed repository package.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
export function boundHarnessPackageSearch(bundle) {
  const root = join(bundle, 'node_modules/pi-subagents');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (version !== '0.77.0') throw Error('Review the harness package-search boundary for the new pi-subagents version.');
  const file = join(root, 'src/runs/shared/pi-spawn.js');
  const marker = '// Pibo bundled-resource search boundary';
  const source = readFileSync(file, 'utf8');
  if (source.includes(marker)) return;
  const original = 'export function findPiPackageRootFromEntry(entryPoint) {\n    let dir = path.dirname(entryPoint);\n    while (dir !== path.dirname(dir)) {';
  const replacement = `export function findPiPackageRootFromEntry(entryPoint) {
    ${marker}
    const boundary = process.env.PIBOT_HARNESS_ROOT;
    let dir = path.dirname(entryPoint);
    while (dir !== path.dirname(dir)) {
        if (boundary && dir !== boundary && !dir.startsWith(boundary + path.sep)) return undefined;`;
  if (!source.includes(original)) throw Error('Pinned pi-subagents package-search function changed; refusing an unreviewed patch.');
  writeFileSync(file, source.replace(original, replacement));
}
