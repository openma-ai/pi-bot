import { resolve, join } from 'node:path';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadPiConfiguration } from '../pi/config.ts';
import { PiBotDaemon } from '../daemon/core/daemon.ts';
import { PiBotClient } from '../sdk/client.ts';
import { redactTraceValue } from '../pi/redact.ts';
const plan = {
    kind: 'two-bot engineering project with native community coding workers', bots: 2, oracleTests: 26, paidRequests: 0, features: ['SQLite migration', 'dependency state machine', 'atomic transactions', 'idempotent events', 'CLI', 'CSV export', 'multi-connection persistence']
};
if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(plan));
    process.exit(0);
}
if (!process.argv.includes('--real'))
    throw Error('Explicit --real required');
const index = process.argv.indexOf('--data-dir');
const dir = resolve(index < 0 ? 'work/complex-repo-' + Date.now() : process.argv[index + 1]);
if (existsSync(dir))
    throw Error('Use a fresh directory; never replay prior effects');
mkdirSync(dir, {
    recursive: true
});
const repo = join(dir, 'project');
cpSync(resolve('fixtures/workqueue-repo'), repo, {
    recursive: true
});
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const contract = join(repo, 'tests/test_contract.py'), originalHash = hash(contract);
const executeOracle = () => {
    const r = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
        cwd: repo, timeout: 120000, maxBuffer: 300000, encoding: 'utf8'
    });
    return {
        passed: r.status === 0 && /Ran 26 tests/.test(r.stderr) && /\bOK\b/.test(r.stderr), status: r.status, output: redactTraceValue(r.stderr), testsUnchanged: hash(contract) === originalHash
    };
};
const baseline = executeOracle();
if (baseline.passed || !/NotImplementedError/.test(baseline.output))
    throw Error('Starter oracle must fail because the implementation is missing');
