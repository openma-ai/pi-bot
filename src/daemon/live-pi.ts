import { createSandboxHost } from '../pi/sandbox.ts';
import { ProviderRequestGuardError } from '../pi/host.ts';
import { DesktopClient } from '../pi/desktop-client.ts';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { getAgentDir, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { piSessionFactory } from '../pi/session-factory.ts';
import { loadPiConfiguration } from '../pi/config.ts';
import type { BotHost, ProactivePort, SessionFactory, CredentialPort } from '../pi/host.ts';
import { redactTraceValue } from '../pi/redact.ts';
import { appendFileSync, writeFileSync } from 'node:fs';
export async function livePiFactory(dir: string, proactive: (host: BotHost) => ProactivePort, credentials?: CredentialPort, piOptions: {
    agentDir?: string;
    cwd?: string;
} = {}, onBudget?: (budget: Record<string, number>) => void, modelRound?: {
    maxRequests: number;
    durationMs: number;
}, desktop = DesktopClient.load(resolve(process.env.PI_BOT_DESKTOP_CONTROL ?? 'work/gui/desktop/control.json'))) {
    let configuration;
    try {
        configuration = await loadPiConfiguration(piOptions);
    }
    catch {
        const factory: SessionFactory = async () => {
            throw Error('Pi 配置不可用，请在设置的「模型」中完成认证并选择模型');
        };
        return {
            factory, model: '未配置', configuration: {
                auth: 'Pi native', agentDir: piOptions.agentDir ?? getAgentDir(), setupRequired: true, message: '请在设置的「模型」中完成认证并选择模型'
            }, dispose: () => {
            }, budget: undefined
        };
    }
    const { models, model } = configuration;
    // Aggregate limits are opt-in for evaluators, never the normal GUI lifetime.
    if (modelRound && (!Number.isSafeInteger(modelRound.maxRequests) || modelRound.maxRequests < 1 || !Number.isSafeInteger(modelRound.durationMs) || modelRound.durationMs < 1))
        throw Error('Invalid model round limits');
    const budget = modelRound ? {
        requests: 0, maxRequests: modelRound.maxRequests, expiresAt: Date.now() + modelRound.durationMs
    } : undefined;
    const saveBudget = () => {
        if (budget)
            writeFileSync(join(dir, 'model-round.json'), JSON.stringify(budget), {
                mode: 0o600
            });
    };
    saveBudget();
    const lifetime = budget ? AbortSignal.timeout(Math.max(1, budget.expiresAt - Date.now())) : undefined;
    const trace: ExtensionFactory = pi => {
        const save = (type: string, event: unknown) => appendFileSync(join(dir, 'tools.jsonl'), JSON.stringify(redactTraceValue({
            at: Date.now(), type, event
        })) + '\n', {
            mode: 0o600
        });
        pi.on('tool_call', event => save('tool_call', event));
        pi.on('tool_result', event => save('tool_result', event));
    };
    const sandbox = createSandboxHost({
        cwd: piOptions.cwd ?? process.cwd(),
        onStatus: (message, level) => console.error(`[sandbox:${level}] ${message}`),
    });
    const factory = piSessionFactory({
        sandbox,
        credentials, desktop, codingWorkers: true, dir: join(dir, 'sessions'), modelRuntime: models, model, connectionBinding:configuration.connectionBinding, proactive, context: {
            backgroundEnabled: true, outputReserveTokens: 16384, summaryTimeoutMs: 600000
        }, backgroundTools: {}, extensions: [trace], thinkingLevel: configuration.thinkingLevel, maxOutputTokens: 16384, maxRequestsPerWake: 16, inferenceRequestTimeoutMs: 600000, inferenceSignal: lifetime,
        beforeProviderRequest: budget ? () => {
            if (Date.now() >= budget.expiresAt || budget.requests >= budget.maxRequests)
                throw new ProviderRequestGuardError('budgetExhausted', 'Evaluation request or time limit reached');
            budget.requests++;
            saveBudget();
            try {
                onBudget?.({
                    ...budget
                });
            }
            catch { /* Observer cannot break provider execution. */
            }
        } : undefined
    });
    return {
        factory, budget, model: model.id, configuration: configuration.public, dispose: async () => {
            await sandbox.dispose();
            configuration.dispose();
        }
    };
}
