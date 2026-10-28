# Local latency diagnostics

New harness instances record metadata to `diagnostics/latency.otlp.jsonl` beside
their runtime database. This is a local **OTLP/JSON ExportTraceServiceRequest**
journal, not an installed OpenTelemetry SDK or remote exporter. Each line is one
request envelope containing resourceSpans/scopeSpans/spans. Nothing is sent to an
endpoint. It follows the official [OTLP JSON encoding rules](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)
and [trace protobuf fields](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto).
There has been no external Collector roundtrip test.

The 2026-10-28 review retained this journal label: there is no registered OTel
TracerProvider, active Span/Context, propagator, sampler or SDK exporter. Runtime
authorization context is independent and must never be derived from tracing.

Files rotate at 1 MiB, retaining one previous file (2 MiB total), mode 0600.
The diagnostic directory is created mode 0700. Symlink diagnostic files/directories
are refused. An I/O failure disables further writes for that runtime instance and
does not fail, retry, cancel or approve a task. Diagnostic retention does not delete
the runtime database or original execution records.

Correlate spans by traceId, derived from the primary inbox message ID, and the
host-generated turnId attribute. Other IDs are hashed. Points record queue admission,
run start, session readiness, provider attempt start, first SDK stream event, first
content delta, tools, request waiting/resolution and outbox delivery. Full run and
provider spans are emitted on completion with elapsed duration. Start/first-event
markers are separate child spans, so an interrupted process still leaves evidence
of where it reached. A crash does not synthesize a successful completion.
Only explicit `ok`/`completed` endings have OTel OK status. Cancelled, blocked,
interrupted, yielded and uncertain outcomes remain UNSET; explicit failures and
tool timeouts are ERROR. A `running` tool receipt can return successfully while
its background job is still pending: tool success does not mean job success.
Nested SDK tool calls retain their hashed parent tool lineage. Tool/provider IDs
are scoped by run, and frontend span IDs include a cryptographically random
instance nonce so remounts/reloads do not reuse a prior span ID.

`provider.first_event` can be the SDK's synthetic start event; it is **not** a
measured HTTP first byte. `provider.first_content` means the first text, thinking or
tool-argument delta observed from the SDK. Only timing is retained. First visible
reply is distinct from model thinking/tool output. The provider span includes
client adapter/stream consumption time; it cannot separate provider queue time,
network delay and backend inference without additional provider telemetry.

At the actual request boundary, the official Pi transcript replay helpers resolve
system sections and tool additions/removals. Logs contain only system character
count, declared tool count/names, serialized schema character count and message
count. `promptAndToolsChar4Estimate` is `ceil((system characters + schema characters)
/ 4)`: a rough character heuristic, excluding conversation history and provider
serialization, **not exact billed/input tokens**. Actual provider usage, when
returned, is recorded separately. This does not reconstruct an internal codemode
callable registry. No prompt/schema body, message text, tool arguments/results,
raw provider error/body, credential, code or URL is included.

The SDK `FrontendLatency` helper accepts only IDs and timestamps. Call `received`
when a new delivered message event arrives, then `committed` from that visible
message's React layout effect. Its bounded 256-entry memory journal exports the
same OTLP envelope and trace identity. `receiveToCommitMs` uses a monotonic clock.
`serverToReceiveClockDeltaMs` compares different clocks and must not be reported as
precise network latency; React layout commit also does not prove a completed paint.
The GUI wires this through `useDaemon` and the visible conversation's layout effect;
`window.__PIBOT_LOCAL_TRACES__()` returns a copy of the in-memory records. Backend
`delivered` alone does not prove timely browser/native rendering.

The event registry now emits `turn/updated` for running-turn usage/input updates;
only creation emits `turn/started`. Historical repeated `turn/started` events
cannot be used as provider-start boundaries.

Validation: `node --import tsx --test test/local-latency.test.ts
test/codemode-task-source.test.ts test/provider-failure.test.ts`. Synthetic Pi SDK
providers only; no real grants, network inference or changes to a running harness.
Tests check OTLP field/ID/number encoding, correlation, full lifecycle, privacy,
rotation, I/O isolation, frontend commit timing, and retained provider failure
classification. They do not claim production end-to-end latency measurements.

