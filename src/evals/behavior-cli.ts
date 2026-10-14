import { observeProviderSseLine } from './provider-telemetry.ts';
import { createEvaluationDirectory } from './evaluation-directory.ts';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { loadPiConfiguration } from '../pi/config.ts';
import { readHidden } from '../daemon/hidden-entry.ts';
import { readLocalDshDeepSeekKey } from './local-evaluation-auth.ts';
import { configureSmokeProvider, FLASH_MODELS } from './smoke-provider.ts';
import { runEvaluation, scenarios, SMOKE_CAP, RequestBudget } from './evaluation.ts';
import { runTaskChainEvaluation } from './taskchain-evaluation.ts';
const flags = new Map<string, string>();
const switches = new Set<string>();
const valueFlags = ['--suite', '--model', '--auth-source', '--report', '--artifact-dir', '--scenario'];
let models: ModelRuntime | undefined, dir: string | undefined, status: string | undefined, ownsStatus = false;
const telemetry: {
    requests: {
        id: number;
        kind: string;
        startedAt: number;
        finishedAt?: number;
        abortedAt?: number;
        responseAt?: number;
        status?: number;
        thinking?: string;
        effort?: string;
        maxOutput: number;
    }[];
    httpRequests: number;
    statuses: number[];
    usage: {
        requestId: number;
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_cache_hit_tokens: number;
        prompt_cache_miss_tokens: number;
        reasoning_tokens: number;
    }[];
} = {
    requests: [], httpRequests: 0, statuses: [], usage: []
};
const originalFetch = globalThis.fetch;
let wireBudget = new RequestBudget(SMOKE_CAP, 'wire');
try {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]!;
        if (['--real', '--dry-run', '--trace', '--background-execution', '--background-summary', '--cancel-during-execution', '--natural-controls'].includes(flag)) {
            switches.add(flag);
            continue;
        }
        if (!valueFlags.includes(flag) || !argv[i + 1] || argv[i + 1]!.startsWith('--') || flags.has(flag))
            throw Error('Invalid arguments');
        flags.set(flag, argv[++i]!);
    }
    const suite = flags.get('--suite') ?? 'smoke';
    const modelId = flags.get('--model') ?? 'deepseek-v4-flash';
    const auth = flags.get('--auth-source') ?? 'tty';
    const backgroundExecution = switches.has('--background-execution');
    const backgroundSummary = switches.has('--background-summary');
    const cancelDuringExecution = switches.has('--cancel-during-execution');
    if (backgroundSummary && cancelDuringExecution)
        throw Error('Use separate bounded summary and cancellation rounds');
    if ((backgroundSummary || cancelDuringExecution) && !backgroundExecution)
        throw Error('Summary concurrency needs background execution');
    const { estimatedUsd: _legacyEstimate, approvedUsdNeeded: _legacyApproval, ...caps } = SMOKE_CAP;
    if (backgroundExecution && suite !== 'taskchain')
        throw Error('Background execution needs the real-work suite');
    const real = switches.has('--real');
    const dry = switches.has('--dry-run');
    const reportFile = flags.get('--report');
    const scenario = flags.get('--scenario');
    if (!['smoke', 'taskchain'].includes(suite) || !['tty', 'dsh', 'pi'].includes(auth) || !(FLASH_MODELS as readonly string[]).includes(modelId) || scenario && (suite !== 'smoke' || !scenarios.some(s => s.id === scenario)))
        throw Error('Unsupported evaluation configuration');
    const inputReservationEnabled = auth !== 'pi';
    wireBudget = new RequestBudget(SMOKE_CAP, 'wire', {
        reserveInput: inputReservationEnabled
    });
    const publicCaps = inputReservationEnabled ? caps : Object.fromEntries(Object.entries(caps).filter(([name]) => name !== 'inputTokenReservations'));
    if (dry) {
        console.log(JSON.stringify({
            mode: 'dry-run', suite, modelId, providerHostname: 'api.deepseek.com', authSource: auth, paidRequests: 0, caps: publicCaps, inputReservationEnabled, dollarBudgetUsd: null, backgroundExecution, thinking: {
                enabled: true, effort: 'high'
            }, backgroundSummary, trace: true
        }, null, 2));
    }
    else {
        if (reportFile) {
            if (await access(reportFile).then(() => true, () => false))
                throw Error('Existing report');
            status = reportFile.replace(/\.json$/, '') + '.status';
            await writeFile(status, JSON.stringify({
                state: 'running', pid: process.pid, suite, mode: real ? 'real' : 'scripted', started: new Date().toISOString()
            }), {
                flag: 'wx', mode: 0o600
            });
            ownsStatus = true;
        }
        if (real) {
            if (auth === 'pi') {
                const config = await loadPiConfiguration();
                if (config.model.provider !== 'deepseek' || config.model.id !== modelId || config.thinkingLevel !== 'high' || new URL(config.model.baseUrl).hostname !== 'api.deepseek.com')
                    throw Error('Native Pi must select official DeepSeek Flash with high thinking');
                models = config.models;
            }
            else {
                dir = await createEvaluationDirectory('pi-behavior-model-');
                models = await ModelRuntime.create({
                    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
                });
                configureSmokeProvider(models, modelId);
                let secret = auth === 'dsh' ? await readLocalDshDeepSeekKey() : await readHidden('DeepSeek API credential');
                try {
                    await models.setRuntimeApiKey('pi-evaluation-deepseek', secret);
                }
                finally {
                    secret = '';
                }
            }
            globalThis.fetch = async (...args) => {
                const text = typeof args[1]?.body === 'string' ? args[1].body : args[0] instanceof Request ? await args[0].clone().text() : undefined;
                if (!text)
                    throw Error('Provider request body unavailable for accounting');
                const parsed = JSON.parse(text);
                wireBudget.reserveWire(parsed);
                const id = ++telemetry.httpRequests;
                const record = {
                    id, kind: parsed.messages?.some((m: any) => ['system', 'developer'].includes(m.role) && typeof m.content === 'string' && m.content.startsWith('Summarize only the supplied stable conversation prefix')) ? 'summary' : 'foreground', startedAt: Date.now(), thinking: parsed.thinking?.type, effort: parsed.reasoning_effort, maxOutput: parsed.max_tokens ?? parsed.max_completion_tokens
                } as typeof telemetry.requests[number];
                telemetry.requests.push(record);
                const signal = args[1]?.signal ?? (args[0] instanceof Request ? args[0].signal : undefined);
                signal?.addEventListener('abort', () => {
                    if (!record.finishedAt)
                        record.abortedAt = Date.now();
                }, {
                    once: true
                });
                const response = await originalFetch(...args);
                record.responseAt = Date.now();
                record.status = response.status;
                telemetry.statuses.push(response.status);
                if (!response.body)
                    return response;
                let pending = '';
                const decoder = new TextDecoder();
                const body = response.body.pipeThrough(new TransformStream({
                    flush() {
                        record.finishedAt = Date.now();
                    },
                    transform(chunk, controller) {
                        pending += decoder.decode(chunk, {
                            stream: true
                        });
                        const lines = pending.split('\n');
                        pending = lines.pop()!;
                        for (const line of lines)
                            observeProviderSseLine(line, record, telemetry.usage);
                        controller.enqueue(chunk);
                    }
                }));
                return new Response(body, {
                    status: response.status, statusText: response.statusText, headers: response.headers
                });
            };
        }
        const options = {
            budget: real ? wireBudget : undefined, mode: real ? 'real' as const : 'scripted' as const, modelRuntime: models, model: models?.getModel(auth === 'pi' ? 'deepseek' : 'pi-evaluation-deepseek', modelId)
        };
        const report = suite === 'smoke' ? await runEvaluation({
            ...options, trace: true, hostControls: !switches.has('--natural-controls'), scenarioIds: scenario ? [scenario] : undefined
        }) : await runTaskChainEvaluation({
            ...options, backgroundExecution, backgroundSummary, cancelDuringExecution, outputDir: flags.get('--artifact-dir')
        });
        if (reportFile)
            await writeFile(reportFile, JSON.stringify({
                ...report, budget: {
                    ...report.budget, accounting: auth === 'pi' ? 'provider-request-count-only' : real ? 'provider-wire-json-plus-1024-per-request' : 'native-context-json-plus-1024-per-request'
                }, telemetry
            }, null, 2) + '\n', {
                flag: 'wx', mode: 0o600
            });
        if (status)
            await writeFile(status, JSON.stringify({
                state: 'completed', pass: report.pass, finished: new Date().toISOString(), requests: report.budget.requests
            }), {
                mode: 0o600
            });
        console.log(JSON.stringify({
            mode: report.mode, suite, pass: report.pass, budget: report.budget, report: reportFile ?? null
        }));
        if (!report.pass)
            process.exitCode = 1;
    }
}
catch {
    if (status && ownsStatus)
        await writeFile(status, JSON.stringify({
            state: 'failed', finished: new Date().toISOString(), telemetry
        }), {
            mode: 0o600
        });
    console.error('Behavior evaluation failed: verify configuration, fresh report/status paths and local authentication. Raw errors are withheld.');
    process.exitCode = 1;
}
finally {
    globalThis.fetch = originalFetch;
    if (models && flags.get('--auth-source') !== 'pi')
        await models.removeRuntimeApiKey('pi-evaluation-deepseek').catch(() => {
        });
    if (dir)
        await rm(dir, {
            recursive: true, force: true
        });
}
