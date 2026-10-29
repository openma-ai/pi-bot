import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LatencyBoundary } from '../../pi/latency.ts';

const hash = (id: string, length = 32) => createHash('sha256').update(id).digest('hex').slice(0, length);
const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : undefined;
export type TraceScope = { inputId: string; turnId?: string };
type Point = 'message.queued' | 'message.admitted' | 'run.start' | 'run.end' | 'session.ready' | 'request.pending' | 'request.resolved' | 'delivery.pending' | 'delivery.sending' | 'delivery.delivered' | 'delivery.uncertain' | 'delivery.superseded' | 'job.start' | 'job.end';

import { trace, ROOT_CONTEXT, SpanStatusCode, SpanKind, type Span, type SpanContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace';
import { localProvider, localOtlp } from '../../sdk/local-otel.ts';

class LocalFileExporter implements SpanExporter {
    private failed = false;
    private closed = false;
    private readonly file: string;
    constructor(private directory: string, private maxBytes: number) { this.file = join(directory, 'latency.otlp.jsonl'); }
    export(spans: ReadableSpan[], done: Parameters<SpanExporter['export']>[1]) {
        try {
            if (this.closed || this.failed) { done({code:ExportResultCode.SUCCESS}); return; }
            mkdirSync(this.directory, {recursive:true,mode:0o700});
            if(lstatSync(this.directory).isSymbolicLink()) throw Error('Unsafe trace directory');
            for(const path of [this.file,this.file+'.1']) if(existsSync(path)&&(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())) throw Error('Unsafe trace file');
            for(const span of spans) {
                const record=localOtlp(span,'pibo-harness'); if(!record)continue;
                const line=JSON.stringify(record)+'\n'; if(Buffer.byteLength(line)>this.maxBytes)continue;
                if(existsSync(this.file)&&statSync(this.file).size+Buffer.byteLength(line)>this.maxBytes)renameSync(this.file,this.file+'.1');
                appendFileSync(this.file,line,{mode:0o600});chmodSync(this.file,0o600);
            }
            done({code:ExportResultCode.SUCCESS});
        } catch { this.failed=true;done({code:ExportResultCode.FAILED}); }
    }
    async forceFlush() {}
    async shutdown(){this.closed=true;}
}

/** Manual standard OTel SDK, instance-local async context and local-only exporter.
 * Authorization never uses this context. Neither env exporters nor resource
 * detectors are installed. The bounded synchronous exporter has no send queue.
 */
export class LocalTrace {
    private sequence=0;
    private closed=false;
    private contexts=new AsyncLocalStorageContextManager().enable();
    private generating?: {spanId:string;traceId:string};
    private exporter: LocalFileExporter;
    private provider: ReturnType<typeof localProvider>;
    private tracer;
    private active=new Map<string,Span>();
    constructor(directory:string,maxBytes=1024*1024) {
        this.exporter=new LocalFileExporter(directory,maxBytes);
        this.provider=localProvider('pibo-harness',this.exporter,{
            generateTraceId:()=>this.generating?.traceId??randomBytes(16).toString('hex'),
            generateSpanId:()=>this.generating?.spanId??randomBytes(8).toString('hex')
        });
        this.tracer=this.provider.getTracer('pibo.local-latency','2');
    }
    private identity(scope:TraceScope,key:string):SpanContext {return {traceId:hash('message:'+scope.inputId),spanId:hash(key,16),traceFlags:1};}
    /** Standard asynchronous context, isolated per runtime and concurrent run. */
    withScope<T>(scope:TraceScope,operation:()=>T):T {
        const run='run:'+(scope.turnId??scope.inputId);
        const ctx=trace.setSpan(ROOT_CONTEXT,this.active.get(run)??trace.wrapSpanContext(this.identity(scope,run)));
        return this.contexts.with(ctx,operation);
    }
    activeContext(){return trace.getSpanContext(this.contexts.active());}
    traceparent(scope:TraceScope) {
        const carrier:Record<string,string>={};
        new W3CTraceContextPropagator().inject(trace.setSpanContext(ROOT_CONTEXT,this.identity(scope,'run:'+(scope.turnId??scope.inputId))),carrier,{set:(c,k,v)=>{c[k]=v;}});
        return carrier.traceparent;
    }
    async forceFlush(){try{await this.provider.forceFlush({timeoutMillis:1000});}catch{/* No task failure from diagnostics. */}}
    async shutdown(){
        if(this.closed)return;this.closed=true;
        for(const span of this.active.values()){span.setAttribute('pibo.outcome','cancelled');span.end();}
        this.active.clear();await this.forceFlush();await this.provider.shutdown().catch(()=>{});this.contexts.disable();
    }
    private begin(scope:TraceScope,key:string,name:string,at:number,parent?:string) {
        const run=scope.turnId??scope.inputId;
        const ctx=parent?trace.setSpanContext(ROOT_CONTEXT,this.identity(scope,parent)):
            scope.turnId&&key!=='run:'+run?trace.setSpanContext(ROOT_CONTEXT,this.identity(scope,'run:'+run)):ROOT_CONTEXT;
        this.generating={traceId:hash('message:'+scope.inputId),spanId:hash(key,16)};
        try{return this.tracer.startSpan(name,{kind:name.startsWith('provider.')?SpanKind.CLIENT:SpanKind.INTERNAL,startTime:at},ctx);}
        finally{this.generating=undefined;}
    }
    private start(scope:TraceScope,key:string,name:string,at=Date.now(),parent?:string) {
        if(this.closed||this.active.has(key))return;
        if(this.active.size>=512){const [oldKey,old]=this.active.entries().next().value!;old.setAttribute('pibo.outcome','uncertain');old.end();this.active.delete(oldKey);}
        this.active.set(key,this.begin(scope,key,name,at,parent));
    }
    private write(scope: TraceScope, name: string, key: string, attributes: Record<string, unknown>, at = Date.now(), duration = 0, parent?: string) {
        if(this.closed)return;
        try {
            const span=this.active.get(key)??this.begin(scope,key,name,at-duration,parent);
            this.active.delete(key);
            const attrs={...attributes,primaryInputIdHash:hash(scope.inputId),turnId:/^trn_[a-f0-9-]{36}$/.test(scope.turnId??'')?scope.turnId:undefined};
            for(const [k,v] of Object.entries(attrs)) if(typeof v==='string'||typeof v==='number')span.setAttribute('pibo.'+k,v);
            span.setStatus({code:attributes.outcome==='error'||attributes.status==='failed'?SpanStatusCode.ERROR:name.endsWith('.end')&&(attributes.outcome==='ok'||attributes.status==='completed')?SpanStatusCode.OK:SpanStatusCode.UNSET});
            span.end(at);
        } catch { /* Instrumentation cannot change task outcomes. */ }
    }
    point(scope: TraceScope, name: Point, data: { id?: string; elapsedMs?: number; status?: string; messageId?: string; tool?: string } = {}, at?: number) {
        if(name==='run.start')this.start(scope,'run:'+(scope.turnId??scope.inputId),'run.end',at);
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
        if(event.phase==='start')this.start(scope,base,event.kind+'.end',Date.now()-(finite(event.elapsedMs)??0),parent);
        this.write(scope, event.kind + '.' + event.phase, event.phase === 'end' ? base : base + ':' + event.phase, {
            elapsedMs: finite(event.elapsedMs), outcome: ['ok','error','cancelled','blocked','uncertain'].includes(event.outcome ?? '') ? event.outcome : undefined,
            tool: this.tool(event.tool), inputTokens: finite(event.inputTokens), outputTokens: finite(event.outputTokens), cacheReadTokens: finite(event.cacheReadTokens)
            , systemPromptCharacters: finite(event.systemPromptCharacters), toolSchemaCharacters: finite(event.toolSchemaCharacters), declaredToolCount: finite(event.declaredToolCount),
            declaredToolNames: Array.isArray(event.declaredToolNames) ? event.declaredToolNames.slice(0,128).map(n=>this.tool(n)??'other').join(',') : undefined,
            promptAndToolsChar4Estimate: finite(event.promptAndToolsChar4Estimate), messageCount: finite(event.messageCount)
        }, Date.now(), event.phase === 'end' ? finite(event.elapsedMs) ?? 0 : 0, event.phase === 'end' ? parent : base);
    }
    private tool(value?: string) {
        // Known product tools only. Extension-controlled names are never copied.
        return ['bash','read','edit','write','grep','find','ls','codemode','exec_wait','exec_read','exec_write','send_message','send_to_bot','ask_user','subagent','job_result','publish_file','file_workspace'].includes(value ?? '') ? value : value ? 'other' : undefined;
    }
}
