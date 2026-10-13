import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runProactiveBenchmark } from './proactive-benchmark.ts';
import { scoreResponseBenchmark } from './response-benchmark.ts';
const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== '--output'))
    throw Error('Usage: benchmark:proactive [--output NEW_DIRECTORY]');
const directory = resolve(argv[1] ?? `work/proactive-benchmark-${Date.now()}`);
await mkdir(directory); // Existing directory refused, so evidence/artifacts cannot be overwritten.
const rounds = [];
for (let i = 0; i < 3; i++) {
    const report = await runProactiveBenchmark(join(directory, `round-${i + 1}`));
    await writeFile(join(directory, `round-${i + 1}.json`), JSON.stringify(report, null, 2), {
        flag: 'wx'
    });
    rounds.push(report);
}
const score = scoreResponseBenchmark(rounds.flatMap(r => r.trace.inbox), rounds.flatMap(r => r.trace.outbox), rounds.flatMap(r => r.expected), rounds.flatMap(r => r.trace.jobs), rounds.flatMap(r => r.fires));
const result = {
    mode: 'scripted-native-pi', paidRequests: 0, rounds: rounds.length, providerRequests: rounds.reduce((sum, r) => sum + r.providerRequests, 0), score, nativeToolErrors: rounds.reduce((sum, r) => sum + r.nativeToolErrors, 0), artifactFailures: rounds.flatMap(r => r.artifactFailures), pass: rounds.every(r => r.score.completed === r.score.expectedTasks && !r.score.missed && !r.score.duplicates && !r.score.wrongRecipients && !r.score.silenceBreaches && !r.runtimeErrors && !r.pending && !r.refusedRequests && !r.nativeToolErrors && !r.artifactFailures.length), notes: rounds[0].notes
};
await writeFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2), {
    flag: 'wx'
});
console.log(JSON.stringify({
    report: join(directory, 'summary.json'), pass: result.pass, completed: score.completed, expected: score.expectedTasks, latencyMs: score.latencyMs, paidRequests: 0
}));
if (!result.pass)
    process.exitCode = 1;
