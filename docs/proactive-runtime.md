# Persistent proactive runtime and channel messages

Implemented locally on `local-behavior`, 2026-10-13. This extends the existing
Pi coding-agent 1.1.0 integration; it does not replace Pi with a different agent.
The previous real DeepSeek TaskChain/CSV results are archived separately in
`behavior-followup-20261013.md`. New proactive tests and speed calibration are
offline/scripted; they are not new real API results.

## Final peer policy

| Input | While a run is active |
| --- | --- |
| Host user/answer | Existing inference-only preempt, bounded to three per wake by default |
| Ordinary direct peer, priority omitted/false | Queue until the entire run ends |
| Direct peer, priority=true, non-user lane | Steer before the next LLM call; current call continues |
| Direct priority peer, active user lane | Queue until the entire user run ends |
| Explicit group broadcast | Queue; priority ignored |
| Schedule/monitor/research trigger | Queue for idle admission |
| Existing job result | Existing native result admission; does not become a user instruction |

`steer` inserts input before the next LLM call without cancelling the current
call. `queue`/follow-up waits for the whole run. `preempt` cancels the active
sampling attempt. Priority peer uses steer, **not** Grok's original priority
preempt. Already-dispatched ordinary tools, jobs/cells and background summary
requests keep their lifecycles.

The initial envelope defines the lane: user/answer -> user; bot/job -> peer;
schedule/monitor/research/memory -> background. Host user input admitted during
a run upgrades it to protected user for the rest of that run. A job continuation
that starts a new run is a non-user lane; this is not inheritance of user priority.

`send_to_bot({bot_id,text,key,priority?,source_message_id?})` is always direct,
including when it inherits a group channel. `send_to_group({text,key,priority?,
source_message_id?})` explicitly broadcasts to same-channel teammates, excluding
the sender. The model cannot select a new channel or claim user identity. The
host binds source IDs and retains channel/thread/actor/causation. Group priority
is discarded. Reusing a direct key with a different priority/intent is a conflict.

Queue ordering is user, job result, urgent direct peer, ordinary/group peer,
background. Background gets a safe-boundary opportunity after eight foreground
runs by default; this is finite-fixture starvation protection, not a guarantee
under arbitrary non-cooperative tools or infinite arrivals. It never cancels a
run to obtain that opportunity.

## Durable state and uncertainty

Inbox stores received/created, admitted, consumed and resolved timestamps.
Consumption/checkpoints use actual typed inbox bodies in provider context,
never merely a message ID mentioned in the runtime ledger. A successful native
final step checkpoints input resolution; if a later request fails, that
checkpoint survives. A refused first request is not a completion.

`processed`/native input resolution is **not** an independent proof that a user
commitment was fulfilled. Behavior oracles still grade real tool effects,
artifacts and routed send_message output separately.

Unresolved failures remain `uncertain`; they are not replayed automatically.
Host `runtime.reconcileInbox(id, {outcome:'processed', evidence:[outboxId]})`
accepts only delivered output correlated to that exact source/bot/task. The CLI
provides `/reconcile INBOX_ID DELIVERED_OUTBOX_ID`. Requeue/failure is host-only
and needs a review note and evidence; the model has no reconciliation tool.
Delivery to a descendant source does not automatically clear an earlier parent:
that still requires explicit broader reconciliation rather than guessing.

Jobs have attempt, generation and owner. A late execution cannot overwrite a
different/quarantined generation. The existing single-runtime file lock remains;
this is not a distributed lease or cross-process continuation system. Running
jobs interrupted by process death stay uncertain. External delivery that throws
stays uncertain because the sink may have acted before its acknowledgement was
lost. No blind transport retry or exactly-once external-side-effect claim.

## Schedule and monitor

`ProactiveService` lives in the host and uses the existing SQLite store/runtime.
Pi tools are registered by `createProactiveExtension`.

- Schedules: one-shot Unix-millisecond `at`, or fixed elapsed `intervalMs`;
  create/list/cancel, stable fire identity, revision, atomic fire+inbox+next-fire
  commit. Misfire policies are skip, coalesce and bounded catchup. Overlap is
  queue or skip; skipped periods have durable reasons. Default batch cap 32.
- IANA timezone is validated and preserved. It labels the requested schedule;
  interval means elapsed time. Calendar cron/RRULE, wall-clock daily recurrence
  and DST fold selection are **not implemented**; no such coverage is claimed.
