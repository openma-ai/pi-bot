# Proactive results use the existing reply path

Updated 2026-10-23 after user clarification: an agent reply is the user-facing
notification. There is one message fact and one public reply path.

```
monitor condition → monitor inbox ─┐
                                 ├→ owning bot agent selects / remains silent
bounded dream → research inbox ──┘                 ↓
                                        existing send_message
                                                   ↓
                                          canonical outbox
                                                   ↓
                                        existing channel delivery
```

## Removed duplication

The experimental notification SDK from 61a0e46 added generic notification
summaries, status/read/preference policy, an adapter ledger and four public
notification/* methods beside outbox. Its producers did not directly send, but
the extra user-facing center and host publishResult decision were unnecessary.
They have been removed rather than made into another policy layer.

No NotificationService, NotificationAdapter, notification-center schema,
notification/* RPC namespace or notification tables are created by the current
code. Previously created experimental tables are not dropped or rewritten; they
are unused, not resumed as an external delivery queue. Existing user/agent
messages, requests, jobs, proposals, trigger/fire records and owner fixes remain.
The existing protocol notifications (RPC events) and GUI operation Toast are
unrelated existing facilities and remain unchanged.

## Retained lifecycle and message authority

- Monitors use existing persistent definitions/cursor/fire deduplication; dreams
  use the existing bounded schedule/job/proposal lifecycle. No new scheduler.
- Discoveries enter the original bot/task inbox. A reviewed research candidate
  is data for the owning bot agent, not a user reply or automatic delivery instruction.
- The owning bot agent decides whether/how to speak and uses the existing send_message
  tool. Internal final model text does not become a channel message on its own.
  Host tests use runtime.sendMessage as the corresponding host adapter operation.
- No agent reply means no outbox row and no user-directed delivery. Pending
  approval/question/credential forms remain in their existing request mechanism;
  reading a result never approves or answers them.
- Source/task/route lineage remains attached; cancel/replace/trigger invalidation
  prevents later stale actions and pending delivery. Already dispatched effects
  may finish; the runtime does not promise external rollback.
- Repeated event identity/tick/activation does not create a new discovery.
  Repeating the same send_message key returns the existing canonical outbox row;
  delivered rows are not sent again. This is stable-key/idempotent transport
  behavior, not a claim that arbitrary model responses with different keys have
  semantic exactly-once deduplication.
- Existing outbox states retain their meaning: message commitment, transport
  delivery and uncertain side effects remain distinct. No separate notification
  acceptance/read state is added.

## Future native push

If APNs is later authorized, it can remind the user of an existing canonical
outbox/message ID. It must not create a second reply body, infer completion from
a job receipt, let a producer bypass the owning bot agent, or re-execute a business
operation on retry. Any minimal transport receipt is keyed by that message and
destination. Native presentation can choose a private preview, but the original
message remains the only conversation fact. Cancellation/read/privacy policy
belongs to that existing message-delivery boundary and a future scoped design,
not an independent notification producer or public content API.

No APNs transport, device token, new permission or real outbound effect is enabled.

## Fixture validation

- test/proactive-replies.test.ts: local lifecycle, silent main, canonical reply,
  duplicate wake/restart and cancel/replace behavior.
- test/proactive-reply-sdk.test.ts: real native Pi/faux provider for both producer
  paths, silent main versus send_message, same-key duplicate calls, one delivery,
  removed public API and non-destructive old-database opening.
- test/dream-sdk.test.ts: typed daemon monitor and opt-in dream paths now assert
  existing outbox/reply behavior without a parallel notification SDK.

All tests use local workers/sinks/providers. No real model or external notification
is used. The existing read-only/background budgets and permissions remain.

Final validation: full `npm test` 369/369 passed, zero failures/skips;
`npm run check` and `git diff --check` passed. Local ignored log:
`work/single-reply-final.log`. The prior experimental notification-only tests
were removed with their implementation; original business/lifecycle tests remain.

Ownership clarification: the receiving/owning bot agent is not automatically a
global primary. No primary-only speech restriction is added. Monitor/dream owner
suspension and explicit recovery are documented in [ownership](proactive-ownership.md).
