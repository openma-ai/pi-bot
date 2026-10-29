import { trace, ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { localProvider, BoundedMemoryExporter } from './local-otel.ts';
/** Optional local browser trace. No message text, provider data or network export. */
export type DeliveryTiming = { primaryInputId: string; turnId: string; itemId: string; serverAt: number };
type Pending = DeliveryTiming & { receivedAt: number; monotonic: number };
const digest = async (value: string, length = 32) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
export class FrontendLatency {
    private pending = new Map<string, Pending>();
    private exporter = new BoundedMemoryExporter();
    private provider = localProvider('pibo-client', this.exporter);
    private tracer = this.provider.getTracer('pibo.frontend-latency','2');
    private generation = 0;
    received(value: DeliveryTiming) {
        if (this.pending.has(value.itemId)) return;
        if (this.pending.size >= 256) this.pending.delete(this.pending.keys().next().value!);
        this.pending.set(value.itemId, { primaryInputId: value.primaryInputId, turnId: value.turnId, itemId: value.itemId, serverAt: value.serverAt, receivedAt: Date.now(), monotonic: performance.now() });
    }
    /** Call from the visible message's React layout effect, not store ingestion. */
    async committed(itemId: string) {
        const p = this.pending.get(itemId);
        if (!p) return;
        this.pending.delete(itemId);
        const elapsed = Math.max(0, performance.now() - p.monotonic), endedAt = p.receivedAt + elapsed;
        const generation = this.generation;
        try {
            // A reload/remount must not reuse a previously exported span ID.
            // If secure randomness is unavailable, diagnostics fail closed below.
            const [traceId, parentSpanId, itemHash] = await Promise.all([digest('message:' + p.primaryInputId), digest('run:' + p.turnId, 16), digest(itemId)]);
            if (generation !== this.generation) return;
            // The legacy host IDs deterministically identify its real SDK run span.
            // W3C extraction validates the carrier; it never grants runtime access.
            const carrier = {traceparent:`00-${traceId}-${parentSpanId}-01`};
            const ctx = new W3CTraceContextPropagator().extract(ROOT_CONTEXT,carrier,{get:(c,k)=>c[k as keyof typeof c],keys:c=>Object.keys(c)});
            if(!trace.getSpanContext(ctx))return;
            const span=this.tracer.startSpan('frontend.receive_to_commit',{startTime:p.receivedAt},ctx);
            span.setAttribute('pibo.itemIdHash',itemHash);
            span.setAttribute('pibo.receiveToCommitMs',elapsed);
            if(/^trn_[a-f0-9-]{36}$/.test(p.turnId))span.setAttribute('pibo.turnId',p.turnId);
            if(Number.isFinite(p.serverAt))span.setAttribute('pibo.serverToReceiveClockDeltaMs',p.receivedAt-p.serverAt);
            span.setStatus({code:SpanStatusCode.OK});span.end(endedAt);

        } catch { /* Missing WebCrypto/diagnostics cannot affect rendering. */ }
    }
    snapshot(): unknown[] { return this.exporter.snapshot(); }
    async forceFlush() { await this.provider.forceFlush({timeoutMillis:1000}).catch(()=>{}); }
    async shutdown() { this.clear(); await this.provider.shutdown().catch(()=>{}); }
    clear() { this.generation++; this.pending.clear(); this.exporter.clear(); }
}
