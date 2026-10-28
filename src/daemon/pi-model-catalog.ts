import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { OpenAIAccountModels } from './openai-account-models.ts';

type Runtime = Pick<ModelRuntime, 'refresh' | 'getAvailable' | 'getProviders' | 'hasConfiguredAuth' | 'getError' | 'getAuth' | 'checkAuth' | 'isUsingOAuth' | 'getProvider'>;
export type CatalogStatus = 'cached' | 'refreshed' | 'partial' | 'failed';
export type CatalogMetadata = {
    source: 'pi-sdk' | 'openai-account' | 'mixed';
    status: CatalogStatus;
    /** Directory check completion time; never evidence of successful inference. */
    checkedAt: number;
    accountAccess: 'unverified' | 'confirmed';
    unsupportedModelCount?: number;
    unsupportedModelReason?: string;
    error?: string;
};
export type ProviderCatalogMetadata = Omit<CatalogMetadata, 'status'> & {
    status: CatalogStatus | 'unconfigured';
    authChecked: boolean;
};

const REFRESH_ERROR = '模型目录刷新未完成，显示 SDK 中已有的目录；尚未验证账号对各模型的访问权限。';
const AUTH_ERROR = '暂时无法确认模型认证配置，请重新加载。';

/** Pi supplies specifications and generic auth filters. ChatGPT OAuth choices
 * additionally require the selected account's SIWC catalog, never a name heuristic.
 */
export class PiModelCatalog {
    private pending?: ReturnType<PiModelCatalog['read']>;
    private account: OpenAIAccountModels;
    private epoch = 0;
    constructor(private runtime: Runtime, private options: {
        allowNetwork?: boolean;
        refreshTimeoutMs?: number;
        authTimeoutMs?: number;
        accountTimeoutMs?: number;
    } = {}) { this.account = new OpenAIAccountModels(runtime, options.accountTimeoutMs); }

    invalidate() { this.epoch++; this.account.invalidate(); this.pending = undefined; }

    refresh() {
        if (this.pending) return this.pending;
        const pending = this.read();
        this.pending = pending;
        void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
        return pending;
    }

    private async read() {
        const epoch = this.epoch;
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
        const providers = new Map<string, { configured: boolean; catalog: ProviderCatalogMetadata }>(this.runtime.getProviders().map(provider => {
            const configured = authChecked && this.runtime.hasConfiguredAuth(provider.id);
            const providerFailed = configured && (failed || errors.has(provider.id));
            const catalog: ProviderCatalogMetadata = {
                source: 'pi-sdk', accountAccess: 'unverified', checkedAt, authChecked,
                status: !authChecked ? 'failed' : !configured ? 'unconfigured' : providerFailed ? 'failed' : allowNetwork ? 'refreshed' : 'cached',
                ...(!authChecked ? { error: AUTH_ERROR } : providerFailed ? { error: REFRESH_ERROR } : {})
            };
            return [provider.id, { configured, catalog }] as const;
        }));
        if (this.runtime.isUsingOAuth('openai')) {
            const result = await this.account.read(models.filter(m => m.provider === 'openai'), allowNetwork && authChecked && epoch === this.epoch);
            models = [...models.filter(m => m.provider !== 'openai'), ...result.models];
            const provider = providers.get('openai');
            if (provider) provider.catalog = { ...result.catalog, authChecked };
        }
        // Login/logout invalidates every in-flight read, not only the account GET.
        if (epoch !== this.epoch) {
            models = [];
            for (const provider of providers.values()) {
                provider.configured = false;
                provider.catalog = { ...provider.catalog, status: 'failed', authChecked: false, accountAccess: 'unverified', error: AUTH_ERROR };
            }
        }
        let catalog: CatalogMetadata = {
            source: 'pi-sdk', accountAccess: 'unverified', checkedAt,
            status: !authChecked ? 'failed' : failed || errors.size ? 'partial' : allowNetwork ? 'refreshed' : 'cached',
            ...(!authChecked ? { error: AUTH_ERROR } : failed || errors.size ? { error: REFRESH_ERROR } : {})
        };
        const configured = [...providers.values()].filter(p => p.configured);
        if (configured.length === 1 && configured[0].catalog.source === 'openai-account') catalog = { ...configured[0].catalog, status: configured[0].catalog.status === 'unconfigured' ? 'cached' : configured[0].catalog.status };
        else if (configured.some(p => p.catalog.source === 'openai-account')) {
            catalog = { ...catalog, source: 'mixed', accountAccess: 'unverified',
                status: configured.some(p => ['failed', 'partial'].includes(p.catalog.status)) ? 'partial' : catalog.status };
        }
        if (epoch !== this.epoch) catalog = { ...catalog,
            source: providers.size === 1 ? [...providers.values()][0].catalog.source : catalog.source,
            status: 'failed', accountAccess: 'unverified', error: AUTH_ERROR };
        return { models, providers, catalog };
    }

    /** Recheck account choices at save time; never trust a previous UI catalog. */
    async canSelect(provider: string, id: string) {
        const epoch = this.epoch;
        try {
            const models = await bounded(this.options.authTimeoutMs ?? 2_000,
                signal => this.runtime.getAvailable(undefined, { signal }));
            if (provider === 'openai' && this.runtime.isUsingOAuth('openai')) {
                const result = await this.account.read(models.filter(m => m.provider === provider), this.options.allowNetwork ?? process.env.PI_OFFLINE === undefined);
                return epoch === this.epoch && result.models.some(model => model.id === id);
            }
            return epoch === this.epoch && models.some(model => model.provider === provider && model.id === id);
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
