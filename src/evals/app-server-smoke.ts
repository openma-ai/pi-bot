import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { PiBotDaemon } from '../daemon/core/daemon.ts';
import { PiBotClient } from '../sdk/client.ts';
import { redactTraceValue } from '../pi/redact.ts';
if (!process.argv.includes('--real'))
    throw new Error('Explicit --real is required; this smoke makes billable native Pi requests.');
const option = (name: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
};
const peerOnly = process.argv.includes('--peers');
const workerOnly = process.argv.includes('--workers');
const dir = resolve(option('--data-dir') ?? 'work/app-server-smoke-' + Date.now() + (peerOnly ? '-peers' : ''));
if (existsSync(join(dir, 'runtime.db')))
    throw new Error('Use a fresh data directory; existing effects are never replayed.');
mkdirSync(dir, {
    recursive: true
});
const d = await PiBotDaemon.create({
    dataDir: dir, modelRound: {
        maxRequests: 32, durationMs: 3600000
    }
});
const client = await PiBotClient.connect({
    transport: {
        inProcess: d
    }
});
const report: any = {
    kind: 'real DeepSeek API via native Pi, durable inbox, native tools and send_message', model: d.live?.model, startedAt: Date.now(), cases: [], limits: {
        requests: 32, maxOutput: 16384, requestTimeoutMs: 600000, roundTimeoutMs: 3600000
    }, wire: {
        provider: 'deepseek', endpoint: 'https://api.deepseek.com', thinking: 'enabled', effort: 'high'
    }
};
let a: any, b: any, monitor: any;
const wait = async (check: () => any, ms = 180000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const result = check();
        if (result)
            return result;
        if (d.live?.budget && (d.live.budget.requests >= d.live.budget.maxRequests || Date.now() >= d.live.budget.expiresAt))
            throw Error('Evaluation request or time limit reached');
        await new Promise(r => setTimeout(r, 500));
    }
    throw Error('Acceptance deadline reached');
};
const settle = () => wait(() => !d.snapshot().activeTurns.length && !d.runtime.store.list<any>('jobs').some(j => j.state === 'running') && !d.runtime.store.list<any>('inbox').some(e => e.state === 'queued' || e.state === 'processing'));
const expected: {
    tag: string;
    botId: string;
    channelId?: string;
}[] = [];
const outputs = () => d.runtime.store.list<any>('outbox').filter(o => o.state === 'delivered');
const expect = async (tag: string, botId: string, channelId?: string) => {
    expected.push({
        tag, botId, channelId
    });
    const result = await wait(() => outputs().find(o => o.text.includes(tag) && o.botId === botId && o.route?.channelId === channelId));
    await settle();
    if (outputs().filter(o => o.text.includes(tag) && o.botId === botId).length !== 1)
        throw Error('Duplicate accepted output');
    return result;
};
try {
    if (!d.live || (d.live.configuration as any).setupRequired)
        throw Error('Native Pi not configured');
    if ((d.live.configuration as any).provider !== 'deepseek' || !['deepseek-v4-flash', 'deepseek-flash'].includes(d.live.model) || (d.live.configuration as any).thinkingLevel !== 'high')
        throw Error('This evaluation requires native official DeepSeek Flash with high thinking');
    a = (await client.bot.create({
        name: '真实验收 A'
    })).bot;
    b = (await client.bot.create({
        name: '真实验收 B'
    })).bot;
    if (!peerOnly && !workerOnly) {
        const schedule = (await client.routine.create({
            kind: 'schedule', botId: a.id, prompt: '真实定时验收。现在只使用 send_message 回复 REAL-SCHEDULE-20261014=OK，不需要其它动作或闲聊。以当前触发 inbox messageId 为 source_message_id。', key: 'schedule', at: Date.now() + 1500, timezone: 'Asia/Shanghai'
        })).routine;
        const scheduled = await expect('REAL-SCHEDULE-20261014=OK', a.id);
        report.cases.push({
            name: 'bot-owned schedule', passed: true, routineId: schedule.id, outputId: scheduled.id
        });
        const watch = join(dir, 'monitor-fixture.txt');
        writeFileSync(watch, 'before');
        monitor = (await client.routine.create({
            kind: 'monitor', botId: a.id, prompt: '真实监控验收。文件变化触发后，只使用 send_message 回复 REAL-MONITOR-20261014=CHANGED，不需要其它动作或闲聊。以当前触发 inbox messageId 为 source_message_id。', key: 'monitor', filePath: watch, intervalMs: 1000, deadline: Date.now() + 300000
        })).routine;
        const dry = await client.routine.dryRun({
            routineId: monitor.id
        });
        if (dry.decision !== 'silent')
            throw Error('Unexpected dry-run');
        const before = d.live.budget?.requests;
        await client.routine.enable({
            routineId: monitor.id
        });
        await wait(() => d.runtime.store.get<any>('monitors', monitor.id.slice(8))?.baseline !== undefined, 10000);
        if (d.live.budget?.requests !== before)
            throw Error('Silent monitor woke model');
        writeFileSync(watch, 'after change');
        const changed = await expect('REAL-MONITOR-20261014=CHANGED', a.id);
        await client.routine.cancel({
            routineId: monitor.id
        });
        report.cases.push({
            name: 'bot-owned monitor, silent baseline, changed wake', passed: true, routineId: monitor.id, outputId: changed.id, silentChecksUsedRequests: 0
        });
        const group = (await client.group.create({
            name: '真实 API 群聊验收', memberIds: [a.id, b.id]
        })).group;
        const receipt = await client.turn.start({
            botId: a.id, groupId: group.id, key: 'all', text: '@全体成员 真实群聊验收：真实验收 A 只使用 send_message 回复 REAL-GROUP-A=OK；真实验收 B 只使用 send_message 回复 REAL-GROUP-B=OK。每人只回复一次，不调用其它工具，不互相发消息。以本条各自 inbox messageId 为 source_message_id。'
        });
        const ga = await expect('REAL-GROUP-A=OK', a.id, group.id), gb = await expect('REAL-GROUP-B=OK', b.id, group.id);
        if (d.runtime.store.list<any>('inbox').filter(e => receipt.inputIds?.includes(e.id)).length !== 2)
            throw Error('Group delivery missing');
        report.cases.push({
            name: 'shared group and @all replies', passed: true, groupId: group.id, inputIds: receipt.inputIds, outputs: [ga.id, gb.id]
        });
    }
    if (workerOnly) {
        const receipt = await client.turn.start({
            botId: a.id, key: 'worker', text: '真实社区 subagent 验收：父 bot 只使用 subagent、job_result、send_message，禁止使用 codemode 或 start_job。必须只派发一次 subagent，key=real-worker-once。交给 worker 的任务是使用 bash 计算 31*17，写入当前目录 real-worker-20261014.json（JSON 对象 value=527），再用 read 工具读回核对并返回绝对路径。worker 只在自己的工作目录保存一份文件，绝不复制到父目录。父 bot 不自己执行文件任务，不轮询，等待完成通知后，只用 send_message 回复 REAL-WORKER-20261014=527 和文件绝对路径，不发确认闲聊。'
        });
        const result = await expect('REAL-WORKER-20261014=527', a.id);
        const jobs = d.runtime.store.list<any>('jobs').filter(j => j.tool === 'pi-coding-agent');
        if (jobs.length !== 1 || jobs[0].state !== 'completed' || d.runtime.store.list<any>('jobs').some(j => j.state === 'failed'))
            throw Error('Expected one completed community worker');
        const files = (root: string): string[] => readdirSync(root, {
            withFileTypes: true
        }).flatMap(e => e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)]);
        const artifact = files(join(dir, 'sessions', a.id)).find(f => f.includes('/workers/') && f.endsWith('/real-worker-20261014.json'));
        if (!artifact || JSON.parse(readFileSync(artifact, 'utf8')).value !== 527)
            throw Error('Worker artifact failed independent oracle');
        const jobResult = JSON.parse(d.runtime.store.get<any>('jobs', jobs[0].id)!.result);
        if (jobResult?.engine !== 'pi-subagents@0.77.0')
            throw Error('Wrong worker engine');
        report.cases.push({
            name: 'community subagent native Pi artifact and parent send_message', passed: true, inputId: receipt.inputId, outputId: result.id, jobId: jobs[0].id, artifact, value: 527, worker: jobResult
        });
    }
    if (peerOnly) {
        const handoff = await client.turn.start({
            botId: a.id, key: 'handoff', text: `真实 bot2bot 交接验收：请直接调用原生 send_to_bot、send_message 和 bash 工具，禁止使用 codemode 或 subagent，避免额外执行任务。请用 send_to_bot 将下面的真实文件任务交给真实验收 B（${b.id}）。B 必须使用原生 bash 计算 20+53，在自己的当前工作目录写入 real-peer-20261014.txt，并读回核对，然后仅用 send_to_bot 将 73 和绝对路径返回给你（${a.id}）。你核验结果后，仅用 send_message 向用户回复 REAL-PEER-20261014=73 和该绝对路径。B 不直接向用户回复。不要确认、不要创建额外任务，等待时结束回合，不轮询。每个工具使用本任务的 source_message_id，保留原始任务和来源，已有 schedule/monitor/group 验收已完成，不重复。`
        });
        const peer = await expect('REAL-PEER-20261014=73', a.id);
        const files = (root: string): string[] => readdirSync(root, {
            withFileTypes: true
        }).flatMap(e => e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)]);
        const artifact = files(join(dir, 'sessions', b.id)).find(f => f.endsWith('/real-peer-20261014.txt'));
        if (!artifact || readFileSync(artifact, 'utf8').trim() !== '73')
            throw Error('Peer artifact failed independent oracle');
        const peerInputs = d.runtime.store.list<any>('inbox').filter(e => e.kind === 'bot' && e.taskId === d.runtime.store.get<any>('inbox', handoff.inputId)?.taskId);
        report.cases.push({
            name: 'bot2bot actual bash artifact and coordinator send_message', passed: true, inputId: handoff.inputId, outputId: peer.id, artifact, artifactValue: 73, peerInputIds: peerInputs.map(e => e.id)
        });
    }
}
catch (error) {
    report.failure = error instanceof Error ? error.message : 'Acceptance failed';
    process.exitCode = 1;
}
finally {
    if (monitor)
        await client.routine.cancel({
            routineId: monitor.id
        }).catch(() => {
        });
    await settle().catch(() => {
        report.incompleteUsage = true;
    });
    report.finishedAt = Date.now();
    report.budget = d.live?.budget;
    report.usage = d.snapshot().usage;
    report.requestUsageComplete = !report.incompleteUsage;
    const delivered = outputs();
    const matched = expected.map(target => ({
        target, rows: delivered.filter(o => o.text.includes(target.tag))
    }));
    const duplicates = matched.reduce((n, x) => n + Math.max(0, x.rows.length - 1), 0);
    const wrongGroup = matched.reduce((n, x) => n + x.rows.filter(o => o.botId !== x.target.botId || o.route?.channelId !== x.target.channelId).length, 0);
    const unexpectedReplies = delivered.filter(o => !expected.some(t => o.text.includes(t.tag))).length;
    report.acceptance = {
        passed: report.cases.length, total: peerOnly || workerOnly ? 1 : 3, completedActions: matched.filter(x => x.rows.some(o => o.botId === x.target.botId && o.route?.channelId === x.target.channelId)).length, expectedActions: peerOnly || workerOnly ? 1 : 4, duplicates, wrongGroup, unexpectedReplies
    };
    report.acceptance.omissions = Math.max(0, report.acceptance.expectedActions - report.acceptance.completedActions);
    if (duplicates || wrongGroup || unexpectedReplies) {
        report.failure = 'Delivery oracle rejected duplicate, wrong-scope or unexpected output';
        process.exitCode = 1;
    }
    report.trace = redactTraceValue({
        inbox: d.runtime.store.list('inbox'), outbox: d.runtime.store.list('outbox'), jobs: d.runtime.store.list('jobs'), items: d.snapshot().items, turns: d.snapshot().turns, events: d.log.read(0)
    });
    report.errors = d.runtime.errors.map(() => 'Runtime error; inspect sanitized turn and tool records');
    if (report.errors.length && !report.failure) {
        report.failure = 'Runtime error after delivery; inspect bounded request guards';
        process.exitCode = 1;
    }
    for (const [index, turn] of report.trace.turns.entries())
        if (turn.usage)
            turn.usage.reasoning = d.snapshot().turns[index]?.usage?.reasoning ?? 0;
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
        mode: 0o600
    });
    console.log(JSON.stringify({
        cases: report.cases, failure: report.failure, acceptance: report.acceptance, report: join(dir, 'report.json')
    }));
    client.close();
    await d.close(30000);
}
