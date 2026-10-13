import { join } from 'node:path';
import { ModelRuntime, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { piSessionFactory } from './pi.ts';
import { configureSmokeProvider, SMOKE_PROVIDER } from './smoke-provider.ts';
import { readLocalDshDeepSeekKey } from './local-evaluation-auth.ts';
import { estimateContextTokens } from './context.ts';
import type { ProactiveService } from './proactive.ts';
import type { BotRuntime } from './runtime.ts';
import { redactTraceValue } from './evaluation-trace.ts';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
export async function guiPiFactory(dir: string, proactive: (host: BotRuntime) => ProactiveService) {
    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
    });
    const model = configureSmokeProvider(models, 'deepseek-v4-flash');
    let secret = process.env.DEEPSEEK_API_KEY ?? await readLocalDshDeepSeekKey();
    try {
        await models.setRuntimeApiKey(SMOKE_PROVIDER, secret);
    }
    finally {
        secret = '';
    }
    const budgetFile = join(dir, 'gui-budget.json');
    const fresh = {
        requests: 0, inputReserved: 0, maxRequests: 32, maxInput: 384000, expiresAt: Date.now() + 3600000
    };
    const budget = existsSync(budgetFile) && process.env.PI_BOT_NEW_ROUND !== '1' ? JSON.parse(readFileSync(budgetFile, 'utf8')) as typeof fresh : fresh;
    if (!Number.isSafeInteger(budget.requests) || !Number.isSafeInteger(budget.inputReserved) || !Number.isSafeInteger(budget.expiresAt) || budget.requests < 0 || budget.requests > 32 || budget.inputReserved < 0 || budget.inputReserved > 384000)
        throw Error('Invalid persisted GUI budget');
    budget.maxRequests = 32;
    budget.maxInput = 384000;
    const saveBudget = () => writeFileSync(budgetFile, JSON.stringify(budget), {
        mode: 0o600
    });
    saveBudget();
    const lifetime = AbortSignal.timeout(Math.max(1, budget.expiresAt - Date.now()));
    const trace: ExtensionFactory = pi => {
        const save = (type: string, event: unknown) => appendFileSync(join(dir, 'tools.jsonl'), JSON.stringify(redactTraceValue({
            at: Date.now(), type, event
        })) + '\n', {
            mode: 0o600
        });
        pi.on('tool_call', event => save('tool_call', event));
        pi.on('tool_result', event => save('tool_result', event));
    };
    const factory = piSessionFactory({
        dir: join(dir, 'sessions'), modelRuntime: models, model, proactive, context: {
            backgroundEnabled: false
        }, backgroundTools: {}, extensions: [trace], thinkingLevel: 'high', maxOutputTokens: 16384, maxRequestsPerWake: 16, inferenceRequestTimeoutMs: 600000, inferenceSignal: lifetime,
        beforeProviderRequest(context) {
            const c = context as {
                messages: Parameters<typeof estimateContextTokens>[0];
                systemPrompt?: string;
            };
            const tokens = estimateContextTokens(c.messages) + Buffer.byteLength(c.systemPrompt ?? '');
            if (Date.now() >= budget.expiresAt || budget.requests >= 32 || budget.inputReserved + tokens > 384000)
                throw Error('GUI bounded model budget exhausted');
            budget.requests++;
            budget.inputReserved += tokens;
            saveBudget();
        }
    });
    return {
        factory, budget, model: model.id, dispose: () => models.removeRuntimeApiKey(SMOKE_PROVIDER)
    };
}
