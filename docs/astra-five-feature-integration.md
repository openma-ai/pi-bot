# Local five-feature integration

This work integrates message reactions, separate model connections, custom
HTTP(S) model endpoints, a simpler connection UI, and standard local OTel.
No real credential migration, login grant, inference, installed-app replacement,
external trace export, release or push was performed.

## Preserved boundaries

- Old provider credentials remain legacy references. New connections use independent
  UUIDs and credential versions. Endpoint edits require fresh authentication.
- Native controls accept only explicit public metadata. Credentials still use the
  runtime-bound secure window. A new read-only native capability reports connection
  protocol version 1; older native clients fail closed for the new controls.
- Settings remain centered at a 940 x 680 CSS-pixel desktop baseline, constrained
  by the viewport. The floating composer and push-away feed status are unchanged.
- Production reaction rendering uses the server-bound viewer identity and stable
  message IDs. No reaction was added to real message history.

## Verified before final integration checks

- Reaction domain/protocol: 8 tests; synthetic browser: 8 interactions and 320px layout.
- Connection isolation and actual SDK/mock transport: 8 tests; legacy settings: 6.
- Connection browser fixture: 19 checks, including same-model different-account
  choices, custom draft validation/cancel, exact login target, Back/Forward,
  narrow/landscape geometry, and fail-closed old native bridge.
- Login/UI unit tests: 14. Standard local OTel tests: 14, including zero network export.
- GUI lint and one complete TypeScript check passed. Final GUI build log ends
  `built in 1m 9s`; Radix use-client directive warnings remain nonfatal.

## Interrupted validation

The Mac executor disconnected. The previous aggregate log contains only two
completed tests; its process is gone, so it is not an aggregate pass. The isolated
Rust policy validator build was interrupted during dependencies. Neither is a
native app verification. Feed-status browser regression stopped before its first
assertion because the CLI timed out; the QA session's close result was uncertain.
The installed development app remains the earlier candidate.

Synthetic local evidence (not uploaded):
`artifacts/model-connections-review/`, and `/tmp/pibo-reaction-qa/`.
Remaining checks and their final results must be recorded below before describing
this integration as fully accepted.

## 2026-10-30 acceptance checkpoint

The root executor read this run's `artifacts/feed-status-final/results.json`: all
89 assertions passed, zero failed, and browser errors were empty. This covers
1100x760, 393x852, 320x568 and 844x390, short/long feeds, idle/running/queued/request
transitions, transparent wrappers, full visibility above the floating capsule,
push-away/return, preserved history position, and no real actions dispatched.
Only the browser CLI timeout changed from 30 to 90 seconds; assertions and
product layout were unchanged. These remain browser fixtures, not native-device
or real-request acceptance.

The two-worker aggregate run was explicitly cancelled (exit 130) after resource
inspection; the replacement retained per-file process isolation with 8 workers.
Its executor subsequently reported a transport disconnect, so no aggregate pass
is established. Rust policy validation uses the unchanged production validator
module with a disabled transport stub and offline dependencies; compilation was
still in dependency work when the interruption occurred. Its result must be
checked before retrying. The installed development app was not changed.


## Recovered execution and aggregate results (2026-10-30)

The detached validation worker completed successfully as an execution mechanism.
Its isolated Rust whitelist test finished **5/5, exit 0**. This compiles the actual
production validator with an offline transport stub; it is not a Tauri app build.

The full 84-file aggregate completed at 3f9d52f: **488 tests, 460 passed, 17
failed, 11 cancelled, exit 1**. Full logs remain at
`artifacts/five-final-validation/aggregate.log`. It must not be described as a
passing aggregate. The SDK bridge dry check reported no pending changes; no
shared dependencies were modified.

Two genuine integration layer violations were fixed without weakening the rules:

- Pi connection errors are now domain errors, translated by the daemon at its
  existing RPC boundary. Explicit reasons and retryability are preserved.
- Daemon and client own their own explicit official OTel providers; only pure
  telemetry wire types and serialization are shared through the protocol layer.

Post-fix layer/connection/OTel regression: **33/33 passed**. Lower-contention
isolated SDK bridge **4/4** and codemode **16/16** passed without changes to their
assertions, timeouts, or production execution semantics. The aggregate also
exposed a desktop mock lacking the lifecycle `close()` method and a 30ms approval
fixture race. The mock is corrected; approval expiry is now tested by advancing
the synchronous fixture clock, preserving production approval policy.

Final results after these fixes are recorded below. The earlier full-repo
TypeScript and GUI lint both completed exit 0, before these final layer changes.


A further read-only review caught the GUI HTTP boundary still recognizing only
`PiBotError`. It now maps explicit connection-domain errors as well, preserving
409/404 and safe messages without exposing arbitrary SDK exceptions or trusting
an error's name string. The domain error lives in a lightweight Pi module, so
error classification does not import the model SDK. Its actual loopback HTTP
fixture covers stale save/remove, missing removal, invalid extra credential
fields, and a spoofed error name. The focused HTTP/RPC/layer selection passed
**9/9**. The earlier serial aggregate was explicitly stopped for this correction;
its partial output is not acceptance. Final runs use
`artifacts/five-final-acceptance/` with one test process at a time and a low-disk
stop threshold. No user processes or installed applications were stopped.
