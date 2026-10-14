import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
test('complex engineering benchmark dry run exposes a two-bot project and independent executable oracle without authentication', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/evals/complex-repo-cli.ts', '--dry-run']);
    const plan = JSON.parse(stdout);
    assert.equal(plan.bots, 2);
    assert.equal(plan.oracleTests, 26);
    assert.equal(plan.paidRequests, 0);
    assert.ok(plan.features.includes('SQLite migration'));
});
