import test from 'node:test';
import assert from 'node:assert/strict';
test('TaskChain oracle runs independent executable checks and rejects a placeholder', async () => {
    const module = await import('../src/evals/taskchain-evaluation.ts').catch(() => null);
    assert.ok(module, 'real-work adapter must exist');
    const result = await module!.gradeTaskChain('class TaskChain:\n    pass\n');
    assert.equal(result.pass, false);
    assert.ok(result.failed.length > 0);
});
test('CSV report oracle checks computed completion counts, not file presence or a DONE claim', async () => {
    const module = await import('../src/evals/taskchain-evaluation.ts').catch(() => null);
    assert.ok(module, 'real-work adapter must exist');
    assert.equal(module!.gradeProgressCsv('owner,total,completed,completion_rate\nalice,2,1,0.5\nbob,3,2,0.666667\n'), true);
    assert.equal(module!.gradeProgressCsv('owner,total,completed,completion_rate\nalice,2,2,1.0\nbob,3,2,0.666667\n'), false);
    assert.equal(module!.gradeProgressCsv('DONE'), false);
});
test('TaskChain oracle accepts a functional implementation and rejects a stale notification contract', async () => {
    const module = await import('../src/evals/taskchain-evaluation.ts').catch(() => null);
    assert.ok(module);
    const { readFile } = await import('node:fs/promises');
    const code = await readFile(new URL('../fixtures/marble-taskchain/reference.py', import.meta.url), 'utf8');
    const valid = await module!.gradeTaskChain(code);
    assert.equal(valid.pass, true, JSON.stringify(valid));
    assert.equal(valid.passed.length, 12);
    const stale = await module!.gradeTaskChain(code.replace("'unblocked'", "'ready'"));
    assert.equal(stale.pass, false);
    assert.ok(stale.failed.includes('notification-contract'));
});
test('real-work adapter validates code and computed CSV through native jobs under corrected/cancelled inbox traffic', async () => {
    const module = await import('../src/evals/taskchain-evaluation.ts');
    assert.equal(typeof module.runTaskChainEvaluation, 'function', 'native real-work runner must exist');
    const report = await module.runTaskChainEvaluation({
        mode: 'scripted'
    });
    assert.equal(report.mode, 'scripted');
    assert.equal(report.pass, true, JSON.stringify(report));
    assert.equal(report.score.completedTasks, 2);
    assert.equal(report.score.cancelledActions, 0);
    assert.equal(report.score.noiseReplies, 0);
    assert.ok(report.trace.inbox.some(e => e.taskControl === 'replace'));
    assert.ok(report.trace.calls.some(e => e.name === 'submit_taskchain' && e.parentId));
    assert.ok(report.trace.calls.some(e => e.name === 'submit_progress_csv' && e.parentId));
});
test('TaskChain background execution retains native cells, observes grading progress and runs each Python process once', async () => {
    const { runTaskChainEvaluation } = await import('../src/evals/taskchain-evaluation.ts');
    const report = await runTaskChainEvaluation({
        mode: 'scripted', backgroundExecution: true
    });
    assert.equal(report.backgroundExecution, true);
    assert.equal(report.pass, true, JSON.stringify(report.score));
    assert.ok(report.trace.calls.some(c => c.name === 'codemode'));
    assert.ok(report.trace.results.some(c => ['codemode', 'codemode_wait'].includes(c.name) && JSON.stringify(c.content).includes('grade_started')));
    assert.ok(report.background!.observedProgress);
    assert.ok(report.background!.cells.length > 0);
    assert.equal(report.background!.processStarts, 1);
    assert.equal(report.background!.processEnds, 1);
    assert.ok(report.background!.sameProcess);
    assert.equal(report.background!.processStarts, 1);
    assert.equal(report.background!.processEnds, 1);
    // Cancellation owes no final user result or gratuitous read of cancelled work.
    // Full-result observation remains mandatory for non-cancelled task suites.
});
test('executable oracle exposes started/finished observations for one real Python PID', async () => {
    const { gradeTaskChain } = await import('../src/evals/taskchain-evaluation.ts');
    const { readFile } = await import('node:fs/promises');
    const code = await readFile(new URL('../fixtures/marble-taskchain/reference.py', import.meta.url), 'utf8');
    const events: {
        event: string;
        pid: number;
    }[] = [];
    const result = await gradeTaskChain(code, {
        onProgress: event => events.push(event)
    });
    assert.equal(result.pass, true);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.event, 'grade_started');
    assert.equal(events[1]!.event, 'grade_finished');
    assert.equal(events[0]!.pid, events[1]!.pid);
});
test('oracle failure diagnostics identify wrong exception contracts without dumping program exceptions', async () => {
    const { gradeTaskChain } = await import('../src/evals/taskchain-evaluation.ts');
    const { readFile } = await import('node:fs/promises');
    const reference = await readFile(new URL('../fixtures/marble-taskchain/reference.py', import.meta.url), 'utf8');
    const result = await gradeTaskChain('class CustomError(Exception):\n    pass\n' + reference.replaceAll('raise ValueError', 'raise CustomError'));
    assert.equal(result.pass, false);
    assert.ok(result.failureReasons?.['dependency-start']?.includes('ValueError or KeyError'));
});
test('full-result oracle accepts a complete native wait result and rejects READY claims or partial pages', async () => {
    const module = await import('../src/evals/observed-taskchain-evaluation.ts');
    assert.equal(typeof module.hasFullValidationObservation, 'function');
    const grade = {
        pass: true, passed: ['empty', 'dependency-start', 'dependency-order', 'complete-before-start', 'duplicate-id', 'unknown-dependency', 'unknown-task', 'duplicate-complete', 'multiple-dependencies', 'collaboration-comments', 'notification-contract', 'reports-and-diagram'], failed: []
    };
    const text = JSON.stringify({
        artifact: 'TaskChain/solution.py', grade
    });
    assert.equal(module.hasFullValidationObservation({
        name: 'codemode_wait', details: {
            state: 'completed'
        }, content: [{
                type: 'text', text
            }]
    }), true);
    assert.equal(module.hasFullValidationObservation({
        name: 'codemode_wait', details: {
            state: 'completed'
        }, content: [{
                type: 'text', text: 'READY TaskChain/solution.py'
            }]
    }), false);
    assert.equal(module.hasFullValidationObservation({
        name: 'codemode_read', details: {
            done: false
        }, content: [{
                type: 'text', text
            }]
    }), false);
});
test('background compaction overlaps native foreground, excludes late correction from its snapshot and adopts at a safe boundary', async () => {
    const { runTaskChainEvaluation } = await import('../src/evals/taskchain-evaluation.ts');
    const { RequestBudget, SMOKE_CAP } = await import('../src/evals/evaluation.ts');
    const report = await runTaskChainEvaluation({
        mode: 'scripted', backgroundExecution: true, backgroundSummary: true, budget: new RequestBudget({
            ...SMOKE_CAP, inputTokenReservations: 1000000
        })
    });
    assert.equal(report.pass, true, JSON.stringify({
        score: report.score, compaction: report.compaction, budget: report.budget
    }));
    assert.ok(report.compaction!.started > 0);
    assert.ok(report.compaction!.completed > 0);
    assert.ok(report.compaction!.adopted > 0);
    assert.ok(report.compaction!.foregroundOverlap > 0);
    assert.equal(report.compaction!.lateCorrectionExcluded, true);
    assert.ok(report.compaction!.blockedStaleActions > 0);
});
test('release-tag oracle verifies the real generated module value for the late task revision', async () => {
    const { gradeTaskChain } = await import('../src/evals/taskchain-evaluation.ts');
    const { readFile } = await import('node:fs/promises');
    const code = await readFile(new URL('../fixtures/marble-taskchain/reference.py', import.meta.url), 'utf8');
    assert.equal((await gradeTaskChain(code, {
        expectedRelease: 'audit-20261013-v3'
    })).pass, false);
    const result = await gradeTaskChain("RELEASE_TAG='audit-20261013-v3'\n" + code, {
        expectedRelease: 'audit-20261013-v3'
    });
    assert.equal(result.pass, true);
    assert.ok(result.passed.includes('release-tag'));
});
test('cancellation during the real Python execution preserves its process and blocks the later native artifact commit', async () => {
    const { runTaskChainEvaluation } = await import('../src/evals/taskchain-evaluation.ts');
    const report = await runTaskChainEvaluation({
        mode: 'scripted', backgroundExecution: true, cancelDuringExecution: true
    });
    assert.equal(report.pass, true, JSON.stringify({
        score: report.score, background: report.background
    }));
    assert.equal(report.score.expectedTasks, 1);
    assert.equal(report.score.completedTasks, 1);
    assert.equal(report.score.cancelledActions, 0);
    assert.ok(Number(report.background!.blockedStaleActions) > 0);
    assert.ok(report.background!.sameProcess);
});
