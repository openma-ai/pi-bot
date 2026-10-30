import { ROOT_CONTEXT, SpanStatusCode, type Context } from '@opentelemetry/api';
import { TracerProvider, AlwaysOnSampler, type SpanProcessor, type ReadableSpan, type SpanExporter, type IdGenerator } from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ExportResultCode } from '@opentelemetry/core';
import { localTelemetryEnvelope } from './protocol/telemetry.ts';

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
/** Convert actual SDK ReadableSpan, never arbitrary exceptions/events/resources. */
export function localOtlp(span: ReadableSpan, service: 'pibo-harness'|'pibo-client') {
    return localTelemetryEnvelope({
        traceId:span.spanContext().traceId,spanId:span.spanContext().spanId,parentSpanId:span.parentSpanContext?.spanId,
        name:span.name,kind:span.kind,startTime:span.startTime,endTime:span.endTime,attributes:span.attributes,statusCode:span.status.code
    },service);
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
