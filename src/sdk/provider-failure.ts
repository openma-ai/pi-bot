import type { ProviderFailure } from '../pi/provider-failure.ts';

// Decode only the versioned safe envelope, never display the provider's raw text.
const retries: Record<ProviderFailure['category'], ProviderFailure['retry']> = {
    authentication: 'after-authentication', permission: 'after-configuration', 'rate-limit': 'after-delay',
    quota: 'after-quota', model: 'after-configuration', request: 'after-configuration', network: 'after-connection',
    timeout: 'after-delay', service: 'after-delay', unknown: 'inspect',
};
const codes = new Set(['invalid_api_key', 'invalid_token', 'token_expired', 'authentication_error', 'permission_denied',
    'insufficient_permissions', 'access_denied', 'rate_limit_exceeded', 'rate_limit_error', 'insufficient_quota',
    'quota_exceeded', 'usage_limit_reached', 'subscription_sharing_usage_limit_exceeded', 'model_not_found',
    'model_not_available', 'unsupported_model', 'invalid_request_error', 'unsupported_parameter', 'server_error', 'overloaded_error']);
export function readProviderFailure(value: unknown): ProviderFailure | undefined {
    if (typeof value !== 'string' || value.length > 350) return undefined;
    const match = value.match(/^(?:ProviderFailureError: |Error: )?PiboProviderFailure\/v1 category=([a-z-]+) status=([45]\d{2}|-) code=([a-z_]+|-) retry=([a-z-]+) phase=(before-stream|response|stream)$/);
    if (!match || !Object.hasOwn(retries, match[1]) || (match[3] !== '-' && !codes.has(match[3]))) return undefined;
    const category = match[1] as ProviderFailure['category'];
    if (retries[category] !== match[4]) return undefined;
    return { category, ...(match[2] !== '-' ? { httpStatus: Number(match[2]) } : {}),
        ...(match[3] !== '-' ? { providerCode: match[3] as ProviderFailure['providerCode'] } : {}),
        retry: retries[category], phase: match[5] as ProviderFailure['phase'] };
}
