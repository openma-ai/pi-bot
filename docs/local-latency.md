# Local OpenTelemetry tracing

The harness now uses the official OpenTelemetry JS **TracerProvider** and trace
SDK 3.0.0, API 1.10.0, with an instance-local
`AsyncLocalStorageContextManager`. The earlier OTLP-shaped journal alone was
not an SDK. Its bounded local file format remains compatible, but records now
come from SDK `ReadableSpan` objects. The frontend also uses the standard SDK,
with a bounded memory exporter and W3C trace-context extraction.

This is manual tracing. No NodeSDK bootstrap, global provider registration,
resource detector, automatic network instrumentation or remote exporter is
installed. Exporters, sampler, resources and span limits are explicit.
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_EXPORTER`, resource and sampler
environment variables cannot select a remote destination or inject account
information into these providers. No telemetry is uploaded.

## Context and lifecycle

`LocalTrace.withScope(scope, callback)` carries the real run span through async
work. Each runtime owns its context manager; concurrent runs and separate runtime
instances cannot inherit one another's active span. Authorization remains in its
separate runtime context and never depends on trace IDs or traceparent headers.

Run, provider and tool start/end pairs own real SDK spans. Start/first-event/
first-content markers are child spans, preserving evidence before completion.
Nested tool IDs keep their explicit parent lineage. IDs are hashed and scoped by
run. A completed run remains a valid parent for later outbox delivery and frontend
render spans. The trace identity remains derived from the primary input ID for
compatibility with existing event records. `traceparent(scope)` returns the
standard W3C representation; frontend event IDs produce the same verified parent
identity, passed through the W3C propagator before SDK span creation.

Cancellation, interruption, blocked/uncertain outcomes stay UNSET; only confirmed
success is OK and explicit failure is ERROR. `forceFlush()` flushes ended spans.
`shutdown()` ends unfinished spans with a cancelled outcome, flushes, closes the
exporter and disables the context manager; repeated shutdown and subsequent
writes are harmless. At most 512 unfinished spans are retained; saturation ends
the oldest as uncertain rather than allowing unbounded memory growth.

## Retention and privacy

`diagnostics/latency.otlp.jsonl` retains one previous file. Each is at most 1 MiB,
mode 0600, with a 0700 diagnostic directory. Symlink files/directories are
refused. I/O failure disables further export and does not fail or retry a task.
The synchronous bounded exporter has no background send queue. `flush` therefore
has no network or queue dependency. Slow/full local storage remains a possible
measurement overhead; no production overhead bound is claimed.

Only allowlisted span names and metadata fields are serialized. They contain
hashed identifiers, elapsed times, counts, approved tool names and known status
values. Arbitrary exceptions, span events/links, resources, prompt/schema bodies,
message contents, provider responses, arguments, URLs and credential data are
not exported. The host-generated turn ID remains directly searchable.

The frontend holds at most 256 pending receipts and 256 exported spans in memory.
`clear()` invalidates pending asynchronous work. New SDK span IDs prevent reload
collisions. `received()` measures ingestion and `committed()` measures the visible
React layout commit; neither proves a browser paint. Cross-clock
`serverToReceiveClockDeltaMs` is an observation, not precise network latency.
`provider.first_event` may be a synthetic SDK start event; first content is logged
separately. Prompt/tool character counts divided by four remain estimates, not
billed token counts. Tool success may represent a background receipt, not final
job completion.

## Validation

Run:

```sh
node --import tsx --test test/local-latency.test.ts test/standard-otel.test.ts
```

Fixtures cover real SDK construction, asynchronous concurrent parent chains,
W3C frontend correlation, cancellation, idempotent shutdown, flush, rotation,
symlink/I/O isolation, bounded retention, and poisoned OTel environment settings
with zero fetch/export attempts. Pi integration uses a synthetic provider, never
real inference, grants, account credentials or an existing runtime database.
Browser/native acceptance and the repository aggregate suite are separate gates;
focused tests alone do not establish either.

The prior official-protobuf wire-format validation remains reproducible via
`scripts/verify-local-trace.mjs` with an explicit local OpenTelemetry protobuf
checkout; it performs no download. Current output still uses lowerCamelCase,
hex IDs, decimal-string 64-bit times and numeric OTLP enums. This does not claim
an external Collector transport roundtrip.

Official API references used for this implementation:
[manual instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/),
[async context](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/context.md),
and [3.0 TracerProvider](https://github.com/open-telemetry/opentelemetry-js/blob/v3.0.0/packages/sdk-trace/src/TracerProvider.ts).
