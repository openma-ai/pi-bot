import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProactiveBenchmark } from '../src/proactive-benchmark.ts';
test('bounded native Pi mixed-load benchmark delivers real tool results and preserves silence', {
    timeout: 20000
}, async () => {
    await mkdir(resolve('work/proactive-tests'), {
        recursive: true
    });
    const dir = await mkdtemp(resolve('work/proactive-tests/benchmark-'));
    try {
        const result = await runProactiveBenchmark(dir);
        assert.equal(result.mode, 'scripted-native-pi');
        assert.equal(result.paidRequests, 0);
        assert.equal(result.fixture.bots, 4);
        assert.equal(result.trace.calls.filter(c => c.name === 'send_to_bot').length, 8);
        assert.ok(result.score.expectedTasks >= 16);
        assert.equal(result.score.completed, result.score.expectedTasks);
        assert.equal(result.score.missed + result.score.duplicates + result.score.wrongRecipients + result.score.silenceBreaches + result.score.expiredReplies, 0);
        assert.equal(result.score.latencyMs.firstEffectiveResponse.samples, result.score.expectedTasks);
        assert.ok(result.providerRequests <= 128);
        assert.equal(result.runtimeErrors, 0);
        assert.equal(result.nativeToolErrors, 0);
        assert.equal(result.artifactFailures.length, 0);
    }
    finally {
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
