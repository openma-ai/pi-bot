import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { PiConversation, PiConversationEvent, PiConversationInput, PiDriverTool } from './agent-driver.ts';
export type PiConversationOptions = {
    /** Each OpenMatter Session keeps its Pi transcript under its own directory here. */
    dir: string;
    modelRuntime: ModelRuntime;
    model: Model<Api>;
    systemPrompt: string;
    maxOutputTokens?: number;
    tools?: ToolDefinition[];
};
const sessionDir = (dir: string, sessionId: string) => join(dir, encodeURIComponent(sessionId));
const toolDefinition = (tool: PiDriverTool): ToolDefinition => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: Type.Unsafe(tool.parameters as object),
    async execute(toolCallId, args, signal) {
        const value = await tool.execute(toolCallId, args, signal);
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
    }
});
export function canResumePiConversation(dir: string, sessionId: string) {
    return existsSync(sessionDir(dir, sessionId));
}
/** A real Pi session durable by OpenMatter Session id. */
export async function openPiConversation(options: PiConversationOptions, input: PiConversationInput): Promise<PiConversation> {
    const dir = sessionDir(options.dir, input.sessionId);
    mkdirSync(dir, { recursive: true });
    const settings = SettingsManager.inMemory({ retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => options.systemPrompt
    });
    await loader.reload();
    const { session } = await createAgentSession({
        cwd: dir, agentDir: dir, modelRuntime: options.modelRuntime, model: options.model, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.continueRecent(dir, dir), noTools: 'builtin', customTools: [...(options.tools ?? []), ...input.tools.map(toolDefinition)]
    });
    // A correction reaches the next provider boundary with everything queued before it.
    session.setSteeringMode('all');
    await session.bindExtensions({ mode: 'json' } as Parameters<typeof session.bindExtensions>[0]);
    return {
        get isStreaming() {
            return session.isStreaming;
        },
        prompt: text => session.prompt(text, { expandPromptTemplates: false }),
        steer: async text => {
            await session.steer(text);
        },
        drainSteers: () => session.clearQueue().steering,
        abort: () => session.abort(),
        subscribe(listener: (event: PiConversationEvent) => void) {
            return session.subscribe(event => {
                if (event.type === 'tool_execution_start')
                    listener({ type: 'tool_start', toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
                else if (event.type === 'tool_execution_end')
                    listener({
                        type: 'tool_end', toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError,
                        text: (event.result?.content ?? []).filter((part: { type: string }) => part.type === 'text').map((part: { text?: string }) => part.text ?? '').join('\n')
                    });
                else if (event.type === 'message_end' && event.message.role === 'assistant')
                    listener({
                        type: 'assistant_message',
                        text: event.message.content.filter(part => part.type === 'text').map(part => part.text).join(''),
                        hasToolCalls: event.message.content.some(part => part.type === 'toolCall'),
                        stopReason: event.message.stopReason,
                        ...(event.message.errorMessage ? { errorMessage: event.message.errorMessage } : {})
                    });
            });
        },
        async dispose() {
            await session.waitForIdle().catch(() => { });
            session.dispose();
        }
    };
}
