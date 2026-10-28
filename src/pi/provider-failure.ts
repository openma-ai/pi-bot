/** A bounded allowlist, not a redacted copy of a provider response. */
export const providerCodes = {
    invalid_api_key: 'authentication', invalid_token: 'authentication', token_expired: 'authentication', authentication_error: 'authentication',
    permission_denied: 'permission', insufficient_permissions: 'permission', access_denied: 'permission',
    rate_limit_exceeded: 'rate-limit', rate_limit_error: 'rate-limit',
    insufficient_quota: 'quota', quota_exceeded: 'quota', usage_limit_reached: 'quota', subscription_sharing_usage_limit_exceeded: 'quota',
    model_not_found: 'model', model_not_available: 'model', unsupported_model: 'model',
    invalid_request_error: 'request', unsupported_parameter: 'request',
    server_error: 'service', overloaded_error: 'service',
} as const;
export type ProviderFailureCategory = typeof providerCodes[keyof typeof providerCodes] | 'network' | 'timeout' | 'unknown';
export type ProviderFailure = {
    category: ProviderFailureCategory;
    httpStatus?: number;
    providerCode?: keyof typeof providerCodes;
    retry: 'after-authentication' | 'after-configuration' | 'after-delay' | 'after-quota' | 'after-connection' | 'inspect';
    phase: 'before-stream' | 'response' | 'stream';
};
const policies: Record<ProviderFailureCategory, { retry: ProviderFailure['retry']; message: string }> = {
    authentication: { retry: 'after-authentication', message: '模型服务未接受当前认证，请在模型设置中检查连接。' },
    permission: { retry: 'after-configuration', message: '当前连接没有此请求所需的权限，请检查账号或模型配置。' },
    'rate-limit': { retry: 'after-delay', message: '模型服务限制了请求频率，请稍后检查任务状态。' },
    quota: { retry: 'after-quota', message: '模型服务报告用量或额度限制，请检查账号用量。' },
    model: { retry: 'after-configuration', message: '模型服务未接受所选型号，请重新检查可用模型。' },
    request: { retry: 'after-configuration', message: '模型服务未接受请求参数，请检查模型与运行环境配置。' },
    network: { retry: 'after-connection', message: '无法完成与模型服务的网络通信，请检查连接。' },
    timeout: { retry: 'after-delay', message: '模型服务请求超时，请先查看任务记录再决定是否重试。' },
    service: { retry: 'after-delay', message: '模型服务暂时不可用，请稍后检查任务状态。' },
    unknown: { retry: 'inspect', message: '模型请求失败，未获得可安全展示的具体原因，请查看任务详情。' },
};

// Never call getters, stringify objects, walk request bodies, or keep raw causes.
function field(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function status(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}
function code(value: unknown): ProviderFailure['providerCode'] {
    return typeof value === 'string' && Object.hasOwn(providerCodes, value) ? value as keyof typeof providerCodes : undefined;
}
export function classifyProviderFailure(error: unknown, phase: ProviderFailure['phase']): ProviderFailure {
    const nested = field(error, 'error');
    let httpStatus = status(field(error, 'status')) ?? status(field(error, 'statusCode'))
        ?? status(field(field(error, '$metadata'), 'httpStatusCode'));
    let providerCode = code(field(error, 'code')) ?? code(field(nested, 'code')) ?? code(field(nested, 'type'));
    const rawMessage = typeof error === 'string' ? error : field(error, 'message');
    const message = typeof rawMessage === 'string' ? rawMessage.slice(0, 16_384) : '';
    // Pi 1.2.0 formats OpenAI failures as "OpenAI API error (403): ...";
    // other SDKs use "403 ...". Never extract a status from URLs/body numbers.
    const prefix = message.match(/^(?:[A-Za-z][A-Za-z -]{0,60} \()?([45]\d{2})(?:\)|(?=[:\s]))/)
        ?? message.match(/^(?:HTTP|status(?: code)?)\s*[:=]?\s*([45]\d{2})\b/i);
    httpStatus ??= prefix ? status(Number(prefix[1])) : undefined;
    if (!providerCode) {
        // Only explicit SDK code/type fields qualify; all other text is discarded.
        for (const match of message.matchAll(/["'](?:code|type)["']\s*:\s*["']([a-z_]{1,64})["']/g)) {
            providerCode = code(match[1]);
            if (providerCode) break;
        }
    }
    const networkCode = field(error, 'code') ?? field(field(error, 'cause'), 'code');
    const networkText = typeof networkCode === 'string' ? networkCode : message;
    let category: ProviderFailureCategory;
    if (providerCode) category = providerCodes[providerCode];
    else if (httpStatus === 401) category = 'authentication';
    else if (httpStatus === 403) category = 'permission';
    else if (httpStatus === 429) category = 'rate-limit';
    else if (httpStatus === 408 || httpStatus === 504 || /^(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)$/.test(networkText) || /^(?:Request timed out|Request timeout|TimeoutError)\b/i.test(message)) category = 'timeout';
    else if (httpStatus && httpStatus >= 500) category = 'service';
    else if (httpStatus) category = 'request';
    else if (/^(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(networkText)
        || /^(?:fetch failed|Connection error|Network error|NetworkError)\b/i.test(message)) category = 'network';
    else category = 'unknown';
    return { category, ...(httpStatus ? { httpStatus } : {}), ...(providerCode ? { providerCode } : {}), retry: policies[category].retry, phase };
}
export class ProviderFailureError extends Error {
    readonly failure: ProviderFailure;
    constructor(error: unknown, phase: ProviderFailure['phase']) {
        const failure = classifyProviderFailure(error, phase);
        // Versioned, fixed-vocabulary wire text travels through existing inbox and
        // SDK errorMessage strings. No raw response, URL, model ID or account ID.
        super(`PiboProviderFailure/v1 category=${failure.category} status=${failure.httpStatus ?? '-'} code=${failure.providerCode ?? '-'} retry=${failure.retry} phase=${failure.phase}`);
        this.name = 'ProviderFailureError';
        this.failure = Object.freeze(failure);
    }
    get publicMessage() { return policies[this.failure.category].message; }
}
