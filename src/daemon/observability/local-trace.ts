import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LatencyBoundary } from '../../pi/latency.ts';

const hash = (id: string, length = 32) => createHash('sha256').update(id).digest('hex').slice(0, length);
const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : undefined;
export type TraceScope = { inputId: string; turnId?: string };
type Point = 'message.queued' | 'message.admitted' | 'run.start' | 'run.end' | 'session.ready' | 'request.pending' | 'request.resolved' | 'delivery.pending' | 'delivery.sending' | 'delivery.delivered' | 'delivery.uncertain' | 'delivery.superseded' | 'job.start' | 'job.end';

/** Bounded local OTLP/JSON ExportTraceServiceRequest journal, not an SDK/exporter.
 * There is no configurable endpoint and no dependency on network/exporter state.
 * IDs are hashed; only the host-generated turn ID remains directly searchable.
 */
export class LocalTrace {
    private readonly file: string;
    private failed = false;
    private sequence = 0;
    constructor(private directory: string, private maxBytes = 1024 * 1024) { this.file = join(directory, 'latency.otlp.jsonl'); }
    private write(scope: TraceScope, name: string, span: string, attributes: Record<string, unknown>, at = Date.now(), duration = 0, parent?: string) {
        try {
            if (this.failed) return;
            // Refuse redirected diagnostic paths. Never overwrite a symlink target.
            mkdirSync(this.directory, { recursive: true, mode: 0o700 });
            if (lstatSync(this.directory).isSymbolicLink()) throw Error('Unsafe trace directory');
            for (const path of [this.file, this.file + '.1']) if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw Error('Unsafe trace file');
            const run = scope.turnId ?? scope.inputId;
            const attrs = { ...attributes, primaryInputIdHash: hash(scope.inputId), turnId: /^trn_[a-f0-9-]{36}$/.test(scope.turnId ?? '') ? scope.turnId : undefined };
            const nanos = (ms: number) => (BigInt(Math.max(0, Math.round(ms * 1000))) * 1000n).toString();
            const record = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'pibo-harness' } }] }, scopeSpans: [{ scope: { name: 'pibo.local-latency', version: '1' }, spans: [{
                traceId: hash('message:' + scope.inputId), spanId: hash(span, 16), parentSpanId: !scope.turnId || span === 'run:' + run ? undefined : hash(parent ?? 'run:' + run, 16), name,
                kind: name.startsWith('provider.') ? 3 : 1, startTimeUnixNano: nanos(at - duration), endTimeUnixNano: nanos(at),
                attributes: Object.entries(attrs).filter(([,value]) => value !== undefined).map(([key,value]) => ({ key: 'pibo.' + key, value: typeof value === 'number' ? { doubleValue: value } : { stringValue: String(value) } })),
                // An ended wait, cancellation or unknown outcome is not success.
                status: { code: attributes.outcome === 'error' || attributes.status === 'failed' ? 2 : name.endsWith('.end') && (attributes.outcome === 'ok' || attributes.status === 'completed') ? 1 : 0 }
            }] }] }] };
            const line = JSON.stringify(record) + '\n';
            if (Buffer.byteLength(line) > this.maxBytes) return;
            if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > this.maxBytes) renameSync(this.file, this.file + '.1');
            appendFileSync(this.file, line, { mode: 0o600 });
            chmodSync(this.file, 0o600);
        } catch { this.failed = true; /* Disk full/permissions must not affect a task. */ }
    }
    point(scope: TraceScope, name: Point, data: { id?: string; elapsedMs?: number; status?: string; messageId?: string; tool?: string } = {}, at?: number) {
        const status = ['pending','resolved','cancelled','expired','completed','failed','uncertain','interrupted','yielded'].includes(data.status ?? '') ? data.status : undefined;
        const base = name.startsWith('run.') || name === 'session.ready' ? 'run:' + (scope.turnId ?? scope.inputId) : name.split('.')[0] + ':' + (data.id ?? scope.inputId);
        this.write(scope, name, name === 'run.end' ? base : base + ':' + name + ':' + this.sequence++, {
            elapsedMs: finite(data.elapsedMs), status, messageIdHash: data.messageId ? hash(data.messageId) : undefined,
            correlationIdHash: data.id ? hash(data.id) : undefined, tool: this.tool(data.tool)
        }, at, name === 'run.end' || name === 'request.resolved' ? finite(data.elapsedMs) ?? 0 : 0);
    }
    boundary(scope: TraceScope, event: LatencyBoundary) {
        if (!['provider','tool'].includes(event.kind) || !['start','first_event','first_content','end'].includes(event.phase)) return;
        const run = scope.turnId ?? scope.inputId;
        const base = event.kind + ':' + run + ':' + event.id;
        const parent = event.kind === 'tool' && event.parentToolCallId && event.parentToolCallId !== event.id
            ? 'tool:' + run + ':' + event.parentToolCallId : undefined;
        this.write(scope, event.kind + '.' + event.phase, event.phase === 'end' ? base : base + ':' + event.phase, {
            elapsedMs: finite(event.elapsedMs), outcome: ['ok','error','cancelled','blocked','uncertain'].includes(event.outcome ?? '') ? event.outcome : undefined,
            tool: this.tool(event.tool), inputTokens: finite(event.inputTokens), outputTokens: finite(event.outputTokens), cacheReadTokens: finite(event.cacheReadTokens)
            , systemPromptCharacters: finite(event.systemPromptCharacters), toolSchemaCharacters: finite(event.toolSchemaCharacters), declaredToolCount: finite(event.declaredToolCount),
            declaredToolNames: Array.isArray(event.declaredToolNames) ? event.declaredToolNames.slice(0,128).map(n=>/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(n) ? n : 'other').join(',') : undefined,
            promptAndToolsChar4Estimate: finite(event.promptAndToolsChar4Estimate), messageCount: finite(event.messageCount)
        }, Date.now(), event.phase === 'end' ? finite(event.elapsedMs) ?? 0 : 0, event.phase === 'end' ? parent : base);
    }
    private tool(value?: string) {
        // Known product tools only. Extension-controlled names are never copied.
        return ['bash','read','edit','write','grep','find','ls','codemode','exec_wait','exec_read','exec_write','send_message','send_to_bot','ask_user','subagent','job_result','publish_file','file_workspace'].includes(value ?? '') ? value : value ? 'other' : undefined;
    }
}
