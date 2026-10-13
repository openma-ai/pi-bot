import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createFileChangeDetector } from '../src/daemon/runtime/proactive-detectors.ts';
test('allowlisted file monitor observes metadata changes without reading contents', async () => {
    await mkdir(resolve('work/proactive-tests'), {
        recursive: true
    });
    const dir = await mkdtemp(resolve('work/proactive-tests/detector-'));
    const path = join(dir, 'build.json');
    const detect = createFileChangeDetector(path);
    try {
        const first = await detect({
            dryRun: false, signal: new AbortController().signal
        });
        assert.equal(first.decision, 'silent');
        await writeFile(path, 'LOCAL STATUS');
        const change = await detect({
            dryRun: false, cursor: first.cursor, baseline: first.baseline, signal: new AbortController().signal
        });
        assert.equal(change.decision, 'wake');
        assert.doesNotMatch(change.payload!, /LOCAL STATUS/);
        const same = await detect({
            dryRun: false, cursor: change.cursor, baseline: change.baseline, signal: new AbortController().signal
        });
        assert.equal(same.decision, 'silent');
    }
    finally {
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
