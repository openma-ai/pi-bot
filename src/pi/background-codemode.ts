import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { createCodemodeExtension, type ExtensionAPI, type ExtensionFactory, type ExtensionToolContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
type Result = AgentToolResult<unknown>;
export interface CodemodeCellNotice {
    cellId: string;
    sessionId: string;
    toolCallId: string;
    toolName?: string;
    state: string;
}
export interface BackgroundCodemodeOptions {
    /** All cell records and artifacts stay here; no OS temporary directory. */
    directory: string;
    yieldTimeMs?: number;
    /** Existing tool definitions (for example Pi bash) to adapt without replacing their executor. */
    additionalTools?: ToolDefinition[];
    maxRuntimeMs?: number;
    maxConcurrentCells?: number;
    maxCellsPerSession?: number;
    maxTraceBytes?: number;
    /** Host may route this into its durable inbox instead of a native custom message. */
    runExecution?: (notice: CodemodeCellNotice, params: unknown, execute: (params?: unknown) => Promise<Result>) => Promise<Result>;
    transformArguments?: (notice: CodemodeCellNotice, name: string, args: unknown) => unknown;
    onCompletion?: (notice: CodemodeCellNotice) => Promise<void> | void;
    onError?: (error: Error) => void;
    shouldYieldOnInput?: (text: string) => boolean;
}
interface RecordData extends CodemodeCellNotice {
    version: 1;
    createdAt: number;
    detached: boolean;
    result?: Result;
    tracePath: string;
}
interface Cell {
    data: RecordData;
    controller: AbortController;
    done: Promise<void>;
    notified: boolean;
    updates?: Result;
    wake: Set<() => void>;
    sequence: number;
    traceBytes: number;
    traceTail: Promise<void>;
    traceLimited: boolean;
    ready: boolean;
}
const textResult = (text: string, details: unknown = {}): Result => ({
    content: [{
            type: 'text', text
        }], details
});
const bounded = (value: number | undefined, fallback: number, max: number) => {
    const n = value ?? fallback;
    if (!Number.isSafeInteger(n) || n < 1 || n > max)
        throw Error('Invalid background codemode limit');
    return n;
};
/** Wraps Pi's existing codemode definition; does not reimplement QuickJS or MCP. */
export function createBackgroundCodemodeExtension(options: BackgroundCodemodeOptions): ExtensionFactory & {
    close(): Promise<void>;
} {
    const directory = resolve(options.directory);
    const yieldMs = bounded(options.yieldTimeMs, 1000, 60000);
    const runtimeMs = bounded(options.maxRuntimeMs, 600000, 3600000);
    const maxCells = bounded(options.maxConcurrentCells, 4, 32);
    const totalCells = bounded(options.maxCellsPerSession, 128, 4096);
    const maxTraceBytes = bounded(options.maxTraceBytes, 32 * 1024 * 1024, 128 * 1024 * 1024);
    const closers = new Set<() => Promise<void>>();
    const factory: ExtensionFactory = async (pi) => {
        const cells = new Map<string, Cell>();
        const toolOwners = new Map<string, Cell>();
        let admissionTail = Promise.resolve();
        const admit = async <T>(create: () => Promise<T>): Promise<T> => {
            const previous = admissionTail;
            let release!: () => void;
            admissionTail = new Promise<void>(resolve => {
                release = resolve;
            });
            await previous;
            try {
                return await create();
            }
            finally {
                release();
            }
        };
        let closing = false;
        const reportError = (error: Error) => {
            try {
                options.onError?.(error);
            }
            catch { /* observational callback */
            }
        };
        const interruptedState = (cell: Cell) => cell.controller.signal.reason === 'deadline' ? 'timed_out'
            : ['trace limit', 'trace persistence failed'].includes(cell.controller.signal.reason) ? 'failed' : 'cancelled';
        // The SDK bridge also routes truncated output and images into this directory.
        await mkdir(join(directory, 'artifacts'), {
            recursive: true, mode: 0o700
        });
        const sdk = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
        const { withOutputFileDirectory } = await import(join(sdk, 'utils/output-files.js'));
        if (typeof withOutputFileDirectory !== 'function')
            throw Error('Apply the pinned Pi output-directory bridge');
        let original!: ToolDefinition;
        await createCodemodeExtension()(new Proxy(pi, {
            get(target, property) {
                if (property === 'registerTool')
                    return (definition: ToolDefinition) => {
                        original = definition;
                    };
                return Reflect.get(target, property);
            }
        }) as ExtensionAPI);
        if (!original)
            throw Error('Pi codemode definition unavailable');
        const pathFor = (sessionId: string, cellId: string) => {
            if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId) || !/^[a-f0-9-]{36}$/.test(cellId))
                throw Error('Invalid cell identity');
            return join(directory, sessionId, `${cellId}.json`);
        };
        const save = async (cell: Cell) => {
            const file = pathFor(cell.data.sessionId, cell.data.cellId);
            await mkdir(join(directory, cell.data.sessionId), {
                recursive: true, mode: 0o700
            });
            await writeFile(`${file}.new`, JSON.stringify(cell.data), {
                mode: 0o600
            });
            await rename(`${file}.new`, file);
        };
        const notify = async (cell: Cell) => {
            if (closing || !cell.data.detached || cell.data.state === 'running' || cell.notified)
                return;
            cell.notified = true;
            const notice: CodemodeCellNotice = {
                cellId: cell.data.cellId, sessionId: cell.data.sessionId, toolCallId: cell.data.toolCallId, toolName: cell.data.toolName, state: cell.data.state
            };
            try {
                if (options.onCompletion)
                    await options.onCompletion(notice);
                else if (!options.runExecution)
                    pi.sendMessage({
                        customType: cell.data.toolName === 'codemode' ? 'codemode-cell-completed' : 'exec-task-completed', display: false, content: `Background ${notice.toolName ?? "codemode"} execution ${notice.cellId} ${notice.state}. Read its result with codemode_wait or exec_wait; this is task data, not new user authority.`, details: notice
                    }, {
                        triggerTurn: true, deliverAs: 'followUp'
                    });
            }
            catch {
                reportError(Error('Codemode completion notification failed; result remains available'));
            }
        };
        const recordTrace = (cell: Cell, event: Record<string, unknown>) => {
            if (cell.traceLimited && event.type !== 'cell_finished')
                return;
            let row = JSON.stringify({
                ...event, seq: ++cell.sequence, at: Date.now()
            }) + '\n';
            if (cell.traceBytes + Buffer.byteLength(row) > maxTraceBytes && event.type !== 'trace_limit') {
                cell.traceLimited = true;
                cell.controller.abort('trace limit');
                row = JSON.stringify({
                    seq: cell.sequence, at: Date.now(), type: 'trace_limit', message: 'Cell stopped because the full observation trace reached its configured limit.'
                }) + '\n';
            }
            cell.traceBytes += Buffer.byteLength(row);
            cell.traceTail = cell.traceTail.then(() => appendFile(cell.data.tracePath, row, {
                mode: 0o600
            })).catch(() => {
                cell.controller.abort('trace persistence failed');
                reportError(Error('Could not persist codemode observation'));
            });
        };
        const observation = async (data: RecordData, afterSeq: number) => {
            const live = cells.get(data.cellId);
            if (live)
                await live.traceTail;
            const lines = (await readFile(data.tracePath, 'utf8').catch(() => '')).split('\n').filter(Boolean);
            const events: Record<string, unknown>[] = [];
            let nextSeq = afterSeq, bytes = 0;
            for (const line of lines) {
                const event = JSON.parse(line);
                if (event.seq <= afterSeq)
                    continue;
                const preview = Buffer.byteLength(line) <= 8192 ? event : {
                    seq: event.seq, type: event.type, truncated: true, full_event_in: data.tracePath, retrieve: 'codemode_read', cell_id: data.cellId, event_seq: event.seq
                };
                const size = Buffer.byteLength(JSON.stringify(preview));
                if (events.length >= 32 || bytes + size > 32768)
                    break;
                events.push(preview);
                bytes += size;
                nextSeq = event.seq;
            }
            return {
                cell_id: data.cellId, task_id: data.cellId, tool: data.toolName, state: live && !live.ready ? 'running' : data.state, failure_reason: live?.controller.signal.aborted ? String(live.controller.signal.reason) : undefined, tool_call_id: data.toolCallId, observations: events, next_seq: nextSeq, trace_path: data.tracePath
            };
        };
        const view = async (data: RecordData, afterSeq: number): Promise<Result> => {
            const details = await observation(data, afterSeq);
            const updates = cells.get(data.cellId)?.updates?.details;
            const base = (!cells.has(data.cellId) || cells.get(data.cellId)?.ready ? data.result : undefined) ?? textResult(data.toolName === "codemode" ? `Script running with cell ID ${data.cellId}. Read the result with codemode_wait.` : `Execution running with task ID ${data.cellId}. Read the result with exec_wait.`);
            return {
                ...base, content: [...base.content, ...(details.observations.length ? [{
                            type: 'text' as const, text: 'Cell observations:\n' + JSON.stringify(details.observations)
                        }] : [])], details: {
                    ...updates as object, ...base.details as object, ...details
                }
            };
        };
        const wait = async (cell: Cell, ms: number, signal?: AbortSignal, afterSeq = 0): Promise<Result> => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let wake!: () => void;
            const yielded = new Promise<void>(r => {
                wake = r;
                cell.wake.add(wake);
                timer = setTimeout(wake, ms);
            });
            signal?.addEventListener('abort', wake, {
                once: true
            });
            if (signal?.aborted)
                wake();
            try {
                await Promise.race([cell.done, yielded]);
            }
            finally {
                if (timer)
                    clearTimeout(timer);
                cell.wake.delete(wake);
                signal?.removeEventListener('abort', wake);
            }
            if (cell.ready)
                return view(cell.data, afterSeq);
            cell.data.detached = true;
            // Persisted on completion; the initial running record already exists.
            void notify(cell);
            return view(cell.data, afterSeq);
        };
        const nested = new Set<string>();
        // Observe the native pipeline, including tools invoked by another tool.
        pi.on('tool_execution_start', event => {
            const cell = event.parentToolCallId ? toolOwners.get(event.parentToolCallId) : undefined;
            if (!cell)
                return;
            toolOwners.set(event.toolCallId, cell);
            recordTrace(cell, {
                type: 'tool_started', executionId: event.toolCallId, parentToolCallId: event.parentToolCallId, name: event.toolName, args: event.args
            });
        });
        pi.on('tool_execution_update', event => {
            const cell = toolOwners.get(event.toolCallId);
            if (cell && event.toolCallId !== cell.data.toolCallId)
                recordTrace(cell, {
                    type: 'tool_update', executionId: event.toolCallId, name: event.toolName, update: event.partialResult
                });
        });
        pi.on('tool_execution_end', event => {
            const cell = toolOwners.get(event.toolCallId);
            if (cell && event.parentToolCallId) {
                recordTrace(cell, {
                    type: 'tool_finished', executionId: event.toolCallId, parentToolCallId: event.parentToolCallId, name: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError
                });
                toolOwners.delete(event.toolCallId);
            }
        });
        pi.on('tool_call', event => {
            if (event.parentToolCallId)
                nested.add(event.toolCallId);
        });
        pi.on('tool_result', event => {
            nested.delete(event.toolCallId);
        });
        const registerExecution = (definition: ToolDefinition) => {
            const original = definition;
            const collector = original.name === 'codemode' ? 'codemode_wait' : 'exec_wait';
            const description = `${original.description}\nLong executions keep running after this call yields. A running ID is a receipt, not completion. Use ${collector} to collect results; do not rerun the execution. New user input yields the wait without cancelling the script or its nested tools.${options.runExecution ? ' Supply source_message_id from the original inbox task, especially when several tasks are visible.' : ''}`;
            const objectParameters = original.parameters as ReturnType<typeof Type.Object>;
            const parameters = options.runExecution ? {
                ...objectParameters, properties: {
                    ...objectParameters.properties, source_message_id: Type.Optional(Type.String())
                }
            } : original.parameters;
            if (options.runExecution && objectParameters.type !== 'object')
                throw Error('Background host tools require object arguments');
            pi.registerTool({
                ...original, parameters, description, defaultActive: true,
                prepareLoadout(loadout) {
                    const changes = original.prepareLoadout?.(loadout);
                    return {
                        ...changes, descriptions: {
                            ...changes?.descriptions, [original.name]: `${changes?.descriptions?.[original.name] ?? description}\nBackground: this call can return a running ID; collect it with ${collector}, never restart it.${options.runExecution ? ' Include source_message_id for the original inbox task.' : ''}`
                        }
                    };
                },
                async execute(toolCallId, params, _signal, onUpdate, ctx) {
                    // Calls inside codemode/start_job already have an execution owner: await them normally.
                    if (original.name !== 'codemode' && nested.has(toolCallId))
                        return original.execute(toolCallId, params, _signal, onUpdate, ctx);
                    if (!(ctx as ExtensionToolContext & {
                        supportsDetachedToolExecution?: boolean;
                    }).supportsDetachedToolExecution)
                        throw Error('Apply the pinned Pi background bridge before using this extension');
                    if (closing)
                        throw Error('Background codemode is closing');
                    const sessionId = ctx.sessionManager.getSessionId();
                    const originatingMessage = ctx.sessionManager.buildSessionProjection().messages.slice().reverse().find(m => m.role === 'assistant' && m.content.some(p => p.type === 'toolCall' && p.id === toolCallId)) as AssistantMessage | undefined;
                    if (!originatingMessage)
                        throw Error('Original codemode call unavailable');
                    const cell = await admit(async () => {
                        if (closing)
                            throw Error('Background codemode is closing');
                        if ([...cells.values()].filter(c => !c.ready).length >= maxCells)
                            throw Error('Concurrent codemode cell limit reached');
                        const sessionDirectory = join(directory, sessionId);
                        const count = (await readdir(sessionDirectory).catch(() => [])).filter(p => p.endsWith('.json')).length;
                        if (count >= totalCells)
                            throw Error('Session codemode cell limit reached; retained results were not deleted');
                        const cellId = randomUUID();
                        const cell: Cell = {
                            data: {
                                version: 1, cellId, sessionId, toolCallId, toolName: original.name, state: 'running', createdAt: Date.now(), detached: false, tracePath: join(sessionDirectory, `${cellId}.trace.jsonl`)
                            }, controller: new AbortController(), done: Promise.resolve(), notified: false, wake: new Set(), sequence: 0, traceBytes: 0, traceTail: Promise.resolve(), traceLimited: false, ready: false
                        };
                        await save(cell);
                        await writeFile(cell.data.tracePath, '', {
                            mode: 0o600, flag: 'wx'
                        });
                        cells.set(cell.data.cellId, cell);
                        toolOwners.set(toolCallId, cell);
                        return cell;
                    });
                    recordTrace(cell, {
                        type: 'cell_started', toolCallId, tool: original.name, args: params
                    });
                    let sequence = 0;
                    const capturedTools = [...ctx.tools];
                    // Native pipeline, pinned origin and unique late-call scopes. Never tool.execute directly.
                    const cellContext = Object.create(ctx) as ExtensionToolContext;
                    Object.defineProperties(cellContext, {
                        tools: {
                            value: capturedTools
                        },
                        executeTool: {
                            value: async (name: string, args: unknown, callOptions: {
                                onUpdate?: (update: Result) => void;
                            } = {}) => {
                                if (!capturedTools.some(t => t.name === name))
                                    throw Error('Tool outside original codemode loadout');
                                args = options.transformArguments?.(cell.data, name, args) ?? args;
                                const executionId = `${cell.data.cellId}/${++sequence}`;
                                const outcome = await ctx.executeTool(name, args, {
                                    ...callOptions, signal: cell.controller.signal, executionId, originatingMessage: structuredClone(originatingMessage), onUpdate: update => {
                                        callOptions.onUpdate?.(update);
                                    }
                                } as Parameters<ExtensionToolContext['executeTool']>[2]);
                                return outcome;
                            }
                        },
                    });
                    const deadline = setTimeout(() => cell.controller.abort('deadline'), runtimeMs);
                    cell.done = Promise.resolve().then(async () => {
                        try {
                            const execute = (arguments_: unknown = params): Promise<Result> => withOutputFileDirectory(join(directory, 'artifacts'), () => original.execute(toolCallId, arguments_, cell.controller.signal, update => {
                                cell.updates = update;
                                const item = (update.details as {
                                    scriptOutputItem?: unknown;
                                })?.scriptOutputItem;
                                if (item)
                                    recordTrace(cell, {
                                        type: 'script_output', item
                                    });
                                else if (original.name !== 'codemode')
                                    recordTrace(cell, {
                                        type: 'execution_update', update
                                    });
                                if (!cell.data.detached)
                                    onUpdate?.(update);
                            }, cellContext));
                            cell.data.result = options.runExecution ? await options.runExecution(cell.data, params, execute) : await execute();
                            const failed = Boolean((cell.data.result as Result & {
                                isError?: boolean;
                            }).isError);
                            cell.data.state = cell.controller.signal.aborted ? interruptedState(cell) : failed ? 'failed' : 'completed';
                        }
                        catch (error) {
                            cell.data.state = cell.controller.signal.aborted ? interruptedState(cell) : 'failed';
                            cell.data.result = textResult(`${original.name} execution failed; no automatic retry.\n${error instanceof Error ? error.message : 'Tool execution failed'}`, {
                                cell_id: cell.data.cellId, state: cell.data.state
                            });
                        }
                        finally {
                            clearTimeout(deadline);
                        }
                        recordTrace(cell, {
                            type: 'cell_finished', state: cell.data.state
                        });
                        await cell.traceTail;
                        try {
                            await save(cell);
                        }
                        catch (error) {
                            cell.data.state = 'persistence_failed';
                            cell.data.result!.content.push({
                                type: 'text', text: 'Final result could not be saved. This copy is memory-only; do not claim durable completion.'
                            });
                            reportError(Error('Could not persist codemode result'));
                        }
                        cell.ready = true;
                        for (const [id, owner] of toolOwners)
                            if (owner === cell)
                                toolOwners.delete(id);
                        await notify(cell);
                        // Keep memory bounded; finalized cells remain readable from their files.
                        for (const [id, old] of cells)
                            if (cells.size > maxCells + 16 && old.ready && old.wake.size === 0)
                                cells.delete(id);
                    });
                    return wait(cell, yieldMs);
                }
            });
        };
        registerExecution(original);
        for (const tool of options.additionalTools ?? []) {
            if (['codemode', 'codemode_wait', 'codemode_read', 'exec_wait'].includes(tool.name))
                throw Error('Reserved background tool name');
            registerExecution(tool);
        }
        const waitSchema = Type.Object({
            cell_id: Type.String(), yield_time_ms: Type.Optional(Type.Integer({
                minimum: 1, maximum: 60000
            })), terminate: Type.Optional(Type.Boolean()), after_seq: Type.Optional(Type.Integer({
                minimum: 0
            }))
        });
        const waitDefinition: ToolDefinition<typeof waitSchema> = {
            name: 'codemode_wait', exposure: 'model-only', label: 'Wait for codemode cell', description: 'Read script output, tool progress and final results for a cell owned by this session. after_seq is an observation cursor: pass the previous next_seq for new events. Large events remain complete in trace_path. Waiting yields on timeout or new input; the cell is never restarted. terminate=true explicitly cancels its execution. Saved completed results remain readable after reopening the session.', parameters: waitSchema,
            async execute(_id, args, signal, _update, ctx) {
                const sessionId = ctx.sessionManager.getSessionId();
                let cell = cells.get(args.cell_id);
                if (cell && cell.data.sessionId !== sessionId)
                    throw Error('Cell unavailable in this session');
                if (!cell) {
                    let record: RecordData;
                    try {
                        record = JSON.parse(await readFile(pathFor(sessionId, args.cell_id), 'utf8'));
                    }
                    catch {
                        throw Error('Cell unavailable in this session');
                    }
                    if (record.version !== 1 || record.cellId !== args.cell_id || record.sessionId !== sessionId || record.tracePath !== join(directory, sessionId, `${args.cell_id}.trace.jsonl`))
                        throw Error('Invalid cell record');
                    if (record.result)
                        return view(record, args.after_seq ?? 0);
                    return textResult('Cell execution is uncertain after process exit. It was not replayed.', {
                        cell_id: args.cell_id, state: 'uncertain'
                    });
                }
                if (args.terminate)
                    cell.controller.abort('explicit termination');
                return wait(cell, bounded(args.yield_time_ms, yieldMs, 60000), signal, args.after_seq ?? 0);
            }
        };
        pi.registerTool(waitDefinition);
        pi.registerTool({
            name: 'codemode_read', exposure: 'model-only', label: 'Read retained execution output', description: 'Read full retained observation events in bounded character pages, including events too large for codemode_wait. Supply event_seq from an observation; omit it to read the saved final result. offset/next_offset are character positions in the complete JSON record. Works with cell_id from codemode or task_id from bash (pass that as cell_id). Session ownership is enforced; never restarts execution.', parameters: Type.Object({
                cell_id: Type.String(), event_seq: Type.Optional(Type.Integer({
                    minimum: 1
                })), offset: Type.Optional(Type.Integer({
                    minimum: 0
                })), limit: Type.Optional(Type.Integer({
                    minimum: 1, maximum: 24000
                }))
            }),
            async execute(_id, args, _signal, _update, ctx) {
                const sessionId = ctx.sessionManager.getSessionId();
                const record: RecordData = JSON.parse(await readFile(pathFor(sessionId, args.cell_id), 'utf8'));
                if (record.version !== 1 || record.cellId !== args.cell_id || record.sessionId !== sessionId || record.tracePath !== join(directory, sessionId, `${args.cell_id}.trace.jsonl`))
                    throw Error('Invalid cell record');
                const live = cells.get(args.cell_id);
                if (live)
                    await live.traceTail;
                // A final-result cursor must refer to immutable final JSON, not a temporary running-state page.
                if(args.event_seq===undefined&&record.result===undefined) return textResult('Final result is not available yet. End this turn and read after the completion notice.',{cell_id:args.cell_id,state:record.state,offset:0,next_offset:0,total_characters:0,done:false});
                const text = args.event_seq === undefined ? JSON.stringify(record.result ?? {
                    state: record.state
                }) : (await readFile(record.tracePath, 'utf8')).split('\n').find(row => row && JSON.parse(row).seq === args.event_seq);
                if (text === undefined)
                    throw Error('Observation unavailable');
                const offset = args.offset ?? 0;
                const fragment = text.slice(offset, offset + (args.limit ?? 12000));
                const next = Math.min(text.length, offset + fragment.length);
                return textResult(fragment, {
                    cell_id: args.cell_id, event_seq: args.event_seq, offset, next_offset: next, total_characters: text.length, done: next >= text.length
                });
            }
        });
        pi.registerTool({
            description: waitDefinition.description, exposure: 'model-only', name: 'exec_wait', label: 'Wait for execution', parameters: Type.Object({
                task_id: Type.String(), yield_time_ms: Type.Optional(Type.Integer({
                    minimum: 1, maximum: 60000
                })), terminate: Type.Optional(Type.Boolean()), after_seq: Type.Optional(Type.Integer({
                    minimum: 0
                }))
            }),
            execute: (id, args, signal, update, ctx) => waitDefinition.execute(id, {
                ...args, cell_id: args.task_id
            }, signal, update, ctx),
        });
        pi.on('input', (_event, ctx) => {
            if (options.shouldYieldOnInput && !options.shouldYieldOnInput(_event.text))
                return {
                    action: 'continue'
                };
            for (const cell of cells.values())
                if (cell.data.sessionId === ctx.sessionManager.getSessionId())
                    for (const wake of cell.wake)
                        wake();
            return {
                action: 'continue'
            };
        });
        const shutdown = async () => {
            closing = true;
            for (const cell of cells.values())
                if (cell.data.state === 'running')
                    cell.controller.abort('session closed');
            await Promise.all([...cells.values()].map(c => c.done));
        };
        closers.add(shutdown);
        pi.on('session_shutdown', shutdown);
        pi.on('session_before_switch', shutdown);
        pi.on('session_start', () => {
            closing = false;
        });
    };
    return Object.assign(factory, {
        close: async () => {
            await Promise.all([...closers].map(close => close()));
            closers.clear();
        }
    });
}
