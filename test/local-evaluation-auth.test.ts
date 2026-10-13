import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('explicit DSH host auth reads only the selected scalar and returns fixed errors for ambiguous metadata', async () => {
    const module = await import('../src/evals/local-evaluation-auth.ts').catch(() => null);
    assert.ok(module, 'local auth adapter must exist');
    const dir = await mkdtemp(join(tmpdir(), 'pi-auth-fixture-'));
    const file = join(dir, 'credentials.yaml');
    try {
        for (const value of ['synthetic-local-key', '"synthetic-local-key"', "'synthetic-local-key'"]) {
            await writeFile(file, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${value}\n`);
            assert.equal(await module.readLocalDshDeepSeekKey(file), 'synthetic-local-key');
        }
        await writeFile(file, 'refs:\n  DEEPSEEK_API_KEY: invalid secret with spaces\n');
        await assert.rejects(() => module.readLocalDshDeepSeekKey(file), /^Error: Local DeepSeek credential unavailable$/);
        await writeFile(file, 'refs:\n  DEEPSEEK_API_KEY: synthetic-key-one\n  DEEPSEEK_API_KEY: synthetic-key-two\n');
        await assert.rejects(() => module.readLocalDshDeepSeekKey(file), /^Error: Local DeepSeek credential unavailable$/);
    }
    finally {
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