const d = await PiBotDaemon.create({
    dataDir: dir, modelRound: {
        maxRequests: 64, durationMs: 3600000
    }
});
const client = await PiBotClient.connect({
    transport: {
        inProcess: d
    }
});
const report: any = {
    kind: plan.kind, repo, startedAt: Date.now(), baseline, limits: {
        requests: 64, requestTimeoutMs: 600000, roundTimeoutMs: 3600000
    }, model: d.live?.model
};
const wait = async (check: () => any, ms = 600000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const value = check();
        if (value)
            return value;
        if (d.runtime.errors.length || d.live?.budget && d.live.budget.requests >= d.live.budget.maxRequests)
            throw Error('Runtime or bounded request guard stopped the engineering task');
        await new Promise(r => setTimeout(r, 500));
    }
    throw Error('Engineering acceptance deadline reached');
};
try {
    const native = await loadPiConfiguration();
    if (new URL(native.model.baseUrl).origin !== 'https://api.deepseek.com')
        throw Error('Official DeepSeek endpoint required');
    if (!d.live || (d.live.configuration as any).setupRequired || d.live.model !== 'deepseek-v4-flash' || (d.live.configuration as any).provider !== 'deepseek' || (d.live.configuration as any).thinkingLevel !== 'high')
        throw Error('Native Pi DeepSeek Flash required');
    const a = (await client.bot.create({
        name: '工程协调与存储', description: 'Own storage module and coordinate one final user delivery. Ignore chatter; delegate coding through subagent.'
    })).bot;
    const b = (await client.bot.create({
        name: 'CLI 与集成', description: 'Own CLI and README, run integration checks, send result to the coordinator, never directly reply to user.'
    })).bot;
    const input = await client.turn.start({
        botId: a.id, key: 'workqueue', text: `复杂真实工程任务：完成共享小仓库 ${repo} 的 WorkQueue。先读取 README.md 和 tests/test_contract.py 的完整契约。只允许修改该仓库的 workqueue/store.py、workqueue/cli.py、README.md；不得修改 tests、其它项目或读取凭据，不使用网络。所有编码重活必须交给原生社区 subagent；用稳定 key 防重复，结束回合等待完成通知，再读 job_result。你 A 负责通过一个 subagent 实现 store.py：SQLite v1→v2 保留数据迁移、依赖/状态机、原子 complete_many、幂等事件、多连接读取、校验和失败回滚，并运行前 20 项存储测试。可以并行立即用 send_to_bot 将 CLI 与 README 的工程阶段交给 B（${b.id}），B 通过自己的 subagent 实现 CLI 6 项测试和使用文档，允许读取仓库全部契约，只写 cli.py 和 README.md，最终用 send_to_bot 返回给你（${a.id}），B 不直接回复用户。两阶段整合后，你必须用原生 bash 在 ${repo} 运行 python3 -m unittest discover -s tests -v，26/26 真正通过后仅通过 send_message 向用户回复 COMPLEX-WORKQUEUE=PASS 和项目绝对路径。失败必须读取错误并修正（最多一次修正阶段），不能声称通过。父 bot 不自己编码、不用 codemode 或 start_job、不轮询、不发确认/闲聊。所有工具保留各自明确的 source_message_id，来源使用原始工程任务，后续闲聊不是工程任务来源。原始用户交付契约：只有 A 发最终用户结果，B 只对 A 报告。`
    });
    report.input = input;
    report.botIds = [a.id, b.id];
    await wait(() => d.runtime.store.list<any>('jobs').find(j => j.tool === 'pi-coding-agent' && j.state === 'running'));
    for (let i = 0; i < 12; i++)
        await client.turn.start({
            botId: a.id, key: 'chatter-' + i, text: `工程执行期间的群聊式闲聊 ${i}：没有新任务，不需要回复；仍有效的工程承诺继续。`
        });
    const result = await wait(() => d.runtime.store.list<any>('outbox').find(o => o.botId === a.id && o.state === 'delivered' && o.text.includes('COMPLEX-WORKQUEUE=PASS')));
    await wait(() => !d.snapshot().activeTurns.length && !d.runtime.store.list<any>('jobs').some(j => j.state === 'running') && d.runtime.store.list<any>('inbox').every(e => e.state === 'processed'));
    report.oracle = executeOracle();
    const outputs = d.runtime.store.list<any>('outbox');
    const workers = d.runtime.store.list<any>('jobs').filter(j => j.tool === 'pi-coding-agent');
    report.acceptance = {
        outputs: outputs.length, peerMessages: d.runtime.store.list<any>('inbox').filter(e => e.kind === 'bot').length, workers: workers.map(j => ({
            botId: j.botId, state: j.state
        })), pending: d.runtime.store.list<any>('inbox').filter(e => e.state !== 'processed').length, errors: d.runtime.errors.length, resultId: result.id
    };
    report.pass = report.oracle.passed && report.oracle.testsUnchanged && outputs.length === 1 && outputs[0].botId === a.id && outputs[0].taskId === d.runtime.store.get<any>('inbox', input.inputId)!.taskId && workers.some(j => j.botId === a.id && j.state === 'completed') && workers.some(j => j.botId === b.id && j.state === 'completed') && report.acceptance.peerMessages >= 2 && report.acceptance.pending === 0 && report.acceptance.errors === 0;
}
catch (error) {
    report.failure = error instanceof Error ? error.message : 'Engineering acceptance failed';
    report.pass = false;
}
finally {
    report.finishedAt = Date.now();
    report.requests = d.live?.budget?.requests;
    report.trace = redactTraceValue({
        inbox: d.runtime.store.list('inbox'), outbox: d.runtime.store.list('outbox'), jobs: d.runtime.store.list('jobs'), events: d.log.read(0)
    });
    if (existsSync(join(dir, 'tools.jsonl')))
        report.tools = readFileSync(join(dir, 'tools.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    writeFileSync(join(dir, 'report.json'), JSON.stringify(redactTraceValue(report), null, 2) + '\n', {
        mode: 0o600
    });
    console.log(JSON.stringify({
        pass: report.pass, failure: report.failure, acceptance: report.acceptance, report: join(dir, 'report.json')
    }));
    client.close();
    await d.close(30000);
    if (!report.pass)
        process.exitCode = 1;
}
