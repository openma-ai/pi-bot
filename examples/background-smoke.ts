/** Native Pi/QuickJS/tool/inbox smoke. --real enables the authorized official API. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { ModelRuntime, SessionManager, type ToolDefinition, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { BotRuntime } from '../src/runtime.ts';
import { piSessionFactory } from '../src/pi.ts';
import { RequestBudget, SMOKE_CAP } from '../src/evaluation.ts';
import { configureSmokeProvider, SMOKE_PROVIDER } from '../src/smoke-provider.ts';
import { readLocalDshDeepSeekKey } from '../src/local-evaluation-auth.ts';
import { redactTraceValue } from '../src/evaluation-trace.ts';
import type { Bot, Envelope, Job, Outbound } from '../src/store.ts';
const argv = process.argv.slice(2);
if (argv.some(a => a !== '--real'))
    throw Error('Only --real is supported');
const real = argv.includes('--real');
const dir = resolve('work/background-smoke', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
await mkdir(dir, {
    recursive: true, mode: 0o700
});
const statusPath = join(dir, 'report.status');
await writeFile(statusPath, JSON.stringify({
    state: 'running', pid: process.pid, mode: real ? 'real' : 'scripted'
}), {
    mode: 0o600
});
console.log(JSON.stringify({
    state: 'started', dir, mode: real ? 'real' : 'scripted', model: real ? 'deepseek-v4-flash' : 'faux', requestCap: 16
}));
const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
});
const faux = fauxProvider({
    provider: 'background-smoke-fixture', models: [{
            id: 'fixture', contextWindow: 128000, maxTokens: 16384
        }], tokensPerSecond: 1000000
});
const model = real ? configureSmokeProvider(models, 'deepseek-v4-flash') : faux.getModel();
const budget = new RequestBudget({
    ...SMOKE_CAP, requests: 16, deadlineMs: 600000
});
const lifetime = new AbortController();
const roundDeadline = setTimeout(() => lifetime.abort(), budget.limits.deadlineMs);
let timeouts = 0, gateExecutions = 0, echoExecutions = 0, source = '', quickSource = '';
let release!: () => void;
const held = new Promise<void>(r => {
    release = r;
});
const calls: unknown[] = [], results: unknown[] = [], boundaries: unknown[] = [];
let flood: Promise<void> | undefined;
const result = (text: string) => ({
    content: [{
            type: 'text' as const, text
        }], details: {}
});
const code = 'text("SCRIPT_BEGIN"); text(await tools.mcp__fixture__gate({})); text(await tools.mcp__fixture__echo({})); console.log("SCRIPT_END");';
const gate: ToolDefinition = {
    name: 'mcp__fixture__gate', label: 'Gate', description: 'Start the bounded fixture operation. Emits MCP_PROGRESS immediately; host releases it when the independent quick task finishes. Returns MCP_FINAL. Call once.', parameters: Type.Object({}),
    async execute(_id, _params, signal, update) {
        gateExecutions++;
        update?.(result('MCP_PROGRESS'));
        flood ??= (async () => {
            for (let i = 0; i < 8; i++)
                runtime.accept({
                    to: bot.id, from: 'bob', kind: 'user', taskId: `noise-${i}`, route: {
                        channelId: 'alpha', threadId: 'lounge', senderId: 'bob'
                    }, text: `Incidental chatter ${i}; no reply requested. Keep existing commitments.`, key: `noise-${i}`
                });
            quickSource = runtime.accept({
                to: bot.id, from: 'bob', kind: 'user', taskId: 'quick', route: quickRoute, text: 'Independent task B: while A remains running, collect its live observations with codemode_wait (yield_time_ms=1). After you can see MCP_PROGRESS, send exactly B_DONE once to this task using send_message and this inbox messageId. Then stop waiting; the host will finish A and enqueue its job completion. Never restart A or poll repeatedly.', key: 'quick'
            }).id;
        })();
        await new Promise<void>(resolve => {
            const abort = () => resolve();
            signal?.addEventListener('abort', abort, {
                once: true
            });
            if (signal?.aborted)
                resolve();
            held.then(() => {
                signal?.removeEventListener('abort', abort);
                resolve();
            });
        });
        return result('MCP_FINAL');
    }
};
const echo: ToolDefinition = {
    name: 'mcp__fixture__echo', label: 'Echo', description: 'Finish the fixture operation once; returns ECHO_FINAL.', parameters: Type.Object({}), async execute() {
        echoExecutions++;
        return result('ECHO_FINAL');
    }
};
const observer: ExtensionFactory = pi => {
    if (!real)
        pi.registerProvider(faux.provider);
    pi.on('tool_call', e => {
        calls.push(redactTraceValue({
            id: e.toolCallId, parentId: e.parentToolCallId, name: e.toolName, args: e.input
        }));
    });
    pi.on('tool_result', e => {
        results.push(redactTraceValue({
            id: e.toolCallId, parentId: e.parentToolCallId, name: e.toolName, isError: e.isError, content: e.content, details: e.details
        }));
    });
};
const runtime = new BotRuntime(join(dir, 'runtime.db'), piSessionFactory({
    dir: join(dir, 'sessions'), modelRuntime: models, model, tools: [gate, echo], allowTools: [gate.name, echo.name], extensions: [observer],
    backgroundTools: {
        directory: join(dir, 'executions'), additionalTools: [], yieldTimeMs: 10000, maxRuntimeMs: 300000
    },
    modelNativeTools: ['codemode', 'codemode_wait', 'codemode_read', 'send_message', 'job_result', 'runtime_state', 'context_history'],
    maxRequestsPerWake: 16, maxOutputTokens: 16384, thinkingLevel: real ? 'high' : undefined, inferenceRequestTimeoutMs: 600000,
    inferenceSignal: lifetime.signal, onInferenceTimeout: () => {
        timeouts++;
    },
    beforeProviderRequest(context, max) {
        budget.reserve(context, max);
        const visible = JSON.stringify(context);
        boundaries.push({
            request: budget.requests, seesProgress: visible.includes('MCP_PROGRESS'), seesFinal: visible.includes('ECHO_FINAL'), seesQuick: visible.includes(quickSource || 'unassigned')
        });
    }, context: {
        backgroundEnabled: false, maxContextTokens: 128000, outputReserveTokens: 16384
    }
}));
const bot = runtime.createBot('background-smoke', 'Complete the two fixture tasks, preserving their independent source and reply route.', 'alpha');
const longRoute = {
    channelId: 'alpha', threadId: 'long-work', senderId: 'alice'
};
const quickRoute = {
    channelId: 'alpha', threadId: 'quick-work', senderId: 'bob'
};
let observed = false;
faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall('codemode', {
        code, source_message_id: source
    }, {
        id: 'initial-code'
    }), {
        stopReason: 'toolUse'
    }),
    ...Array.from({
        length: 30
    }, () => (context: any) => {
        if (quickSource && !observed) {
            observed = true;
            const receipt = context.messages.find((m: any) => m.role === 'toolResult' && m.toolName === 'codemode');
            return fauxAssistantMessage(fauxToolCall('codemode_wait', {
                cell_id: receipt.details.cell_id, yield_time_ms: 1
            }, {
                id: 'observe'
            }), {
                stopReason: 'toolUse'
            });
        }
        if (observed && !runtime.store.list<Outbound>('outbox').some(o => o.text === 'B_DONE'))
            return fauxAssistantMessage(fauxToolCall('send_message', {
                text: 'B_DONE', key: 'quick-final', source_message_id: quickSource
            }, {
                id: 'quick-final'
            }), {
                stopReason: 'toolUse'
            });
        if (runtime.store.list<Job>('jobs').some(j => j.state === 'completed') && !runtime.store.list<Outbound>('outbox').some(o => o.text === 'A_DONE'))
            return fauxAssistantMessage(fauxToolCall('send_message', {
                text: 'A_DONE', key: 'long-final', source_message_id: source
            }, {
                id: 'long-final'
            }), {
                stopReason: 'toolUse'
            });
        return fauxAssistantMessage('internal');
    })
]);
const releaseMonitor = setInterval(() => {
    if (runtime.store.list<Outbound>('outbox').some(o => o.text === 'B_DONE') || lifetime.signal.aborted || runtime.errors.length)
        release();
}, 50);
let report: Record<string, unknown>;
try {
    if (real) {
        let secret = await readLocalDshDeepSeekKey();
        try {
            await models.setRuntimeApiKey(SMOKE_PROVIDER, secret);
        }
        finally {
            secret = '';
        }
    }
    source = runtime.accept({
        to: bot.id, from: 'alice', kind: 'user', taskId: 'long', route: longRoute, key: 'long', text: `Task A: run this exact codemode script once with source_message_id=this inbox messageId: ${code}\nWhen it yields, preserve its cell ID and stop waiting. Other input will arrive. After its durable job completion, retrieve the final result if needed; only after ECHO_FINAL send exactly A_DONE once to this task using send_message and the original source ID. Do not use start_job. Chatter needs no reply. Never rerun the script.`
    }).id;
    await runtime.idle();
    await runtime.deliver(async () => {
    });
    const inbox = runtime.store.list<Envelope>('inbox'), jobs = runtime.store.list<Job>('jobs'), outbox = runtime.store.list<Outbound>('outbox');
    const sessionFile = runtime.store.get<Bot>('bots', bot.id)?.sessionFile;
    const messages = sessionFile ? SessionManager.open(sessionFile).buildSessionProjection().messages : [];
    const usage = messages.filter(m => m.role === 'assistant').map(m => m.usage);
    const tokens = usage.reduce((sum, u) => ({
        input: sum.input + u.input, output: sum.output + u.output, cacheRead: sum.cacheRead + u.cacheRead, cacheWrite: sum.cacheWrite + u.cacheWrite, estimatedUsd: sum.estimatedUsd + u.cost.total
    }), {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimatedUsd: 0
    });
    const cells: unknown[] = [];
    for (const sessionDir of await readdir(join(dir, 'executions'))) {
        if (sessionDir === 'artifacts')
            continue;
        for (const file of await readdir(join(dir, 'executions', sessionDir)))
            if (file.endsWith('.json'))
                cells.push(JSON.parse(await readFile(join(dir, 'executions', sessionDir, file), 'utf8')));
    }
    const valid = (text: string, route: unknown) => outbox.filter(o => o.text === text && JSON.stringify(o.route) === JSON.stringify(route)).length;
    const completedTasks = Number(valid('A_DONE', longRoute) === 1) + Number(valid('B_DONE', quickRoute) === 1);
    const wrongRoute = outbox.filter(o => o.text === 'A_DONE' ? JSON.stringify(o.route) !== JSON.stringify(longRoute) : o.text === 'B_DONE' ? JSON.stringify(o.route) !== JSON.stringify(quickRoute) : false).length;
    const score = {
        completedTasks, expectedTasks: 2, missingTasks: 2 - completedTasks, duplicates: Math.max(0, gateExecutions - 1) + Math.max(0, echoExecutions - 1) + Math.max(0, outbox.filter(o => o.text === 'A_DONE').length - 1) + Math.max(0, outbox.filter(o => o.text === 'B_DONE').length - 1), wrongRoute, chatterReplies: outbox.filter(o => !['A_DONE', 'B_DONE'].includes(o.text)).length, errors: runtime.errors.length, timeouts, gateExecutions, echoExecutions, liveObservation: results.some(r => (r as any).name === 'codemode_wait' && (r as any).details?.observations?.some((e: any) => e.type === 'tool_update' && e.name === gate.name && e.update.content.some((p: any) => p.type === 'text' && p.text === 'MCP_PROGRESS')))
    };
    report = {
        mode: real ? 'real-api' : 'scripted-native-runtime', model: model.id, thinking: real ? {
            enabled: true, effort: 'high'
        } : null, backgroundSummary: false, pass: completedTasks === 2 && score.duplicates === 0 && wrongRoute === 0 && score.chatterReplies === 0 && score.errors === 0 && timeouts === 0 && score.liveObservation && echoExecutions === 1, score, requestGuard: {
            requests: budget.requests, inputReserved: budget.inputReserved, outputReserved: budget.outputReserved, refused: budget.refused, requestCap: 16, inputCap: 384000, requestTimeoutMs: 600000, roundDeadlineMs: 600000
        }, usage: {
            ...tokens, reportedResponses: usage.length, costBasis: 'SDK estimate using configured reviewed peak rates; not a provider invoice'
        }, evidence: redactTraceValue({
            inbox, jobs, outbox, calls, results, boundaries, cells
        })
    };
}
catch {
    report = {
        mode: real ? 'real-api' : 'scripted-native-runtime', pass: false, state: 'failed', error: 'Bounded smoke did not complete; inspect sanitized traces and request guard.', requestGuard: {
            requests: budget.requests, refused: budget.refused
        }, evidence: redactTraceValue({
            calls, results, boundaries
        })
    };
}
finally {
    clearInterval(releaseMonitor);
    clearTimeout(roundDeadline);
    lifetime.abort();
    release();
    await runtime.close();
    await models.removeRuntimeApiKey(SMOKE_PROVIDER).catch(() => {
    });
}
await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600
});
await writeFile(statusPath, JSON.stringify({
    state: 'completed', pass: report.pass
}), {
    mode: 0o600
});
console.log(JSON.stringify({
    report: join(dir, 'report.json'), pass: report.pass, score: report.score, requestGuard: report.requestGuard, usage: report.usage
}));
if (!report.pass)
    process.exitCode = 1;
