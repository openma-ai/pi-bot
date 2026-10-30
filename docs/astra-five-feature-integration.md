# Local five-feature integration — 2026-10-30

Code is integrated on `publish/astra-oauth-wip`, through `56d0f3d`.
**All three previously non-passing checks are now resolved by original-limit,
isolated reruns.** The earlier 491-test aggregate result is preserved below; a
new complete aggregate was not run in this follow-up. The original development
app was not replaced.

## Included work

- Durable original-message reactions, authenticated actor binding, agent/SDK
  operations and UI. See [message reactions](message-reactions.md).
- Independent provider connections, account-scoped models/sessions/refresh/logout,
  metadata-only versioned migration, and custom endpoint GUI. Endpoint changes
  invalidate credential binding rather than forward an existing credential.
  See [model connections](model-connections.md).
- Simplified connection summaries and provider picker; fixed centered 940 × 680
  desktop Settings with viewport constraints and internal scrolling.
- Standard local OTel SDK providers/context and bounded local exporters. Daemon
  and client own their SDK lifecycles and share only a pure OTLP wire contract.
  No environment-driven remote exporter, payload logging or global provider.
- Transparent floating composer and backgroundless push-away Running state are
  preserved. Native connection metadata remains explicitly allowlisted; older
  native bridges fail closed for the new controls.

## Integration fixes found during acceptance

- Removed Pi → daemon and daemon → SDK implementation dependencies without
  relaxing architecture rules. Connection errors live in a lightweight Pi module.
- Preserved connection error reasons/retryability at RPC boundaries and 409/404
  statuses at the GUI HTTP boundary. Unknown exceptions and spoofed error names
  still produce generic public errors. The new loopback fixture verifies stale
  save/remove, missing removal, invalid credential fields and redaction.
- Corrected an incomplete desktop test double (`close` and `assertAvailable`).
  Approval expiry now advances only a synchronous fixture clock, removing its
  former 30ms scheduling race without changing production policy.

## Final verification

The final serial run used the product source committed in `56d0f3d`. Logs are
local ignored artifacts under `artifacts/five-final-acceptance/`.

| Check | Actual result |
| --- | --- |
| All 84 test files, process isolation, concurrency 1 | **491 total; 488 passed, 2 failed, 1 cancelled; exit 1** |
| Full TypeScript `npm run check` | Passed, exit 0 |
| GUI lint `npm run gui:check` | Passed, exit 0 |
| GUI production build `npm run gui:build` | Passed, exit 0; built in 6.42s; nonfatal dependency directive warnings |
| Production Rust security whitelist module in isolated offline crate | **5/5 passed**; not a full Tauri app build |
| Feed/browser state and geometry matrix | **89/89 passed**, zero browser errors |
| Reaction browser fixture | 8 interactions plus 320px geometry passed |
| Connection browser fixture | **19/19 passed** |
| Login/UI units | **14/14 passed** |
| Layer + connection + OTel focused run after initial layer fix | **33/33 passed** |
| Final HTTP/RPC/layer selected regression | **9/9 passed** |

The browser matrix covers 1100×760, 393×852, 320×568 and 844×390, short/long feeds,
idle/running/queued/request transitions, transparent wrappers, push-away/return,
last-message visibility, preserved history scroll and no real actions dispatched.
Connection fixtures cover cancellation, duplicate saves, Back/Forward, exact
account targeting, endpoint validation and old-bridge failure. They are synthetic
browser validation, not native-device or real-account acceptance.

## Three remaining timing failures

1. `background-bot.test.ts`, reply variant: did not reach the scoped tool wait
   within its 3-second poll. The same file passed the earlier isolated run.
2. `proactive-benchmark.test.ts`: the original 10-second lifetime ended with
   5 of 24 tasks complete (expected 24).
3. `stdio.test.ts`: its 10-second total test limit expired.

Controlled diagnostics used ignored copies only; production code and original
test limits were not altered. **These diagnostics do not count as original tests
passing.** With an explicitly extended diagnostic deadline:

- stdio handshake took **19,382ms**; the original durable-turn/delivery assertions
  then completed in **100ms** (19,482ms total).
- the identical scripted benchmark finished **24/24 in 16,751ms**, with zero
  artifact failures, native tool errors, runtime errors, pending work or paid
  requests.

These observations locate the timing failures but do not establish low-load
performance or prove CPU contention is the only cause. The Mac had sustained
high Chrome CPU use; no user processes were stopped. A controlled low-load rerun
of the original three tests remains necessary before calling acceptance green.
The final aggregate itself was completed, not abandoned or represented by a
focused subset.

## Original-limit isolated rerun (later on 2026-10-30)

At `c9c0a34`, with a clean worktree and no old QA workers still running, the
three remaining cases were run sequentially. No build ran alongside them, and
no source, test timeout, process-isolation setting or production limit changed.

| Original test | Strict rerun result |
| --- | --- |
| background reply, original 3-second scoped-ready poll | **Passed**, 2,095ms test duration |
| proactive benchmark, original 10-second lifetime | **Failed**, 20/24 complete |
| stdio, original 10-second total test timeout | **Timed out** |