An additional independent wire-format check loaded the four official OTLP trace
`.proto` files using existing protobufjs 7.6.6 and parsed their descriptors with
Python protobuf 7.35.1. Ten generated backend/frontend request envelopes passed
Python parsing and binary serialization roundtrips; six malformed fixtures were
rejected. The adapter restores imports, fully qualified type names and exclusive
message reserved-range ends omitted/misrepresented by protobufjs's descriptor
export. It separately enforces OTLP lowerCamelCase fields and numeric enums, and
validates hex trace/span IDs before converting them to the Base64 representation
expected by the generic Protobuf JSON parser. This checks schema compatibility,
not Collector transport, SDK context propagation or parent causality in real use.
The scripts, exact schema SHA-256 hashes and JSON results are retained in the
local QA artifact directory `pibo-otlp-verify-20261028`.

Reproduce with Node 24 plus the repository's existing `tsx`/`protobufjs`, and
Python 3 with `google.protobuf` available. Supply an official schema checkout
containing the four paths below; the script performs no download and refuses an
existing output directory:

```sh
node --import tsx scripts/verify-local-trace.mjs \
  --schema-dir /path/to/opentelemetry-proto \
  --out-dir /tmp/pibo-otlp-check
```

`preparation.json` records source hashes and the synchronous-write sample;
`validation.json` records parser/negative-case results. The repository's parameterized
scripts were rerun successfully into `pibo-otlp-repro-20261028`. This project's
export check deliberately rejects unknown fields; an OTLP receiver must instead
ignore them for forward compatibility. The official schema files were not copied
into the repository. Verified SHA-256 values, relative to `opentelemetry/proto/`:

| Schema | SHA-256 |
| --- | --- |
| `common/v1/common.proto` | `4c8c143ac8c190544a3d31dcd5719d6fbc943b89037faa1cef6015c76cbdefc1` |
| `resource/v1/resource.proto` | `34fe1c26b8959f09d97656348ae03b105d15a5f07ada0f8f1614ef5dff7d1569` |
| `trace/v1/trace.proto` | `45a33961142210add67d583cc525702fb985afdbae181e6daf2143929bad0613` |
| `collector/trace/v1/trace_service.proto` | `03c8cc4e3e101087d884392d6eda32152ad5cd696e6344f50deaa59804a75c7a` |

