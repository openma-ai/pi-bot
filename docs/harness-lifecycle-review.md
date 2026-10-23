# Harness lifecycle slice — 2026-10-23

## Scope and grounding

Fetched `clash-art/draft` branch `docs/personal-agent-harness-context` on
2026-10-23: HEAD remains `32c626e39bb978f36756f5311fee081ccec7307c`
(v4.104). The research distinguishes discovery, authorized execution and user
notification, and asks that new user input invalidate obsolete future work.
This slice closes two concrete gaps in the existing Pi coding-agent extension
and host architecture; it introduces no alternate harness or new service.

Implementation baseline: `d5c5dba19b6ae61fdf8b6a65bc9a22fe3ab23af9`.
Changes live in the independent `feat/harness-lifecycle` worktree. No source or
build output in the active TestFlight worktree was edited.

## Implemented behavior

- A monitor revalidates its source task after detector I/O. Cancellation or
  replacement discards both wake and silent observations, including cursor and
  baseline updates, while independent monitors continue in the same tick.
- A detector crossing its deadline creates the existing deadline closure once,
  instead of publishing a late observation. Deadlines are considered even when
  the next observation time is later. Closure remains an inbox event; it does
  not automatically send a user message.
- Approval requests carry the exact originating message through host jobs,
  background descendants, desktop tools and coding workers. Pending request
  resolution and sweeping inspect that persisted source, rather than the first
  envelope sharing a task ID. A replacement task can obtain its own approval;
  obsolete or missing sources cannot authorize new effects.
- The source ID is an optional additive host API field. Legacy callers work
  when exactly one current source exists; ambiguous tasks must provide
  `sourceMessageId`. Existing configured permission/approval enablement remains
  unchanged. Approval restart behavior remains cancellation, not durable replay.

## Validation

- `npm run check`: passed.
- `git diff --check`: passed.
- Focused nonblocking requests / background bot / proactive / evaluation suites:
  40 passed, 0 failed.
- Full `npm test` with local fixture permissions: 337 passed, 0 failed.
  Log: `work/harness-test-unrestricted.log` (local ignored artifact).
- Restricted full run: 314 passed, 23 failed due to local listener / sandbox
  oracle restrictions. The permitted full run above confirms those paths.
- All six new monitor regressions fail against the original implementation.
  The new replacement-approval regression also fails against the original
  implementation because the replacement cannot obtain an approval.

New tests cover cancel/replace during wake/silent detection, independent monitor
progress, deadline closure and restart deduplication, replacement approval,
chatter while awaiting approval, duplicate approval responses, same-task route
isolation, and missing/mismatched sources. Existing full-suite tests additionally
cover native call/result pairing, live execution identity, completion inbox and
reply routing, and asynchronous compaction overlapping foreground work.

## Remaining boundaries

Task cancellation does not forcibly stop an already-dispatched detector/tool;
a detector returns or reaches the existing timeout before this new check runs.
No automatic rollback of external effects, durable approval resumption, new
notification policy, model-quality evaluation or crash continuation was added.
No paid model, real external message, deployment, push or system network change
was used for validation.
