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
