import { join } from 'node:path';
import { getAgentDir, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
/** Native Pi owns model selection, credential resolution and OAuth refresh. */
export async function loadPiConfiguration(options: {
    agentDir?: string;
    cwd?: string;
} = {}) {
    const agentDir = options.agentDir ?? getAgentDir();
    const settings = SettingsManager.create(options.cwd ?? process.cwd(), agentDir);
    const provider = settings.getDefaultProvider(), id = settings.getDefaultModel();
    if (!provider && !id)
        throw Error('Pi 尚未选择模型：请在 GUI 的「Pi 登录与模型」中登录并选择模型');
    if (!provider || !id)
        throw Error('Pi defaultProvider and defaultModel must be configured together');
    let models: ModelRuntime;
    try {
        models = await ModelRuntime.create({
            authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json'), refreshOnCreate: false, allowModelNetwork: false
        });
    }
    catch {
        throw Error('Pi 模型或认证配置不可用，请在 Pi 中检查 /login 和 /model');
    }
    const model = models.getModel(provider, id);
    if (!model)
        throw Error('Pi 配置的模型不可用，请在 Pi 中检查 /model');
    let authenticated;
    try {
        authenticated = await models.checkAuth(provider);
    }
    catch {
        throw Error('Pi 认证不可用，请在 Pi 中完成 /login');
    }
    if (!authenticated)
        throw Error('Pi 尚未认证，请在 Pi 中完成 /login');
    return {
        models, model, thinkingLevel: settings.getDefaultThinkingLevel() ?? 'high', source: 'pi' as const, public: {
            provider, model: id, thinkingLevel: settings.getDefaultThinkingLevel() ?? 'high', auth: 'Pi native', agentDir
        }, dispose: () => {
        }
    };
}
