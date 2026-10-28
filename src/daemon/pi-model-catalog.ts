import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

type Runtime = Pick<ModelRuntime, 'refresh' | 'getAvailable' | 'getProviders' | 'hasConfiguredAuth' | 'getError'>;
export type CatalogStatus = 'cached' | 'refreshed' | 'partial' | 'failed';
export type CatalogMetadata = {
    source: 'pi-sdk';
    status: CatalogStatus;
    /** Completion time of this SDK catalog/auth check, not an account entitlement check. */
    checkedAt: number;
    accountAccess: 'unverified';
    error?: string;
};
export type ProviderCatalogMetadata = Omit<CatalogMetadata, 'status'> & {
    status: Exclude<CatalogStatus, 'partial'> | 'unconfigured';
    authChecked: boolean;
};

const REFRESH_ERROR = '模型目录刷新未完成，显示 SDK 中已有的目录；尚未验证账号对各模型的访问权限。';
const AUTH_ERROR = '暂时无法确认模型认证配置，请重新加载。';

/** Match Pi's selector: refresh its catalogs, then use its authenticated chat snapshot.
 * No model-name rules or provider-specific entitlement claims belong in this adapter.
 */
export class PiModelCatalog {
    private pending?: ReturnType<PiModelCatalog['read']>;
    constructor(private runtime: Runtime, private options: {
        allowNetwork?: boolean;
        refreshTimeoutMs?: number;
        authTimeoutMs?: number;
    } = {}) {}

    refresh() {
        if (this.pending) return this.pending;
        const pending = this.read();
        this.pending = pending;
        void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
        return pending;
    }

    private async read() {
        const allowNetwork = this.options.allowNetwork ?? process.env.PI_OFFLINE === undefined;
        let failed = false;
        let errors: ReadonlyMap<string, Error> = new Map();
        try {
            const result = await bounded(this.options.refreshTimeoutMs ?? 15_000,
                signal => this.runtime.refresh({ allowNetwork, signal }));
            failed = result.aborted;
            errors = result.errors;
        } catch { failed = true; }

        // A network refresh can time out after restoring cache. Recheck auth using
        // a separate, short deadline; never trust a provisional/stale snapshot.
        let models: Awaited<ReturnType<Runtime['getAvailable']>> = [];
        let authChecked = false;
        try {
            models = await bounded(this.options.authTimeoutMs ?? 2_000,
                signal => this.runtime.getAvailable(undefined, { signal }));
            authChecked = true;
        } catch { /* No stale models become selectable after an auth-check failure. */ }
        // Pi's selector also reports composition/models.json errors, which are
        // independent of the per-provider network-refresh error map.
        failed ||= !!this.runtime.getError();

        const checkedAt = Date.now();
        const providers = new Map(this.runtime.getProviders().map(provider => {
            const configured = authChecked && this.runtime.hasConfiguredAuth(provider.id);
            const providerFailed = configured && (failed || errors.has(provider.id));
            const catalog: ProviderCatalogMetadata = {
                source: 'pi-sdk', accountAccess: 'unverified', checkedAt, authChecked,
                status: !authChecked ? 'failed' : !configured ? 'unconfigured' : providerFailed ? 'failed' : allowNetwork ? 'refreshed' : 'cached',
                ...(!authChecked ? { error: AUTH_ERROR } : providerFailed ? { error: REFRESH_ERROR } : {})
            };
            return [provider.id, { configured, catalog }] as const;
        }));
        const catalog: CatalogMetadata = {
            source: 'pi-sdk', accountAccess: 'unverified', checkedAt,
            status: !authChecked ? 'failed' : failed || errors.size ? 'partial' : allowNetwork ? 'refreshed' : 'cached',
            ...(!authChecked ? { error: AUTH_ERROR } : failed || errors.size ? { error: REFRESH_ERROR } : {})
        };
        return { models, providers, catalog };
    }

    /** Recheck the same SDK policy before accepting a saved choice, without any
     * catalog fetch, token refresh, model invocation, or credential mutation.
     */
    async canSelect(provider: string, id: string) {
        try {
            const models = await bounded(this.options.authTimeoutMs ?? 2_000,
                signal => this.runtime.getAvailable(provider, { signal }));
            return models.some(model => model.provider === provider && model.id === id);
        } catch { return false; }
    }
}

async function bounded<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Catalog operation timed out')); }, timeoutMs);
    });
    try { return await Promise.race([operation(controller.signal), timeout]); }
    finally { clearTimeout(timer!); }
}
