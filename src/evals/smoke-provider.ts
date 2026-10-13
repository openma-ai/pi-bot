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
                id: modelId, name: modelId, reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 16384,
                cost: {
                    input: 0.30, output: 1.20, cacheRead: 0.30, cacheWrite: 0.30
                },
                // Explicit thinking mode, high effort and intact reasoning replay.
                // max_tokens caps reasoning plus final response together.
                samplingParams: {
                    thinking: {
                        type: 'enabled'
                    }, reasoning_effort: 'high'
                },
                compat: {
                    supportsStore: false, supportsDeveloperRole: false, thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true, maxTokensField: 'max_tokens'
                }
            }]
    });
    const model = models.getModel(SMOKE_PROVIDER, modelId);
    if (!model)
        throw Error('Smoke model unavailable');
    return model;
}
