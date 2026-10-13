import type { Envelope, Outbound, Job } from '../daemon/runtime/store.ts';
import type { Fire } from '../daemon/runtime/proactive.ts';
export type ResponseExpectation = {
    inboxId: string;
    finalText?: string;
    effectiveTexts?: string[];
    silent?: boolean;
    deadline?: number;
};
function distribution(values: number[]) {
    const sorted = values.filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    const at = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
    return {
        samples: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? null
    };
}
/** Ground truth is external to the model. Missing timestamps remain unknown, never zero. */
export function scoreResponseBenchmark(inbox: Envelope[], outbox: Outbound[], expected: ResponseExpectation[], jobs: Job[] = [], fires: Fire[] = []) {
    const values = {
        admission: [] as number[], userAdmission: [] as number[], firstEffectiveResponse: [] as number[], userFirstEffectiveResponse: [] as number[], admissionToEffectiveResponse: [] as number[], completion: [] as number[], delivery: [] as number[], jobExecution: [] as number[], triggerLateness: [] as number[], resultConsumption: [] as number[]
    };
    let completed = 0, missed = 0, duplicates = 0, wrongRecipients = 0, silenceBreaches = 0, unexpectedReplies = 0, expiredReplies = 0;
    const samples = expected.map(spec => {
        const e = inbox.find(e => e.id === spec.inboxId);
        if (!e)
            throw Error('Benchmark expectation references unknown inbox');
        if (!spec.silent && !spec.finalText)
            throw Error('A final response oracle is required');
        const replies = outbox.filter(o => o.replyTo === e.id && ['pending', 'sending', 'delivered', 'uncertain'].includes(o.state));
        const routed = replies.filter(o => o.botId === e.to && o.taskId === e.taskId && JSON.stringify(o.route) === JSON.stringify(e.route));
        wrongRecipients += replies.length - routed.length;
        const usable = routed.filter(o => o.state === 'delivered' && (spec.deadline === undefined || (o.deliveredAt !== undefined && o.deliveredAt <= spec.deadline))).sort((a, b) => a.createdAt - b.createdAt);
        expiredReplies += routed.filter(o => o.state === 'delivered' && spec.deadline !== undefined && o.deliveredAt !== undefined && o.deliveredAt > spec.deadline).length;
        const effective = usable.filter(o => (spec.effectiveTexts ?? [spec.finalText]).includes(o.text));
        const finals = usable.filter(o => o.text === spec.finalText);
        if (spec.silent)
            silenceBreaches += replies.length;
        else {
            completed += Number(finals.length > 0);
            missed += Number(!finals.length);
            duplicates += Math.max(0, finals.length - 1);
        }
        unexpectedReplies += routed.filter(o => !(spec.effectiveTexts ?? [spec.finalText]).includes(o.text)).length;
        if (e.admittedAt !== undefined) {
            values.admission.push(e.admittedAt - e.createdAt);
            if (['user', 'answer'].includes(e.kind))
                values.userAdmission.push(e.admittedAt - e.createdAt);
        }
        if (effective[0]) {
            values.firstEffectiveResponse.push(effective[0].createdAt - e.createdAt);
            if (['user', 'answer'].includes(e.kind))
                values.userFirstEffectiveResponse.push(effective[0].createdAt - e.createdAt);
            if (e.admittedAt !== undefined)
                values.admissionToEffectiveResponse.push(effective[0].createdAt - e.admittedAt);
        }
        if (finals[0]?.deliveredAt !== undefined)
            values.completion.push(finals[0].deliveredAt - e.createdAt);
        return {
            inboxId: e.id, silent: !!spec.silent, completed: spec.silent ? !replies.length : !!finals.length, admittedAt: e.admittedAt ?? null, firstEffectiveAt: effective[0]?.createdAt ?? null, deliveredAt: finals[0]?.deliveredAt ?? null
        };
    });
    for (const o of outbox)
        if (o.state === 'delivered' && o.deliveredAt !== undefined)
            values.delivery.push(o.deliveredAt - o.createdAt);
    for (const j of jobs) {
        if (j.completedAt !== undefined)
            values.jobExecution.push(j.completedAt - j.createdAt);
        const event = inbox.find(e => e.kind === 'job' && e.from === `job:${j.id}`);
        if (j.completedAt !== undefined && event?.consumedAt !== undefined)
            values.resultConsumption.push(event.consumedAt - j.completedAt);
    }
    for (const f of fires)
        values.triggerLateness.push(f.firedAt - f.dueAt);
    const expectedTasks = expected.filter(e => !e.silent).length;
    const falsePositives = unexpectedReplies + wrongRecipients + duplicates + expiredReplies;
    return {
        completed, expectedTasks, missed, duplicates, wrongRecipients, silenceBreaches, unexpectedReplies, expiredReplies, usefulness: {
            recall: expectedTasks ? completed / expectedTasks : null, precision: completed + falsePositives ? completed / (completed + falsePositives) : null, falsePositives
        }, latencyMs: Object.fromEntries(Object.entries(values).map(([key, data]) => [key, distribution(data)])) as Record<keyof typeof values, ReturnType<typeof distribution>>, samples,
        notes: ['Only independently specified effective responses qualify; acknowledgements do not improve response speed.', 'Nearest-rank percentiles describe this sample, not an SLO or population estimate.', 'Missing timestamps and responses are excluded from latency samples and reported as missing; never filled with zero.']
    };
}