- Monitors start disabled. Successful dry-run is required before enable and does
  not consume the production cursor/baseline. Host-allowlisted read-only detectors
  return silent/wake/error. Silent/error does not invoke Pi; error does not advance
  cursor. Event identity deduplicates the same change, including after restart.
  Deadline produces one closure event. Cancel/revision discards late observations.
- Read-only detectors have a cooperative signal and a host observation timeout;
  the host stops waiting after the deadline. It cannot force-stop an arbitrary
  abort-ignoring detector implementation; only host-selected detectors may run.
- The supplied file detector observes `stat` metadata only, not file contents.
  It is a condition detector, not an arbitrary shell/script execution API.

Use the existing configured CLI provider/model. `PI_BOT_PROACTIVE=1 npm start`
enables scheduling tools and the host tick. Optional `PI_BOT_WATCH_FILE=/path`
registers detector name `file`. Without it, monitor creation is denied until
the host registers a detector. No automatic machine wake or cloud service is
installed: the local runtime must be running; persisted due work follows its
misfire policy after restart.

Canceling a trigger invalidates new effects from its old envelopes and descendants;
already-dispatched tools continue. Task replacement/cancellation also applies.
Completed fire receipts, result consumption and user delivery remain separate.

## Background research and memory

`background_work` invokes host-allowlisted workers through durable jobs. Only own
admitted host user/answer evidence is accepted. Candidate generation and an
independent reviewer are separate calls. Source IDs, evidence fingerprint and
memory snapshot version are preserved; invented evidence or withdrawn/changed
sources reject publication/application. Memory writes are deterministic CAS and
idempotent; stale proposals cannot overwrite a newer snapshot.

The model adapter uses the already-configured ModelRuntime, has no tools, and
per job issues at most one generation and one independent review request, each
at most 8192 output tokens including reasoning, high reasoning, zero retries.
The host's default whole-work deadline is 60 seconds and normal job concurrency
and per-task limits also apply. A host can supply a shared before-request budget.
No credential file is read by this adapter. CLI model workers require explicit
`PI_BOT_BACKGROUND_WORK=1` in addition to proactive enablement.

This release's research is **local evidence synthesis**, not web browsing or an
autonomous external research daemon. External tools/network permissions are not
implicitly granted. Approved research writes a result event to the original
bot's inbox; publication still requires send_message. Memory work stays quiet,
and `memory_apply` requires independent approval plus evidence/version checks.
`background_result` marks result consumption independently of execution.
`background_cancel` invalidates late results/application. Denied or interrupted
work remains inspectable; it does not silently disappear or endlessly retry.

## External GUI read-only interface

All actual inbox/outbox envelopes have a unified persistent projection and an
append-only state-change journal, committed in the **same transaction** as the
canonical inbox/outbox write. The projection is rebuildable, not a second
authoritative inbox. It covers user/answer, direct/group peer, job notices,
schedule/monitor/research triggers, and user-directed output. Quiet memory jobs
are persisted as jobs/proposals, not invented channel notifications. Model
reasoning and ordinary internal model text are not channel messages.

Fields include messageId, channelId, conversationId, threadId, sender, recipient,
sourceKind, direction, botId, taskId, causationId, timestamps and status. Local
unrouted conversations use channel `local:BOT_ID`; conversationId defaults to
channelId unless the host supplies it. Outbound intent is pending before the
sink is called; delivered requires sink success. Uncertain remains queryable.
Recognizable accidental credential strings are masked before new channel
persistence, and host credential submissions stay outside this path. This is
not arbitrary-secret detection; callers must use the separate credential broker.

Node/Electron GUI:

```ts
import { ChannelMessageReader } from './src/channel-messages.ts';
const reader = new ChannelMessageReader('/absolute/.pi-bot/runtime.db', {
  channels: ['alpha'], // explicit host-selected scope
});
const first = reader.list({channelId: 'alpha', threadId: 'tasks', limit: 100});
const next = reader.list({channelId: 'alpha', after: first.nextCursor, limit: 100});
const changes = reader.changes({channelId: 'alpha', after: first.changeCursor});
reader.close();
```

`list` orders by stable creation sequence; `changes` orders by journal sequence
and includes state changes to old messages. Cursors are opaque decimal strings;
do not mix list and changes cursors. Each page includes `hasMore`, `nextCursor`
and `changeCursor`. Initial sync retains the **first** page's changeCursor while
reading remaining pages, then drains changes from that cursor. Upsert GUI rows
by `(direction,messageId)` and only accept increasing `revision`; this prevents
late page snapshots overwriting newer changes. Each page/watermark reads one
SQLite snapshot. Scope/channel, conversation, thread, bot and direction filters
are supported; default limit 100, maximum 500. Disallowed channels fail closed.

