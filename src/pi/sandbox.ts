import { isAbsolute, resolve } from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { createBashTool, type ExtensionAPI, type ExtensionFactory, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import officialSandbox from './sandbox-upstream.ts';

type Manager = Pick<typeof SandboxManager, 'initialize' | 'wrapWithSandbox' | 'reset'>;
type SharedState = { owners: number; initialized?: Promise<void>; configKey?: string; closing?: Promise<void> };
const managers = new WeakMap<Manager, SharedState>();
/** SandboxManager is process-global: sessions must not reset one another's proxy. */
export function createSandboxHost(options: {
    cwd: string;
    onStatus?: (message: string, level: string) => void;
}, manager: Manager = SandboxManager) {
    const configCwd = resolve(options.cwd);
    const state = managers.get(manager) ?? { owners: 0 };
    managers.set(manager, state);
    state.owners++;
    let disposed = false;
    const absolute = (path: string) => path.startsWith('~') || isAbsolute(path) ? path : resolve(configCwd, path);
    const shared: Manager = {
        async initialize(config) {
            if (disposed) throw Error('Sandbox host is closed');
            await state.closing;
            if (disposed) throw Error('Sandbox host is closed');
            const normalized: SandboxRuntimeConfig = {
                ...config,
                filesystem: {
                    ...config.filesystem,
                    denyRead: config.filesystem.denyRead.map(absolute),
                    allowWrite: config.filesystem.allowWrite.map(absolute),
                    denyWrite: config.filesystem.denyWrite.map(absolute),
                },
            };
            const key = JSON.stringify(normalized);
            if (state.configKey && state.configKey !== key) throw Error('Sandbox configuration changed; restart the daemon to apply it');
            if (!state.initialized) {
                state.configKey = key;
                state.initialized = Promise.resolve().then(() => manager.initialize(normalized));
            }
            await state.initialized;
        },
        wrapWithSandbox: (...args) => manager.wrapWithSandbox(...args),
        // A child ending must not tear down the parent or another child.
        async reset() {},
    };
    return {
        forSession(cwd: string, background = false) {
            let registered: ToolDefinition | undefined;
            const bash: ToolDefinition = {
                ...createBashTool(cwd),
                async execute(...args) {
                    if (!registered) throw Error('Sandbox extension has not loaded');
                    return registered.execute(...args);
                },
            };
            const extension: ExtensionFactory = api => officialSandbox(new Proxy(api, {
                get(target, property) {
                    if (property === 'registerTool') return (tool: ToolDefinition) => {
                        registered = tool;
                        // Background execution must wrap the sandbox tool, not replace it.
                        if (!background) api.registerTool(tool);
                    };
                    return Reflect.get(target, property);
                },
            }) as ExtensionAPI, { cwd, configCwd, manager: shared, notify: options.onStatus });
            return { extension, bash };
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            if (--state.owners === 0) {
                const pending = state.initialized;
                state.closing ??= Promise.resolve().then(async () => {
                    try {
                        if (pending) {
                            await pending.catch(() => {});
                            await manager.reset();
                        }
                    } finally {
                        state.initialized = undefined;
                        state.configKey = undefined;
                        state.closing = undefined;
                        if (state.owners === 0) managers.delete(manager);
                    }
                });
                await state.closing;
            }
        },
    };
}
export type SandboxHost = ReturnType<typeof createSandboxHost>;
