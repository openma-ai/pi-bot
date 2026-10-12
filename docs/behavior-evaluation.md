# Local behavioral evaluation — 2026-10-12

Repository: `/Users/xiaoyang/Documents/Codex/2026-10-12/task-2/pi-bot`.
Base main `63eed5d84fe83eb73afe2f96e53f1882e6756a11`; draft PR #2
`4145b95bbb69f1c12c1a3530b73c37c72cb13a09`. Fresh clean checkout;
local uncommitted branch `local-behavior`; no push, merge or deployment.

## Run the usable local runner

```
npm run evaluate -- --dry-run
npm run evaluate -- --report docs/scripted-evaluation-result.json
npm run check
npm test
```

The runner schedules separate incoming messages while native Pi is running;
it does not concatenate a flood into a single prompt. Three custom scenarios:

| Scenario | Scheduled user messages | Expected commitments |
|---|---:|---:|
| Overlapping tasks, isolated group channels and chatter | 11 | 3 |
| Explicit replacement, cancellation and chatter | 10 | 1 |
| Same-channel bot handoff and unrelated group silence | 2 | 1 |

Two simulated channels have distinct members and separate coordinator/worker
bot sessions. Membership checks apply at ingress. Task ownership blocks another
member's cancellation. Same actor/key/task in two channels is isolated. Bots see
only same-channel teammates; cross-channel handoff rejects. Route channel,
thread and original actor are inherited through jobs and bot handoffs; models
cannot choose a new output channel. Delivery validates the route again. This is
an actual local simulated transport, not just sender labels; it is not a Slack,
Discord, or other external chat integration.

Observable isolated `commit_record` tool effects, completed native jobs and
routed final send_message delivery are graded against deterministic expected
outcomes. Receipts alone do not count. Missing tasks, duplicate tool effects or
replies, wrong destination/thread/actor, obsolete records, and chatter replies
fail. The report also records unprocessed/uncertain events, runtime error counts,
and native transcript tool/result matching. A negative-oracle test deliberately
introduces failures to verify the scorer rejects them.

`scripted-evaluation-result.json` is the saved scripted runner validation:
5/5 commitments; 0 misses, duplicates, wrong recipients or obsolete actions;
appropriate silence in all 3 scenarios; 0 pending/errors; valid tool pairs.
The provider decisions are scripted using Pi's own faux provider. The real
inbound/runtime/native tool/job/result/outbox path is used. These numbers verify
runner and routing behavior, not real-model competence or production robustness.

## Cancellation and overload review

Only an active provider request gets a child cancellation signal. Agent/session
abort is never called for new input. At message_end the child controller is
removed before native tools execute, so ordinary already-dispatched tools and
independent jobs retain their original signals. A whole tool batch is not
cancelled by new input. Tests hold a native tool hook in a two-tool batch and a
separate slow job while new input arrives; both complete with paired results.

At most 3 inference preemptions per wake prevent endless cancellation under
sustained input. All queued messages enter the next provider boundary together;
request budgets remain bounded. A 21-message sustained-input test confirms 3
preemptions and complete event consumption. This establishes finite-fixture
progress, not guaranteed responsiveness under infinite or hostile traffic.

The scheduled runner exposed a real Pi prompt race during native settlement:
`prompt(..., streamingBehavior: steer)` could see isStreaming false while the
agent still owned its run. The adapter now uses explicit `session.steer` and
tracks which inbox IDs actually reached a provider boundary. Arrivals after the
last queue check remain durable queued work; receipts are not falsely processed.
Unadmitted initial events become uncertain rather than being retried forever.

Host-declared replace/cancel controls invalidate new actions from old source
messages and descendant bot/job events. Already-dispatched tools keep running.
Pending stale user replies are marked superseded before transport delivery.
An external sink already started cannot be unsent; semantic correction detection
from plain free text still belongs to the model/real transport adapter. The
simulated runner supplies explicit controls alongside the natural-language text.

Background prefix compaction remains the PR #2 native boundary design. Summary
ready while idle is adopted at the next safe native boundary, never by mutating
a transcript mid-request or creating a foreground request. Dedicated regression
confirms this. Hard overflow still fails without foreground summarization or
waiting for a background summary. Background summaries are explicitly disabled
in the capped real smoke to prevent unbudgeted paid summary requests. Therefore
that real smoke does not measure the behavioral impact of background compaction.
A separate fake-provider flood regression verifies summary survival through
preempt, stable-prefix exclusion of late corrections and next-boundary adoption.

## Real provider mode — prepared, no paid request executed

