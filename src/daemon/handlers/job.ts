import type { PiBotDaemon } from '../core/daemon.ts';
import type { DaemonConnection } from '../core/connection.ts';
import { redactChannelText } from '../runtime/channel-messages.ts';
export async function jobHandler(d: PiBotDaemon, c: DaemonConnection, method: string, p: any): Promise<any> {
    const r = d.runtime, s = r.store;
    switch (method) {
        case 'job/list': return {
            jobs: d.snapshot().jobs.filter((j: any) => (!p.botId || j.botId === p.botId) && (!p.state || j.state === p.state) && (!p.threadId || s.recordContext('jobs', j)?.threadId === p.threadId))
        };
        case 'job/read': {
            const job: any = d.required('jobs', p.jobId);
            const page = r.jobResult(job.botId, job.id, p.offset ?? 0, p.limit ?? 4096);
            return {
                ...page, text: page.text ? redactChannelText(page.text) : page.text, error: page.error ? redactChannelText(page.error) : page.error
            };
        }
    }
}
