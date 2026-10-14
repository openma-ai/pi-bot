import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAgentDir, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { PiBotError } from './core/errors.ts';
type Login = {
    id: string;
    providerId: string;
    status: 'pending' | 'complete' | 'failed' | 'cancelled';
    prompt?: Record<string, any>;
    events: AuthEvent[];
    error?: string;
};
type Flow = {
    public: Login;
    abort: AbortController;
    timer: ReturnType<typeof setTimeout>;
    pending?: {
        id: string;
        answer: (value: string) => void;
        cancel: () => void;
    };
};
/** Native Pi owns credentials. Only secret-free metadata leaves this service. */
export class PiSettings {
    onLogin?: () => Promise<unknown>;
    private flows = new Map<string, Flow>();
    private constructor(readonly agentDir: string, readonly cwd: string, private models: ModelRuntime) {
    }
    static async create(options: {
        agentDir?: string;
        cwd?: string;
    } = {}) {
        const agentDir = options.agentDir ?? getAgentDir(), cwd = options.cwd ?? process.cwd();
        const models = await ModelRuntime.create({
            authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json'), refreshOnCreate: false, allowModelNetwork: false
        });
        return new PiSettings(agentDir, cwd, models);
    }
    async state() {
        const saved = await this.models.listCredentials();
        const settings = SettingsManager.create(this.cwd, this.agentDir);
        return {
            current: {
                provider: settings.getDefaultProvider() ?? '', model: settings.getDefaultModel() ?? '', thinkingLevel: settings.getDefaultThinkingLevel() ?? 'high'
            }, providers: this.models.getProviders().map(p => ({
                id: p.id, name: p.name, methods: [...(p.auth.apiKey?.login ? ['api_key'] : []), ...(p.auth.oauth ? ['oauth'] : [])], credential: saved.find(c => c.providerId === p.id)?.type ?? null, models: this.models.getModels(p.id).map(m => ({
                    id: m.id, name: m.name, reasoning: m.reasoning
                }))
            })), agentDir: this.agentDir
        };
    }
    startLogin(providerId: string, type: AuthType) {
        const provider = this.models.getProvider(providerId);
        if (!provider || !(type === 'api_key' ? provider.auth.apiKey?.login : type === 'oauth' ? provider.auth.oauth : false))
            throw new PiBotError('invalidParams', 'Unsupported Pi login method');
        if ([...this.flows.values()].some(f => f.public.status === 'pending'))
            throw new PiBotError('conflict', '已有登录正在进行，请完成或取消');
        while (this.flows.size >= 8)
            this.flows.delete(this.flows.keys().next().value!);
        const id = randomUUID(), abort = new AbortController();
        const flow: Flow = {
            public: {
                id, providerId, status: 'pending', events: []
            }, abort, timer: setTimeout(() => this.cancel(id), 600000)
        };
        flow.timer.unref();
        this.flows.set(id, flow);
        void this.models.login(providerId, type, {
            signal: abort.signal, prompt: p => this.prompt(flow, p), notify: event => {
                if (flow.public.status === 'pending')
                    flow.public.events = [...flow.public.events.slice(-15), event];
            }
        }, {
            getDeviceId: () => SettingsManager.create(this.cwd, this.agentDir).getOrCreateDeviceId(), agentName: 'pi-bot'
        }).then(async () => {
            if (flow.public.status === 'pending') {
                flow.public.status = 'complete';
                await this.onLogin?.();
            }
        }).catch(() => {
            if (flow.public.status === 'pending') {
                flow.public.status = 'failed';
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
            clearTimeout(flow.timer);
            flow.abort.abort();
            flow.pending?.cancel();
        }
    }
    async selectModel(provider: string, id: string, thinkingLevel: ThinkingLevel) {
        if (!this.models.getModel(provider, id) || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel))
            throw new PiBotError('invalidParams', 'Unknown Pi model or thinking level');
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
        await this.models.logout(provider);
    }
    close() {
        for (const id of this.flows.keys())
            this.cancel(id);
        this.flows.clear();
    }
}