```
# Review this now; does not request a credential or call a provider:
npm run evaluate -- --dry-run --model deepseek-v4-flash

# Only AFTER exact provider/model/budget approval; run in your own Terminal app:
npm run evaluate -- --real --approved-budget --model deepseek-v4-flash --report /tmp/pi-bot-real-smoke.json
```

Open macOS Terminal yourself, run `cd /Users/xiaoyang/Documents/Codex/2026-10-12/task-2/pi-bot`, then run the approved command above. Do not use an agent-owned PTY: the user must control the terminal and type directly.

The user enters the key directly into a non-echoing terminal. No key argument,
environment import, DSH credential import, or persistent auth file is used.
The host broker binds one-use entry to the smoke run/provider; only the trusted
inference runtime holds it in memory for the run, then deletes it. Provider
errors and traces are sanitized; reports retain fixed fixture effects, routes,
metrics and counters, not raw provider output. Native temporary transcripts and
SQLite files are removed at completion. No external side effects are available.

Capped initial smoke: **3 scenarios, 23 scheduled incoming messages, 5 expected
tasks; at most 32 total provider requests; at most 384,000 conservative input
reservations; 1,024 output tokens per request (32,768 total); 90-second overall
deadline; zero automatic transport/agent retries; no background summaries**.
The request guard reserves before dispatch and refuses at a cap; budget exhaustion
is reported as incomplete work, not a successful score. Byte-based input
reservations include 1,024 tokens/request for protocol framing; they are not exact
provider tokenization. The deadline cancels cooperative provider requests; an
abort-ignoring provider can delay shutdown because the runtime preserves a single
foreground request and does not kill already-started tools.

Official DeepSeek peak Flash pricing retrieved 2026-10-12 is $0.30/M uncached
input and $1.20/M output. The conservative reservation bound is
`384000*0.30/1e6 + 32768*1.20/1e6 = $0.1545216`.
Ask approval for a **$0.20 ceiling**. Cached/off-peak usage may cost less.
An independent reviewer found and confirmed a fix for default thinking mode:
this smoke explicitly sends `thinking: {type: "disabled"}`. A mocked-fetch
wire test exercises the installed OpenAI-compatible adapter and verifies
`https://api.deepseek.com/chat/completions`, requested Flash alias and 1024 output
cap; it does not test live API acceptance. Thinking control documentation:
https://api-docs.deepseek.com/guides/thinking_mode/

Recheck official pricing before actual launch; this estimate is not a provider
billing guarantee. Pro is blocked in the CLI pending a separate pricing plan.
Sources: https://api-docs.deepseek.com/quick_start/pricing/
and https://api-docs.deepseek.com/ (legacy deepseek-v4-flash now aliases Flash).

Necessary read-only DSH inspection: credential presence true, inherited Pi
credential presence false; selected settings model `deepseek-v4-flash`.
DSH source provider route is `deepseek-official`; catalog IDs also include
`deepseek-v4-pro` and `deepseek-v4-flash-vision-exp`. Source public default hostname
is `api.deepseek.com`. No configured base-URL override was found in inspected
profile/settings metadata; active effective hostname is not verified.
**No documented existing DSH-provider-to-Pi authentication reuse path was
verified.** Detection is not permission to export credentials. No value was
printed, copied, exported, persisted or sent to a model. No chat/session files
were read. This runner exercises Pi, never silently substitutes DSH.

## ARE / Gaia2 investigation

Read upstream README and gaia2-cli README on 2026-10-12:
https://github.com/facebookresearch/meta-agents-research-environments
https://github.com/facebookresearch/meta-agents-research-environments/tree/main/gaia2-cli

ARE supplies dynamic scenarios. Gaia2 CLI supplies container runtimes, shared
HTTP contract, oracle grading and traces; its documented ready-made runtimes
are Hermes, OpenClaw and Oracle. A ready Pi adapter or dense-chat-flood suite was
not verified. No ARE installation, containers, scripts or dataset execution.
Future reuse should translate scheduled events into native accept envelopes and
native jobs/tools into environment effects, preserving task/route correlation.
The current runner is clearly labelled custom, not a Gaia2 result.

## Verification

Lockfile installation used `npm ci --ignore-scripts` (no lifecycle scripts).
TypeScript check passed. Local suite: **63 tests, 63 pass, 0 failures/cancelled/
skipped**. Hidden terminal also exercised with a fake secret in a real PTY:
completed, input not echoed, process exited 0. `git diff --check` passed.
Real API/tool compatibility and real-model scores remain untested pending approval.
