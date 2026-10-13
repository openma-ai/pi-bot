import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEvaluation } from '../src/evaluation.ts';
test('evaluation retains native inbox, tool call/results and delivered send_message without reasoning', async () => {
    const report = await runEvaluation({
        scenarioIds: ['handoff'], trace: true
    });
    assert.equal(report.scenarios.length, 1);
    const trace = report.scenarios[0]!.trace!;
    assert.ok(trace.inbox.some(e => e.kind === 'bot' && e.replyTo));
    assert.ok(trace.calls.some(e => e.name === 'send_to_bot'));
    assert.ok(trace.calls.some(e => e.name === 'start_job'));
    assert.ok(trace.calls.some(e => e.name === 'commit_record'));
    assert.ok(trace.calls.some(e => e.name === 'send_message'));
    assert.ok(trace.results.every(e => trace.calls.some(c => c.id === e.id)));
    assert.equal(trace.outbox.length, 1);
    assert.equal(trace.outbox[0]!.state, 'delivered');
    assert.equal(trace.outbox[0]!.text, 'DONE handoff=FINISHED');
    assert.ok(!JSON.stringify(trace).includes('thinking'));
});
test('trace redaction removes credential fields, bearer/key strings and thinking while retaining task evidence', async () => {
    const module = await import('../src/evaluation-trace.ts').catch(() => null);
    assert.ok(module, 'trace redactor must exist');
    const safe = module!.redactTraceValue({
        apiKey: 'synthetic-value', thinking: 'PRIVATE_REASONING', text: 'Authorization: Bearer private-token; key sk-abcdef0123456789', taskId: 'task-1', content: [{
                type: 'thinking', thinking: 'PRIVATE_REASONING'
            }, {
                type: 'text', text: 'DONE'
            }]
    });
    const json = JSON.stringify(safe);
    for (const secret of ['synthetic-value', 'PRIVATE_REASONING', 'private-token', 'sk-abcdef0123456789'])
        assert.ok(!json.includes(secret));
    assert.ok(json.includes('task-1') && json.includes('DONE'));
});
