/** Observational SSE accounting. Never stores provider payload text or errors. */
export interface ProviderUsageRecord {
    requestId: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens: number;
    prompt_cache_miss_tokens: number;
    reasoning_tokens: number;
}
export function observeProviderSseLine(line: string, request: {
    id: number;
    finishedAt?: number;
}, usageRecords: ProviderUsageRecord[], at = Date.now()): void {
    if (!line.startsWith('data: '))
        return;
    try {
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
            request.finishedAt ??= at;
            return;
        }
        const packet = JSON.parse(data);
        if (packet.choices?.some((choice: any) => choice.finish_reason))
            request.finishedAt ??= at;
        if (!packet.usage)
            return;
        request.finishedAt ??= at;
        const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
        const usage = packet.usage;
        const usageRecord = {
            requestId: request.id, prompt_tokens: number(usage.prompt_tokens), completion_tokens: number(usage.completion_tokens), total_tokens: number(usage.total_tokens), prompt_cache_hit_tokens: number(usage.prompt_cache_hit_tokens), prompt_cache_miss_tokens: number(usage.prompt_cache_miss_tokens), reasoning_tokens: number(usage.completion_tokens_details?.reasoning_tokens)
        };
        const existing = usageRecords.findIndex(u => u.requestId === request.id);
        if (existing >= 0)
            usageRecords[existing] = usageRecord;
        else
            usageRecords.push(usageRecord);
    }
    catch { /* Telemetry cannot alter inference or expose an error payload. */
    }
}
