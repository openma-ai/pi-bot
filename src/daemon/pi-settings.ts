import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAgentDir, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { PiBotError } from './core/errors.ts';
import { PiModelCatalog } from './pi-model-catalog.ts';
type Login = {
    id: string;
    providerId: string;
    type: AuthType;
    status: 'pending' | 'complete' | 'failed' | 'cancelled';
    expiresAt: number;
    prompt?: Record<string, any>;
    events: AuthEvent[];
    error?: string;
    errorCode?: 'loginTimeout';
};
type Flow = {
    public: Login;
    abort: AbortController;
    timer: ReturnType<typeof setTimeout>;
    createdAt: number;
    finishedAt?: number;
    pending?: {
        id: string;
        answer: (value: string) => void;
        cancel: () => void;
    };
};
const LOGIN_WINDOW_MS = 15 * 60 * 1000 + 30000;
const MAX_LOGIN_WINDOW_MS = 30 * 60 * 1000;
const TERMINAL_RETENTION_MS = 15 * 60 * 1000;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Native Pi owns credentials. Only secret-free metadata leaves this service. */
export class PiSettings {
    onLogin?: () => Promise<unknown>;
    private flows = new Map<string, Flow>();
    private catalog: PiModelCatalog;
    private constructor(readonly agentDir: string, readonly cwd: string, private models: ModelRuntime, allowModelNetwork?: boolean) {
        this.catalog = new PiModelCatalog(models, { allowNetwork: allowModelNetwork });
    }
    static async create(options: {
        agentDir?: string;
        cwd?: string;
        /** Disable directory network calls; SIWC account choices then stay unconfirmed. */
        allowModelNetwork?: boolean;
    } = {}) {
        const agentDir = options.agentDir ?? getAgentDir(), cwd = options.cwd ?? process.cwd();
        const models = await ModelRuntime.create({
            authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json'), refreshOnCreate: false, allowModelNetwork: false
        });
        return new PiSettings(agentDir, cwd, models, options.allowModelNetwork);
    }
    async state() {
        const { models, providers, catalog } = await this.catalog.refresh();
        const saved = await this.models.listCredentials();
        const settings = SettingsManager.create(this.cwd, this.agentDir);
        return {
            current: {
                provider: settings.getDefaultProvider() ?? '', model: settings.getDefaultModel() ?? '', thinkingLevel: settings.getDefaultThinkingLevel() ?? 'high'
            }, providers: this.models.getProviders().map(p => ({
                id: p.id, name: p.name, methods: [...(p.auth.apiKey?.login ? ['api_key'] : []), ...(p.auth.oauth ? ['oauth'] : [])],
                methodLabels: {
                    ...(p.auth.apiKey?.login ? { api_key: p.auth.apiKey.name } : {}),
                    ...(p.auth.oauth ? { oauth: p.auth.oauth.loginLabel ?? p.auth.oauth.name } : {})
                }, credential: saved.find(c => c.providerId === p.id)?.type ?? null,
                configured: providers.get(p.id)?.configured ?? false,
                catalog: providers.get(p.id)?.catalog,
                models: models.filter(m => m.provider === p.id).map(m => ({
                    id: m.id, name: m.name, reasoning: m.reasoning
                }))
            })), catalog, agentDir: this.agentDir
        };
    }
    startLogin(providerId: string, type: AuthType, requestId?: string) {
        this.pruneFlows();
        if (requestId !== undefined && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)))
            throw new PiBotError('invalidParams', 'Invalid login request ID');
        const existing = requestId ? this.flows.get(requestId) : undefined;
        if (existing) {
            if (existing.public.providerId !== providerId || existing.public.type !== type)
                throw new PiBotError('conflict', '登录请求 ID 已用于其他登录');
            return { id: existing.public.id };
        }
        const provider = this.models.getProvider(providerId);
        if (!provider || !(type === 'api_key' ? provider.auth.apiKey?.login : type === 'oauth' ? provider.auth.oauth : false))
            throw new PiBotError('invalidParams', 'Unsupported Pi login method');
        if ([...this.flows.values()].some(f => f.public.status === 'pending'))
            throw new PiBotError('conflict', '已有登录正在进行，请完成或取消');
        this.catalog.invalidate();
        while (this.flows.size >= 8)
            this.flows.delete(this.flows.keys().next().value!);
        const id = requestId ?? randomUUID(), abort = new AbortController(), createdAt = Date.now();
        const flow: Flow = {
            public: {
                id, providerId, type, status: 'pending', events: [], expiresAt: createdAt + LOGIN_WINDOW_MS
            }, abort, createdAt, timer: setTimeout(() => this.expire(id), LOGIN_WINDOW_MS)
        };
        flow.timer.unref();
        this.flows.set(id, flow);
        void this.models.login(providerId, type, {
            signal: abort.signal, prompt: p => this.prompt(flow, p), notify: event => {
                if (flow.public.status === 'pending') {
                    flow.public.events = [...flow.public.events.slice(-15), event];
                    // Device flows own their polling interval and expiry. Do not cut the SDK's
                    // fifteen-minute approval window short with an unrelated HTTP timeout.
                    if (event.type === 'device_code' && typeof event.expiresInSeconds === 'number' && Number.isFinite(event.expiresInSeconds) && event.expiresInSeconds > 0) {
                        clearTimeout(flow.timer);
                        flow.public.expiresAt = Math.min(createdAt + MAX_LOGIN_WINDOW_MS, Date.now() + event.expiresInSeconds * 1000 + 30000);
                        flow.timer = setTimeout(() => this.expire(id), Math.max(0, flow.public.expiresAt - Date.now()));
                        flow.timer.unref();
                    }
                }
            }
        }, {
            getDeviceId: () => SettingsManager.create(this.cwd, this.agentDir).getOrCreateDeviceId(), agentName: 'pi-bot'
        }).then(async () => {
            this.catalog.invalidate();
            if (flow.public.status === 'pending') {
                flow.public.status = 'complete';
                flow.finishedAt = Date.now();
                clearTimeout(flow.timer);
                await this.onLogin?.();
            }
        }).catch(() => {
            if (flow.public.status === 'pending') {
                flow.public.status = 'failed';
                flow.finishedAt = Date.now();
                flow.public.error = 'Pi 登录未完成，请重试';
            }
        }).finally(() => {
            clearTimeout(flow.timer);
            flow.pending?.cancel();
            delete flow.public.prompt;
        });
        return {
            id
        };
    }
    private prompt(flow: Flow, p: AuthPrompt): Promise<string> {
        return new Promise((resolve, reject) => {
            const id = randomUUID();
            let done = false;
            const settle = (value?: string) => {
                if (done)
                    return;
                done = true;
                p.signal?.removeEventListener('abort', cancel);
                flow.abort.signal.removeEventListener('abort', cancel);
                flow.pending = undefined;
                delete flow.public.prompt;
                value === undefined ? reject(new Error('Login cancelled')) : resolve(value);
            };
            const cancel = () => settle();
            flow.pending = {
                id, answer: v => settle(v), cancel
            };
            const { signal, ...publicPrompt } = p;
            flow.public.prompt = {
                ...publicPrompt, id
            };
            p.signal?.addEventListener('abort', cancel, {
                once: true
            });
            flow.abort.signal.addEventListener('abort', cancel, {
                once: true
            });
            if (p.signal?.aborted || flow.abort.signal.aborted)
                cancel();
        });
    }
    loginState(id: string) {
        this.pruneFlows();
        const flow = this.flows.get(id);
        if (!flow)
            throw new PiBotError('notFound', 'Login expired');
        return structuredClone(flow.public);
    }
    answer(id: string, promptId: string, value: string) {
        const flow = this.flows.get(id);
        if (!flow || flow.public.status !== 'pending' || flow.pending?.id !== promptId)
            throw new PiBotError('conflict', '登录步骤已失效');
        if (typeof value !== 'string' || !value.trim() || value.length > 16000)
            throw new PiBotError('invalidParams', '请输入有效内容');
        if (flow.public.prompt?.type === 'select' && !flow.public.prompt.options.some((o: any) => o.id === value))
            throw new PiBotError('invalidParams', '请选择有效选项');
        flow.pending.answer(value);
    }
    cancel(id: string) {
        const flow = this.flows.get(id);
        if (flow?.public.status === 'pending') {
            flow.public.status = 'cancelled';
            flow.finishedAt = Date.now();
            clearTimeout(flow.timer);
            flow.abort.abort();
            flow.pending?.cancel();
        }
    }
    private expire(id: string) {
        const flow = this.flows.get(id);
        if (flow?.public.status !== 'pending') return;
        this.cancel(id);
        flow.public.status = 'failed';
        flow.public.errorCode = 'loginTimeout';
        flow.public.error = '登录已超时，请重新开始';
    }
    private pruneFlows() {
        for (const [id, flow] of this.flows) {
            if (flow.finishedAt !== undefined && Date.now() - flow.finishedAt >= TERMINAL_RETENTION_MS)
                this.flows.delete(id);
        }
    }
    async selectModel(provider: string, id: string, thinkingLevel: ThinkingLevel) {
        if (!this.models.getModel(provider, id) || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel))
            throw new PiBotError('invalidParams', 'Unknown Pi model or thinking level');
        if (!await this.catalog.canSelect(provider, id))
            throw new PiBotError('invalidParams', '该模型未通过当前账号与 SDK 模型目录确认，请重新加载或连接提供商');
        const settings = SettingsManager.create(this.cwd, this.agentDir), project = settings.getProjectSettings();
        if ((project.defaultProvider && project.defaultProvider !== provider) || (project.defaultModel && project.defaultModel !== id) || (project.defaultThinkingLevel && project.defaultThinkingLevel !== thinkingLevel))
            throw new PiBotError('conflict', '当前项目的 .pi/settings.json 覆盖了默认模型，请先在 Pi 中调整该项目配置');
        settings.setDefaultModelAndProvider(provider, id);
        settings.setDefaultThinkingLevel(thinkingLevel);
        await settings.flush();
        if (settings.drainErrors().length)
            throw new PiBotError('internal', 'Pi 配置保存失败');
    }
    async logout(provider: string) {
        if (!this.models.getProvider(provider))
            throw new PiBotError('invalidParams', 'Unknown provider');
        this.catalog.invalidate();
        try { await this.models.logout(provider); }
        finally { this.catalog.invalidate(); }
    }
    close() {
        this.catalog.invalidate();
        for (const id of this.flows.keys())
            this.cancel(id);
        this.flows.clear();
    }
}