Other GUI processes can invoke the JSON CLI:

```sh
npm --silent run messages:query -- --db /absolute/.pi-bot/runtime.db --channel alpha --limit 100
npm --silent run messages:query -- --db /absolute/.pi-bot/runtime.db --channel alpha --changes --after 530
```

Reader connections are read-only, expose no mutations and open no network port.
OS filesystem permissions are the local authorization boundary; this is not a
remote authentication service. Start the updated runtime once to migrate an old
database. Existing envelopes backfill their current state; historic transitions
that were never recorded cannot be reconstructed.

## Benchmark and remaining real validation

`npm run benchmark:proactive -- --output NEW_DIRECTORY` runs three bounded
scripted native Pi rounds. Four bots in two groups receive separate envelopes:
16 direct tasks, 16 chatter messages, eight actual send_to_bot peer calls,
four schedule and four monitor fires per round. Native allowlisted jobs compute
and save arithmetic artifacts; job_result and send_message complete tasks.
Each round is bounded to 128 provider attempts and ten seconds; paid requests=0.
The 128 fixture bound is for faux calibration, not the real API's 32-request cap.

The scorer requires an independent exact effective/final-response oracle. Empty
acknowledgements cannot improve speed. It reports user/all-event admission,
first effective response, completion, delivery, job execution, trigger lateness
and result consumption p50/p95/p99 with sample counts. Missing timestamps remain
unknown and missing results remain misses. Precision/recall are finite-fixture
usefulness metrics, not general proactive competence.

Scheduling/recovery uses virtual-clock tests; latency uses actual host elapsed
time. These are host-path calibration numbers, **not real DeepSeek latency**.
New real proactive/response-speed/compaction rounds still need execution using
the previously bounded real evaluation protocol. No new credential extraction
or paid request was performed in this implementation stage. Prior failed real
rounds and their uncertainties are not retrospectively declared passed.

## Pi Durable candidate

Current package/lockfile and installed modules do not include pi-durable; the
coding-agent integration is still 1.1.0. Read-only review of official Pi Durable
at commit `7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6` confirms a separate experimental
Harness with durable submissions, atomic transcript/documents/tasks and committed
GUI views. It could replace some custom admission/checkpoint/watch machinery,
but its extension/tool APIs are not drop-in coding-agent ExtensionAPI adapters.
Its unsafe-tool interruption/safe replay distinction still needs project-specific
outbox/idempotency, route ownership and uncertain reconciliation.

A minimal future spike would adapt SessionFactory and typed envelopes to durable
submissions, implement source-bound tools in its registry, and derive channel
indexes from committed entries. Keep one authoritative state source, then rerun
queue/steer/user protection, tool survival, GUI and crash tests. Calendar triggers,
read-only detectors, evidence review, host lifetime and external delivery remain
host policies. This stage did not install it, execute its examples or migrate.

Primary references: [official README](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/durable/README.md),
[changelog](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/durable/CHANGELOG.md),
[spec](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/durable/docs/spec.md).

## Pi 1.2 upgrade assessment (read-only)

Package.json, lockfile and installed pi-ai/pi-agent-core/pi-coding-agent all remain
1.1.0. No Durable dependency has been added. A coding-agent 1.2 upgrade is a
separate small-version compatibility project, not implicit Durable adoption.
The current background bridge intentionally rejects any coding-agent/codemode
version other than 1.1.0; changing package versions alone would break `npm test`.

Official coding-agent 1.2 notes change idle/start busy semantics and the
before_agent_start event shape for custom-message runs, add tool reachability,
and remove its chord dependency. Current source has no user-prompt-only
before_agent_start handler, but native queue/context timing and private detached
tool bridges must be revalidated. Source review is not a passed upgrade test.

Minimal future check: pin the three direct Pi packages together to 1.2.0 in an
isolated checkout; inspect actual transitive codemode and duplicate dependency
versions; rebase/review every bridge patch against that version rather than
bypassing its guard; run type checks, all queue/steer/user/group and startup-race
tests, native tool/job/cell/summary tests, persistent GUI tests and bounded
benchmarks, then a separately authorized real model round. This stage performed
no installation, version mutation or migration.

Durable's busy display-only immediate commit is a Durable API behavior; upgrading
coding-agent alone does not enable it. Using its committed views/documents/task
checkpoints requires the separate Harness adapter described above. Current host
channel intents already persist immediately even when model processing is queued.

Source: [official coding-agent 1.2 changelog](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/CHANGELOG.md).
