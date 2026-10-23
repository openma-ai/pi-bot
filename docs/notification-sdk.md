# Notification SDK slice

This is the shared exit for monitor findings and opt-in background research, not
another producer/scheduler. It adds no APNs, native permissions, device tokens,
UI, remote relay, paid-model calls or automatic external delivery.

## Public surface

Browser-safe contracts are exported from `src/sdk/index.ts`: NotificationEntry,
NotificationPreferences, NotificationDelivery and NotificationAdapter. The
host implementation is NotificationService from `src/daemon/index.ts`.

The typed client has four additive methods:

- `client.notification.list({})`: reconcile and list this authenticated owner's entries.
- `client.notification.read({notificationId})`: durable, idempotent human read receipt.
- `client.notification.preferences({})`: read this owner's preferences.
- `client.notification.configure({enabled,timezone,quiet?})`: replace preferences;
  `quiet` uses local startMinute/endMinute (0..1439), including overnight periods.

Owner is assigned by the authenticated transport's existing `fileOwner` identity;
RPC parameters cannot choose another owner. These methods do not introduce a new
account system. Local host inputs without an explicit owner belong to `local`;
ambiguous old remote inputs are not turned into local notifications. Answer
lineage inherits the original host owner; new steer/interrupt preserve it.

No notification payloads enter the existing shared event stream. This slice is
list/read based; `events/ack` remains a transport cursor, never a human read.
No new GUI notification center is included.

## Producer and consumer boundaries

`reconcile()` deterministically projects canonical pending requests and failed/
uncertain inbox items into action-required or important-change entries. Repeated
reconcile, restart and reused task IDs do not duplicate the same source/reference.
An entry contains generic summary text and canonical IDs; it never copies raw
results, tool arguments, approval fields or credentials into an adapter payload.

Job completion, routine firing, research proposal approval and turn completion
alone do **not** create a task-completion notice. The main assistant must first
inspect a discovery and commit a user result through the existing outbox. After
host verification, use `publishResult(outboxId, 'completion'|'important_change')`.
This host-only method is deliberately absent from the RPC/model surface: it is
a host assertion that verification happened, not an automatic semantic grader.

When committing a final result and selecting a notification together, use the
existing SQLite transaction boundary so both intents roll back or commit:

```ts
runtime.store.transaction(() => {
    const result = runtime.sendMessage(originalSource, verifiedText, stableResultKey);
    notifications.publishResult(result.id, 'important_change');
});
```

Monitor/research retain their existing source/task ancestry and inbox delivery.
NotificationService cannot start research, poll conditions, approve a request or
execute a business tool. `read()` does not approve/answer a pending request.

## Delivery opt-in and semantics

The daemon creates a service without an adapter. Preferences default to disabled.
There is no added polling/sending timer. A host must explicitly install a local
adapter, enable the intended owner and call `flush()`:

```ts
const notifications = new NotificationService(runtime, {
    adapter: {
        id: 'host-selected-channel',
        async deliver(payload, signal) {
            // Host-selected implementation: payload has owner/route IDs, no token.
            // Return retry only if the attempt DEFINITELY was not accepted.
            return { status: 'accepted' };
        },
    },
});
notifications.setPreferences(ownerId, { enabled: true, timezone: 'Asia/Shanghai' });
await notifications.flush(); // explicit drain; fixture adapters need no network
```

The adapter contract returns `accepted`, `retry` (definitive non-acceptance,
optional retryAfterMs) or `failed`. An exception, malformed acknowledgement or
attempt timeout becomes `uncertain`, not an automatic resend. Stable
idempotencyKey is the entry ID; it helps an adapter deduplicate but does not
promise exactly-once delivery by an external system.

Entry `status` (active/read/superseded/resolved/expired) is independent of
`delivery.state`. A late accepted acknowledgement after cancellation/read retains
the acceptance fact and the newer status. Adapter acceptance means neither that
the user saw a banner nor that the original business task succeeded.

- Before every attempt/retry, refresh canonical source cancellation/replacement,
  trigger invalidation, request resolution, expiry and human read state.
- Action-required entries precede ordinary results. Both respect quiet hours;
  no urgency bypass or Critical Alert behavior is introduced.
- Quiet hours use IANA timezone and real-instant iteration across DST changes.
  Changing preferences re-evaluates quiet-deferred entries immediately.
- At most 32 claims per explicit drain, 3 attempts by default (host cap 1..10),
  bounded exponential retry delay; default per-attempt timeout 10 seconds,
  host maximum 60 seconds. No unbounded worker loop or model request is added.
- Parallel drains and service instances use transactional state claims and an
  attempt ID. In-flight sends are not taken over. On runtime recovery, sending
  becomes uncertain; it is never automatically replayed.
- Each entry is bound to the first adapter channel ID used. Changing adapters
  does not silently resend old entries. This slice does not implement per-device
  fanout, transport migration, manual uncertain reconciliation or lease takeover.
- Already-dispatched effects may complete after a cancel. There is no claimed
  recall of externally accepted notifications. Never rely on old payloads to
  authorize actions; a future native client must fetch current state on open.
- Await a drain before closing its runtime/store. A non-cooperative adapter may
  continue after timeout; its late result cannot rewrite the persisted uncertain
  entry. Host adapter code owns any actual external request and its cancellation.

## Persistence and compatibility

Only `notification_entries` and `notification_preferences` are added to the
existing Store. Canonical inbox/outbox/requests remain authoritative; notification
entries are decisions/delivery receipts referencing them, not parallel tasks.
Request/review projections can be reconstructed from current canonical records;
no replay cursor is required and no historical resolved requests are invented.
Final-result selection is durable in the transaction above; it is never guessed
from all historical outbox messages after restart.

Existing Pi package pins, activation/queue policy and conversation outbox delivery
are unchanged. The additive SDK methods do not enable external sending, native
push or automatic dream. Deduplication is exact-source/reference based; semantic
merging across multiple findings, daily digests, cross-device presence suppression
and notification retention are intentionally outside this slice.

## Fixture evidence

`test/notifications.test.ts` covers host result selection, atomic rollback,
job/discovery versus final-result separation, original owner ancestry, disabled
sending, restart deduplication, read without approval, cancel/replace before retry,
parallel claims, late acknowledgement, retry budget, timeout/throw/interruption
uncertainty, DST quiet periods, expiry and monitor/research sharing one exit.
`test/notification-sdk.test.ts` exercises the real typed in-process SDK, owner
spoofing/isolation, durable preferences/read state, answer/steer/interrupt lineage
and absence of shared notification payload broadcasts.

These are local fake-adapter proofs, not APNs or real-model quality claims.
