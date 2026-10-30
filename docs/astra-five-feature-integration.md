# Local five-feature integration — 2026-10-30

Code is integrated on `publish/astra-oauth-wip`, through `56d0f3d`.
**Full acceptance is not green:** the final aggregate has three timing-related
non-passing tests. The original development app was not replaced.

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
