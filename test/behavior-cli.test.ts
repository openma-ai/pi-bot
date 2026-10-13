import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
test('new behavior CLI dry-run declares real-work caps and performs no auth or provider request', async () => {
    assert.equal(await access('src/behavior-cli.ts').then(() => true, () => false), true, 'behavior CLI must exist');
    const { stdout } = await execute(process.execPath, ['--import', 'tsx', 'src/behavior-cli.ts', '--dry-run', '--real', '--suite', 'taskchain', '--auth-source', 'dsh']);
    const result = JSON.parse(stdout);
    assert.equal(result.paidRequests, 0);
    assert.equal(result.suite, 'taskchain');
    assert.equal(result.caps.requests, 32);
    assert.equal(result.caps.inputTokenReservations, 384000);
    assert.equal(result.thinking.effort, 'high');
    assert.equal(result.backgroundSummary, false);
});
test('behavior CLI refuses to overwrite a report before authentication', async () => {
    assert.equal(await access('src/behavior-cli.ts').then(() => true, () => false), true);
    const dir = await mkdtemp(join(tmpdir(), 'pi-cli-test-'));
    const file = join(dir, 'report.json');
    try {
        await writeFile(file, 'EXISTING_REPORT');
        await assert.rejects(() => execute(process.execPath, ['--import', 'tsx', 'src/behavior-cli.ts', '--real', '--auth-source', 'dsh', '--report', file]));
        assert.equal(await readFile(file, 'utf8'), 'EXISTING_REPORT');
    }
    finally {
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
test('behavior CLI declares bounded background execution without imposing the cancelled USD ceiling', async () => {
    const { stdout } = await execute(process.execPath, ['--import', 'tsx', 'src/behavior-cli.ts', '--dry-run', '--real', '--suite', 'taskchain', '--background-execution', '--auth-source', 'dsh']).catch(() => ({
        stdout: '{}'
    }));
    const result = JSON.parse(stdout);
    assert.equal(result.backgroundExecution, true);
    assert.equal(result.dollarBudgetUsd, null);
    assert.ok(!Object.hasOwn(result.caps, 'approvedUsdNeeded'));
});
