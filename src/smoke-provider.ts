import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
export const SMOKE_PROVIDER = 'pi-evaluation-deepseek';
export const SMOKE_HOST = 'api.deepseek.com';
export const FLASH_MODELS = ['deepseek-v4-flash', 'deepseek-flash'] as const;
/** Fixed official endpoint; no user-selected credential-bearing proxy URL. */
export function configureSmokeProvider(models: ModelRuntime, modelId: string) {
    if (!(FLASH_MODELS as readonly string[]).includes(modelId))
        throw Error('Only reviewed official Flash models are supported');
    models.registerProvider(SMOKE_PROVIDER, {
        baseUrl: `https://${SMOKE_HOST}`, api: 'openai-completions', authHeader: true,
        models: [{
                id: modelId, name: modelId, reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 1024,
                cost: {
                    input: 0.30, output: 1.20, cacheRead: 0.30, cacheWrite: 0.30
                },
                // Current DeepSeek API defaults to thinking enabled. Explicitly
                // disable it to avoid incompatible reasoning replay and cap drift.
                samplingParams: {
                    thinking: {
                        type: 'disabled'
                    }
                },
                compat: {
                    supportsStore: false, supportsDeveloperRole: false
                }
            }]
    });
    const model = models.getModel(SMOKE_PROVIDER, modelId);
    if (!model)
        throw Error('Smoke model unavailable');
    return model;
}
