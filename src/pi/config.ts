import { join } from 'node:path';
import { getAgentDir, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import {withVerifiedImageCapability} from './image-budget.ts';
import {ModelConnections,createConnectionRuntime,legacyProvider,legacyConnectionId} from './model-connections.ts';
/** Native Pi owns model selection, credential resolution and OAuth refresh. */
export async function loadPiConfiguration(options: {
    agentDir?: string;
    cwd?: string;
} = {}) {
    const agentDir = options.agentDir ?? getAgentDir();
    const settings = SettingsManager.create(options.cwd ?? process.cwd(), agentDir);
    const connections = new ModelConnections(agentDir), selected = connections.read().current;
    const provider = selected?.provider ?? settings.getDefaultProvider(), id = selected?.model ?? settings.getDefaultModel();
    const connectionId = selected?.connectionId ?? (provider ? legacyConnectionId(provider) : undefined);
    const connection = connectionId && !legacyProvider(connectionId) ? connections.get(connectionId) : undefined;
    if (selected && !legacyProvider(selected.connectionId) && (!connection || connection.providerId !== provider)) throw Error('所选模型连接不可用，请在设置中明确选择连接；不会自动使用其他账号');
    const thinkingLevel = (selected?.thinkingLevel ?? settings.getDefaultThinkingLevel() ?? 'high') as NonNullable<ReturnType<typeof settings.getDefaultThinkingLevel>>;
    if (!provider && !id)
        throw Error('Pi 尚未选择模型：请在 GUI 的「Pi 登录与模型」中登录并选择模型');
    if (!provider || !id)
        throw Error('Pi defaultProvider and defaultModel must be configured together');
    let models: ModelRuntime;
    try {
        models = connection ? await createConnectionRuntime(connections,connection) : await ModelRuntime.create({
            authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json'), refreshOnCreate: false, allowModelNetwork: false
        });
    }
    catch {
        throw Error('Pi 模型或认证配置不可用，请在 Pi 中检查 /login 和 /model');
    }
    const configuredModel = models.getModel(provider, id);
    if (!configuredModel)
        throw Error('Pi 配置的模型不可用，请在 Pi 中检查 /model');
    const model=withVerifiedImageCapability(configuredModel);
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
        models, model, thinkingLevel, connectionBinding:{connectionId:connectionId!,providerId:provider,credentialVersion:connection?.credentialVersion??0}, source: 'pi' as const, public: {
            provider, model: id, thinkingLevel, connectionId, auth: 'Pi native', agentDir
        }, dispose: () => {
        }
    };
}
