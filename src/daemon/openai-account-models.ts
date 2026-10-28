import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';

const BASE = 'https://api.openai.com/v1';
const ENDPOINT = BASE + '/models';
const MAX_BYTES = 1024 * 1024;
type Runtime = Pick<ModelRuntime, 'getAuth' | 'checkAuth' | 'isUsingOAuth' | 'getProvider'>;
export type AccountModelResult = {
    models: readonly Model<Api>[];
    catalog: {
        source: 'openai-account';
        accountAccess: 'confirmed' | 'unverified';
        status: 'refreshed' | 'partial' | 'failed';
        checkedAt: number;
        authChecked: boolean;
        unsupportedModelCount?: number;
        unsupportedModelReason?: string;
        error?: string;
    };
};
const failure = (): AccountModelResult => ({ models: [], catalog: {
    source: 'openai-account', accountAccess: 'unverified', status: 'failed',
    checkedAt: Date.now(), authChecked: true,
    error: '无法确认当前 ChatGPT 账号的模型目录，请检查连接后重新加载。'
} });

/** SIWC account catalog, separate from Pi's public catalog/specifications.
 * https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 * No cross-request token/model cache. SDK alone resolves/refreshes credentials.
 */
export class OpenAIAccountModels {
    private epoch = 0;
    private active = new Set<AbortController>();
    constructor(private runtime: Runtime, private timeoutMs = 8_000) {}
    invalidate() {
        this.epoch++;
        for (const controller of this.active) controller.abort();
        this.active.clear();
    }
    async read(specifications: readonly Model<Api>[], allowNetwork: boolean): Promise<AccountModelResult> {
        if (!allowNetwork) return failure();
        const epoch = this.epoch, controller = new AbortController();
        this.active.add(controller);
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('Account catalog timed out')); }, this.timeoutMs);
        });
        try {
            return await Promise.race([this.fetch(specifications, controller.signal, epoch), timeout]);
        } catch { return failure(); }
        finally { clearTimeout(timer!); this.active.delete(controller); }
    }
    private async access(signal: AbortSignal) {
        signal.throwIfAborted();
        if (!this.runtime.isUsingOAuth('openai') ||
            (await this.runtime.checkAuth('openai', { signal }))?.type !== 'oauth' ||
            !officialBase(this.runtime.getProvider('openai')?.baseUrl)) throw new Error('Unsupported account route');
        const resolved = await this.runtime.getAuth('openai', { signal, minOAuthValidityMs: 0 });
        signal.throwIfAborted();
        // Never reuse a configured proxy's credentials, custom headers, or URL.
        if (resolved?.source !== 'OAuth' || !resolved.auth.apiKey || /[\r\n]/.test(resolved.auth.apiKey) ||
            (resolved.auth.baseUrl !== undefined && !officialBase(resolved.auth.baseUrl))) throw new Error('Unsupported account auth');
        return resolved.auth.apiKey;
    }
    private async fetch(specifications: readonly Model<Api>[], signal: AbortSignal, epoch: number): Promise<AccountModelResult> {
        const access = await this.access(signal);
        const response = await fetch(ENDPOINT, {
            method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
            headers: { accept: 'application/json', authorization: `Bearer ${access}` }
        });
        if (!response.ok || response.redirected) {
            void response.body?.cancel().catch(() => {});
            throw new Error('Account catalog request failed');
        }
        const body = await limitedJson(response, signal);
        if (!body || !Array.isArray(body.models) || body.models.length > 5000) throw new Error('Invalid account catalog');
        const known = new Map(specifications.filter(m => m.provider === 'openai').map(m => [m.id, m]));
        const models: Model<Api>[] = [], seen = new Set<string>();
        let unsupportedModelCount = 0;
        for (const entry of body.models) {
            if (entry?.visibility !== 'list') continue;
            if (typeof entry.slug !== 'string' || !entry.slug.trim() || entry.slug.length > 256 ||
                typeof entry.display_name !== 'string' || !entry.display_name.trim() || entry.display_name.length > 256 ||
                seen.has(entry.slug)) throw new Error('Invalid account model');
            seen.add(entry.slug);
            const spec = known.get(entry.slug);
            if (spec && spec.api === 'openai-responses' &&
                (spec.baseUrl === undefined || officialBase(spec.baseUrl))) models.push({ ...spec, name: entry.display_name });
            else unsupportedModelCount++;
        }
        // Reject late results from a replaced/logout session, including changes
        // made by a different SDK consumer while this GET was in flight.
        if (await this.access(signal) !== access || epoch !== this.epoch) throw new Error('Account changed');
        signal.throwIfAborted();
        return { models, catalog: {
            source: 'openai-account', accountAccess: 'confirmed', checkedAt: Date.now(), authChecked: true,
            status: unsupportedModelCount ? 'partial' : 'refreshed', unsupportedModelCount,
            ...(unsupportedModelCount ? { unsupportedModelReason: '账号返回的部分模型尚无兼容当前 ChatGPT 连接的 Pi SDK 规格，暂不可选择。' } : {})
        } };
    }
}

function officialBase(value: string | undefined) { return value?.replace(/\/$/, '') === BASE; }
async function limitedJson(response: Response, signal: AbortSignal): Promise<any> {
    const length = response.headers.get('content-length');
    if ((length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) ||
        !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Invalid account catalog response');
    }
    if (!response.body) throw new Error('Missing account catalog');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
        while (true) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw new Error('Account catalog too large');
            chunks.push(value);
        }
        signal.throwIfAborted();
        const joined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
    } finally { signal.removeEventListener('abort', cancel); cancel(); }
}
