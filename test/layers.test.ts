import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

/**
 * Enforces the layer stack (arrows = allowed imports):
 *   gui ─► sdk ─(type-only)─► pi ◄─ daemon ─(type-only)─► sdk
 *   evals ─► anything (tooling outside the stack)
 * daemon may additionally import protocol constants from sdk/protocol.ts (never the client).
 */
const valueExceptions: Record<string, string[]> = { daemon: ['sdk/protocol.ts'] };
const allowed: Record<string, { value: string[]; typeOnly: string[] }> = {
    pi: { value: ['pi'], typeOnly: [] },
    sdk: { value: ['sdk'], typeOnly: ['pi'] },
    daemon: { value: ['daemon', 'pi'], typeOnly: ['sdk'] },
    gui: { value: ['gui', 'sdk'], typeOnly: [] },
    evals: { value: ['evals', 'pi', 'daemon', 'sdk'], typeOnly: [] }
};
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx|jsx)$/.test(e.name) ? [join(dir, e.name)] : []);
const importPattern = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

test('source tree only contains known layers', () => {
    assert.deepEqual(readdirSync('src').sort(), Object.keys(allowed).sort());
});

for (const layer of Object.keys(allowed))
    test(`layer ${layer} respects the dependency rules`, () => {
        const violations: string[] = [];
        for (const file of files(join('src', layer))) {
            const text = readFileSync(file, 'utf8');
            for (const m of text.matchAll(importPattern)) {
                const spec = m[3] ?? m[4];
                const typeOnly = Boolean(m[2]);
                if (!spec.startsWith('.'))
                    continue;
                const target = normalize(join(dirname(file), spec));
                const rel = relative('src', target);
                if (rel.startsWith('..')) {
                    // Outside src: only vendored code and pinned node_modules internals are permitted.
                    if (!/^\.\.[\\/](vendor|node_modules)[\\/]/.test(rel) && !(layer === 'evals' && /^\.\.[\\/](examples|fixtures)[\\/]/.test(rel)))
                        violations.push(`${file}: ${spec}`);
                    continue;
                }
                const targetLayer = rel.split(/[\\/]/)[0];
                const rule = allowed[layer];
                if (!rule.value.includes(targetLayer) && !(typeOnly && rule.typeOnly.includes(targetLayer)) && !valueExceptions[layer]?.includes(rel.replaceAll('\\', '/')))
                    violations.push(`${file}: ${typeOnly ? 'type ' : ''}${spec}`);
            }
        }
        assert.deepEqual(violations, []);
    });

test('pi plugin layer stays host-agnostic (no node:sqlite / http)', () => {
    for (const file of files('src/pi'))
        assert.doesNotMatch(readFileSync(file, 'utf8'), /from ['"]node:(sqlite|http)['"]/, file);
});

test('sdk is browser-safe (no node: imports)', () => {
    for (const file of files('src/sdk'))
        assert.doesNotMatch(readFileSync(file, 'utf8'), /from ['"]node:/, file);
});
