import { ROOT_CONTEXT, SpanStatusCode, type Context } from '@opentelemetry/api';
import { TracerProvider, AlwaysOnSampler, type SpanProcessor, type ReadableSpan, type SpanExporter, type IdGenerator } from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ExportResultCode } from '@opentelemetry/core';

/** Explicit manual SDK only: no NodeSDK, resource detectors, auto instrumentation,
 * global provider registration, environment exporter or collector configuration. */
export function localProvider(service: string, exporter: SpanExporter, idGenerator?: IdGenerator) {
    const processor: SpanProcessor = {
        onStart() {}, onEnd(span) { exporter.export([span], () => {}); },
        forceFlush: async () => { await exporter.forceFlush?.(); }, shutdown: () => exporter.shutdown()
    };
    return new TracerProvider({ resource: resourceFromAttributes({ 'service.name': service }),
        sampler: new AlwaysOnSampler(), spanProcessors: [processor], idGenerator,
        spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 1024, eventCountLimit: 0, linkCountLimit: 0 }
    });
}
const keys = new Set(['elapsedMs','status','messageIdHash','correlationIdHash','tool','outcome','inputTokens','outputTokens','cacheReadTokens','systemPromptCharacters','toolSchemaCharacters','declaredToolCount','declaredToolNames','promptAndToolsChar4Estimate','messageCount','primaryInputIdHash','turnId','itemIdHash','receiveToCommitMs','serverToReceiveClockDeltaMs']);
const names = /^(message\.(queued|admitted)|run\.(start|end)|session\.ready|request\.(pending|resolved)|delivery\.(pending|sending|delivered|uncertain|superseded)|job\.(start|end)|(?:provider|tool)\.(start|first_event|first_content|end)|frontend\.receive_to_commit)$/;
const nanos = ([sec, nano]: readonly number[]) => (BigInt(sec) * 1000000000n + BigInt(nano)).toString();
/** Convert actual SDK ReadableSpan, never arbitrary exceptions/events/resources. */
export function localOtlp(span: ReadableSpan, service: 'pibo-harness'|'pibo-client') {
    if (!names.test(span.name)) return undefined;
    const attributes = Object.entries(span.attributes).filter(([key, value]) => key.startsWith('pibo.') && keys.has(key.slice(5)) && (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value))).map(([key,value]) => ({key,value:typeof value==='number'?{doubleValue:value}:{stringValue:value}}));
    return {resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:service}}]},scopeSpans:[{scope:{name:service==='pibo-harness'?'pibo.local-latency':'pibo.frontend-latency',version:'2'},spans:[{
        traceId:span.spanContext().traceId,spanId:span.spanContext().spanId,parentSpanId:span.parentSpanContext?.spanId,
        name:span.name,kind:span.kind+1,startTimeUnixNano:nanos(span.startTime),endTimeUnixNano:nanos(span.endTime),attributes,status:{code:span.status.code}
    }]}]}]};
}
export class BoundedMemoryExporter implements SpanExporter {
    private values: unknown[]=[];
    private closed=false;
    export(spans: ReadableSpan[], done: Parameters<SpanExporter['export']>[1]) {
        if(!this.closed) for(const span of spans) {const value=localOtlp(span,'pibo-client');if(value){this.values.push(value);if(this.values.length>256)this.values.shift();}}
        done({code:ExportResultCode.SUCCESS});
    }
    snapshot(){return structuredClone(this.values);}
    clear(){this.values=[];}
    async forceFlush(){}
    async shutdown(){this.closed=true;}
}
export { ROOT_CONTEXT, SpanStatusCode, type Context };
