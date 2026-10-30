/** Plain local telemetry wire data. No SDK, context, exporter or I/O dependency. */
export type LocalTelemetrySpan = {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: number;
    startTime: readonly [number, number];
    endTime: readonly [number, number];
    attributes: Readonly<Record<string, unknown>>;
    statusCode: number;
};

const keys = new Set(['elapsedMs','status','messageIdHash','correlationIdHash','tool','outcome','inputTokens','outputTokens','cacheReadTokens','systemPromptCharacters','toolSchemaCharacters','declaredToolCount','declaredToolNames','promptAndToolsChar4Estimate','messageCount','primaryInputIdHash','turnId','itemIdHash','receiveToCommitMs','serverToReceiveClockDeltaMs']);
const names = /^(message\.(queued|admitted)|run\.(start|end)|session\.ready|request\.(pending|resolved)|delivery\.(pending|sending|delivered|uncertain|superseded)|job\.(start|end)|(?:provider|tool)\.(start|first_event|first_content|end)|frontend\.receive_to_commit)$/;
const nanos = ([sec, nano]: readonly [number, number]) => (BigInt(sec) * 1000000000n + BigInt(nano)).toString();

/** Encode the shared local OTLP JSON contract, excluding arbitrary metadata. */
export function localTelemetryEnvelope(span: LocalTelemetrySpan, service: 'pibo-harness'|'pibo-client') {
    if (!names.test(span.name)) return undefined;
    const attributes = Object.entries(span.attributes).filter(([key, value]) => key.startsWith('pibo.') && keys.has(key.slice(5)) && (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value))).map(([key,value]) => ({key,value:typeof value==='number'?{doubleValue:value}:{stringValue:value}}));
    return {resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:service}}]},scopeSpans:[{scope:{name:service==='pibo-harness'?'pibo.local-latency':'pibo.frontend-latency',version:'2'},spans:[{
        traceId:span.traceId,spanId:span.spanId,parentSpanId:span.parentSpanId,
        name:span.name,kind:span.kind+1,startTimeUnixNano:nanos(span.startTime),endTimeUnixNano:nanos(span.endTime),attributes,status:{code:span.statusCode}
    }]}]}]};
}
