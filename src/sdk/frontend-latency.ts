/** Optional local browser trace. No message text, provider data or network export. */
export type DeliveryTiming = { primaryInputId: string; turnId: string; itemId: string; serverAt: number };
type Pending = DeliveryTiming & { receivedAt: number; monotonic: number };
const digest = async (value: string, length = 32) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
export class FrontendLatency {
    private pending = new Map<string, Pending>();
    private records: unknown[] = [];
    private sequence = 0;
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
        const sequence = this.sequence++;
        const generation = this.generation;
        try {
            const [traceId, spanId, parentSpanId, itemHash] = await Promise.all([digest('message:' + p.primaryInputId), digest('frontend:' + p.turnId + ':' + itemId + ':' + sequence, 16), digest('run:' + p.turnId, 16), digest(itemId)]);
            if (generation !== this.generation) return;
            const attr = (key: string, value: string | number) => ({ key: 'pibo.' + key, value: typeof value === 'number' ? { doubleValue: value } : { stringValue: value } });
            const ns = (n: number) => (BigInt(Math.round(n * 1000)) * 1000n).toString();
            const attributes = [attr('itemIdHash',itemHash),attr('receiveToCommitMs',elapsed)];
            if (/^trn_[a-f0-9-]{36}$/.test(p.turnId)) attributes.push(attr('turnId',p.turnId));
            // A cross-clock observation, not a measured one-way network latency.
            if (Number.isFinite(p.serverAt)) attributes.push(attr('serverToReceiveClockDeltaMs',p.receivedAt-p.serverAt));
            this.records.push({ resourceSpans: [{ resource: { attributes: [{ key:'service.name',value:{stringValue:'pibo-client'} }] }, scopeSpans: [{ scope:{name:'pibo.frontend-latency',version:'1'},spans:[{
                traceId,spanId,parentSpanId,name:'frontend.receive_to_commit',kind:1,startTimeUnixNano:ns(p.receivedAt),endTimeUnixNano:ns(endedAt),attributes,status:{code:1}
            }] }] }] });
            if (this.records.length > 256) this.records.shift();
        } catch { /* Missing WebCrypto/diagnostics cannot affect rendering. */ }
    }
    snapshot(): unknown[] { return structuredClone(this.records); }
    clear() { this.generation++; this.pending.clear(); this.records = []; }
}