This clears the background case in isolation; it does **not** rewrite the prior
full aggregate result as 489/491 or constitute another full-suite pass.

A controlled comparison extracted only 1,295,734 bytes of tracked source/tests
from the pre-five-feature commit `4b36b080dde8c9b32e3737b096b7e0570573dc3a`
into a fresh `/tmp/pibo-before-five-*` directory. It reused the same installed
SDK dependencies, and copied no runtime data or credentials. Both test files and
the benchmark implementation were byte-identical to the current versions.
With the original limits and sequential process isolation, that baseline also
failed: benchmark **19/24**, stdio **10-second timeout**. This is evidence against
a failure specific to the five new features, not proof that every performance
issue is caused by the environment.

Resource evidence was recorded after all these QA workers exited: this 12-CPU
Mac had ten Chrome helper processes consuming approximately **910.9% CPU**
(about 9.1 cores), grouped under browser parent PIDs **8568 and 58072**. Available
disk was approximately **789MiB**. No user app/browser/harness was stopped and no
files were cleaned. Low system load could not be established within the current
authorization, so the remaining two performance gates are still unverified.

Minimal next user action: provide a low-load window by pausing or closing the
unneeded high-CPU Chrome pages/windows themselves, then rerun only these two
original tests. No credential action, timeout increase, app replacement or disk
cleanup is required for that next check.

Evidence: `artifacts/three-original-retests/status.json`, the three original
logs, `baseline-status.json`, baseline logs, `baseline-location.json` and
`resource-check.json`. All processes started for this rerun were confirmed exited.
No product source changed in this follow-up; prior TS/lint/build/Rust/UI evidence
therefore still applies to the same product code.

## Final closure after identifying task-owned QA load

After the user closed their Chrome pages, the same two high-CPU browser groups
remained. A read-only ownership check established that they were **old Pibo QA
sessions**, not the user's ordinary browser pages:

| Session | agent-browser daemon | Chrome parent | Confirmed launch directory |
| --- | --- | --- | --- |
| `pibo-isolated-review` | 8567 | 8568 | original 2026-10-25 Codex task |
| `pibo-logo-qa` | 58071 | 58072 | original `pibo-menu-review` checkout |

The mappings came from the CLI's numeric PID metadata and the OS parent chain
and working directories. Page-origin queries timed out; no page body, account
data, URL query/fragment or credentials were read. The earlier attribution to
general Chrome/user-page load was incomplete. Both completed task-owned sessions
were closed using their named `agent-browser ... close` command. Both commands
succeeded, and the browser/daemon PIDs were confirmed absent. The user's original
Pibo app and harness (11244/11263) remained running. No unrelated program or file
was stopped or removed.

At product source unchanged from `6ec51a9`, the final two tests then ran
**sequentially, without any concurrent build, original 10-second limits and
original per-file process isolation**:

| Test | Final original-limit result | Total runner duration |
| --- | --- | --- |
| proactive benchmark | **Passed, 1,477ms**; original complete-work assertions intact | 3,323ms |
| stdio handshake, durable turn and delivery | **Passed, 1,383ms** | 1,600ms |

Both exited 0, with no failures/cancellations/skips. Combined with the earlier
2,095ms strict background-reply pass, no previously failed case remains open.
This does not rewrite the old aggregate report or claim a new 491/491 full run.
No product/test source, timeout, credentials, app bundle or dependency changed;
the previous type/lint/build/Rust/browser results still apply.

Final evidence: `artifacts/two-after-qa-close/status.json`,
`proactive-benchmark.log`, `stdio.log` and `resources-before.json`. Available disk
was about 2.5GiB; no cleanup or build was needed for these reruns.

## Evidence and operating boundaries

- `artifacts/five-final-acceptance/acceptance-status.json`: bounded worker exits.
- `artifacts/five-final-acceptance/aggregate-serial.log`: final full failures.
- `artifacts/five-final-acceptance/diagnostic-status.json` and diagnostic logs/JSON:
  explicit extended-deadline controls.
- `artifacts/five-final-validation/rust-policy.log`: 5 production-validator tests.
- `artifacts/feed-status-final/`: 89 assertions and synthetic screenshots.
- `artifacts/model-connections-review/` and `/tmp/pibo-reaction-qa/`: synthetic UI
  results/screenshots. No real-chat or account screenshot was uploaded.

An earlier 8-worker aggregate finished 460/488 with 17 failures and 11 cancelled;
its logs remain in `artifacts/five-final-validation/`. A subsequent serial attempt
was explicitly cancelled for the HTTP boundary correction, before the final
complete run above. The SDK bridge dry check found no pending patch; shared
original-checkout dependencies were not modified.

No push, release, main merge, real login/inference, credential migration,
installed-app replacement, extra file cleanup or network/security setting change
was performed. The completed `pibo-feed-state` synthetic QA browser was closed.
The old development app/harness PIDs 11244/11263 were confirmed running at the end.
Free disk was approximately **413MiB**; no native rebuild or extra cleanup was
attempted. Recheck disk/processes and existing log results before any future run.