Writes still use synchronous file operations. One isolated local 100-write sample
(including encoding/hashing) measured p50 0.073 ms, p95 0.237 ms and max 0.567 ms.
This is a warm-cache synthetic sample, not a production overhead bound; slow/full
storage can distort measured time. No full I/O redesign is included here. Other
remaining gaps are multi-input/job causal links, standard cross-process context,
clock-jump handling and async bounded exporting. A minimal later SDK migration
can use the official [manual Trace SDK](https://github.com/open-telemetry/opentelemetry-js/blob/v3.0.0/packages/sdk-trace/README.md),
AsyncLocalStorage context and a local-only bounded exporter without installing
automatic network instrumentation. No OTel dependencies were installed for this
verification, and no real runtime, credentials or inference were accessed.

## Read-only investigation, 2026-10-28

The running development bundle was inspected without modifying/restarting its
harness or reading credentials. Its `src/daemon/live-pi.ts:69` selects the host
session factory; `src/pi/session-factory.ts:601` supplies our system-prompt override.
These are the inspected bundle's line numbers. In the updated checkout the prompt
is at `src/pi/session-factory.ts:604`, and the production factory options begin at
`src/daemon/live-pi.ts:64`. The template supplies persistent bot identity plus
permission, original-task inheritance, message routing, background-job completion,
waiting and group-conversation rules. Persona and capabilities were not removed.

The runtime DB was opened read-only with `query_only=ON`; only IDs, event timing,
tool names, usage and explicitly authorized structural error classification were
returned. The session path was resolved locally from the bot record and never
included in the evidence. Its JSONL `message` records with `message.role=system`
were replayed using the installed Pi 1.2 SDK's public `getCurrentSystemPrompt` and
`getCurrentTools` functions. Pi stores prompt sections in `sections`, and tool
deltas in `toolsAdded`/`toolsRemoved`; looking only at `content` falsely reports an
empty prompt. No user-message or prompt text was copied into this document.

That session had one system message, a 2,636-character preamble and 170-character
working-directory section. The SDK-rendered prompt was 2,808 characters. Its
current declaration state contained **33 tools**, serialized to 17,843 JSON
characters:

```
codemode, bash, codemode_wait, codemode_read, exec_wait,
schedule_create, schedule_list, schedule_cancel,
monitor_create, monitor_list, monitor_dry_run, monitor_enable, monitor_cancel,
background_work, background_result, background_cancel, memory_apply, memory_read,
request_credential, create_bot, list_bots, group_history, send_to_bot, send_to_group,
file_workspace, publish_file, send_message, ask_user, runtime_state, job_result,
subagent, start_job, context_history
```

The prompt-plus-schema character heuristic is 5,163 tokens; it is not actual
provider tokenization and excludes conversation history. Codemode's own description
was 1,649 characters. Its internal callable-tool registry was not independently
persisted, so 33 must not be presented as the internal codemode tool count. The
provider-specific final wire body was not captured. New request instrumentation
at `src/pi/latency.ts:32` uses the same SDK replay rather than assuming defaults.

In the investigated 30.544-second turn, codemode took 7 ms for `context_history`
and 10 ms for an attempted `send_message`. Both cells actually failed with the
fixed host error `Ambiguous task source; supply source_message_id for the intended
inbox task`, although the wrapper reported `isError=false`. The model subsequently
used direct `send_message`; outbox delivery was observed at 23.910 seconds.
The approximately 6.634 seconds after delivery is run settlement/provider work,
not evidence of browser rendering time. Existing logs cannot isolate network,
provider queue or first-content latency for that historical request.

The source gate in `src/pi/session-factory.ts:221` binds the outer background call
before any JavaScript is executed. A source ID placed only inside a nested call
cannot establish that binding. The strict multi-task check at line 191 remains;
scripts are not parsed to guess authorization. `src/pi/background-codemode.ts:289`
now documents the outer field in its schema and line 300 reinforces this in the
model-facing description. A unique scope retains implicit-source compatibility.

`TaskSourceRequiredError` produces a fixed `taskSourceRequired` code, field
`source_message_id`, and `executed=false`. The background catch at line 399 now
sets `isError=true`; the result view at line 212 also marks retained failed or
persistence-failed cells as errors. This affects the common background wrapper
(codemode and adapted tools such as bash), not just codemode. It changes failure
reporting, not execution permissions, routing, retry policy or call/result pairing.
The four synthetic SDK cases cover nested-only source rejection, correct outer
source execution exactly once, cross-task inner-source rejection and legacy
single-scope compatibility.

## Integration verification and remaining limits

- TypeScript, GUI ESLint, GUI production build and diff whitespace checks passed.
- The core targeted run passed 64 tests. A further 54 checks passed after refreshing
  the stale protocol snapshot and rerunning the isolated HTTP auth check with
  permission to bind an ephemeral loopback port. No real provider was called.
- Real-component browser QA passed 31 request/scroll/input checks at 1100, 393,
  320 and 844 pixels, plus 13 provider/model-effort checks. These are synthetic
  auth, approvals and messages, not native-device or real-login verification.
- The actual macOS development window was read again after the frontend hot
  update: redundant user-message processing text and stale composer interruption
  were absent; the historical failure card remained. The already-running app,
  harness and loopback frontend processes were retained.
- The live harness still uses its earlier bundled backend. Source-binding fixes,
  SDK model-effort metadata and backend OTLP journaling require a later safe
  harness activation; they have only been verified in isolated runtimes here.
  No claim of improved real-provider latency is made.
- The inspected `pwd` approval ended as `expired`, with no response decision;
  a bot's later wording that it was rejected is not proof of a user denial.
- The inspected mixed Chinese/Latin input already contained literal U+0020 spaces
  between the Latin letters. Synthetic composition tests preserve those spaces
  and suppress Enter during composition; a physical macOS IME was not exercised.

The model picker now takes supported thinking levels from the installed Pi SDK,
and the backend rejects unsupported saves. Historical unsupported settings stay
unchanged until the user explicitly chooses a supported level. An old runtime
without capability metadata displays an update requirement instead of guessing
the available levels; the live model settings were not hot-swapped against that
old runtime.

## JavaScript-only development candidate

An independent development app was created from the existing signed development
bundle using native APFS `clonefile` (no full-copy fallback), then refreshed from
the reviewed harness sources. The dependency lock hash, launcher and database
migrations matched. No Rust compilation, credentials copy or production-app
replacement was needed. The reused Mach-O `__TEXT,__text` hash remained unchanged;
the development app was ad-hoc signed again and passed strict/deep verification.

The candidate's real launcher passed isolated ready/missing-model, exclusive-owner,
restart, crash recovery and parent-pipe cleanup tests. Its packaged source and
dependencies also completed a synthetic Pi execution that produced 18 unique spans
in one trace, including two provider attempts and message delivery, without the
synthetic private payload in diagnostics. This was not a paid provider request.

Activation stopped before quitting the old app because the native UI reported
that the Mac was locked and automatic unlock was paused. The old app and harness
remain running; the new backend is not active in the user's session. After manual
unlock, recheck active turns, pending requests and visible authentication before
switching. A scoped frontend update is prepared separately; do not replace native
credential-window code without rebuilding and verifying its matching native API.
