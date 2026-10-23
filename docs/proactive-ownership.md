# Monitor and dream ownership

Updated 2026-10-23. A monitor belongs to the bot that created it. A dream uses
its owning bot's evidence/tasks and returns findings to that bot. The first bot
or a bot named primary has no default claim on other bots' triggers.

## Identity and delivery

`botId` and `sourceId` remain the authoritative persistent trigger ownership.
Creation validates a canonical stored source with matching bot/task/route and
requires the bot to exist. Caller-created copies cannot rebind a source to
another bot. An unregistered temporary child/session is not a supported durable
owner; attempts to bind a forged/unregistered source are rejected. This does
not add a permanent child-agent identity system.

Monitor events keep `to: trigger.botId`, original task, replyTo and route.
Dream uses the same schedules/fires/jobs/proposals and its bot's admitted
evidence; cross-bot evidence is refused by the existing evidence checks. Both
use the shared host tick and on-demand execution, not per-bot resident loops.
Cross-bot collaboration must use existing explicit communication. This change
does not transfer a trigger when forwarding a finding and grants no new authority.

The earlier phrase "main agent" means the agent responsible for the receiving
bot/task, not an unconditional global primary. There is no new exclusive speaking
role. Existing inbox → owning agent → send_message → outbox remains available
under the existing task and conversation controls. No notification platform or
APNs transport is introduced.

## Owner unavailable: durable suspension

Before active trigger work (including before its due time on a shared tick),
after detector I/O, and before research generation/review/publication, source
checks validate the original owner. Suspension records a reason and time:

- owner_archived: the original bot/source conversation is archived;
- owner_missing: the original persistent bot is absent;
- source_missing: its source envelope is absent;
- owner_mismatch: a trigger no longer matches its canonical source bot;
- owner_route_changed: the bot can no longer use the original channel route.

Schedules/dreams become paused; monitors keep their existing active/cancelled/
expired state enum but have enabled=false. `suspension` makes this distinct from
an ordinary disabled monitor. Revision advances, old fire descendants are
invalidated, and in-flight proposals for those fires are cancelled. The old
source/bot identity is retained; nothing is silently redirected. The check
happens at the shared tick or another source check, not by installing a new
per-agent watcher or synchronous archive hook.

Suspended entries do not repeatedly run detectors/models or generate repeating
owner errors. Runtime restart preserves their suspension and does not resume
them merely because the bot or conversation has become available again.

An unloaded/idle session with an existing bot and unarchived conversation is
not an orphan. The existing runtime may lazily reopen that same bot/session
when its inbox is ready. A completed foreground turn is not bot termination.
This code does not invent an additional "offline" or "terminated bot" model.

## Explicit recovery and cancellation

- Bot-scoped service methods still verify `owned(botId,id)`; another bot cannot
  resume/cancel a trigger by learning its ID.
- `resumeSchedule` and the added monitor `resumeMonitor`/existing enable path
  revalidate the same canonical bot/source/route/conversation. Restore that owner
  first, then explicitly resume. Resume does not select a replacement bot.
- Monitor resume keeps dry-run and deadline checks. Dream resume keeps worker
  registration, deadline, maxRuns and uncertain-work review requirements. Spent
  slots are not refunded. Pausing does not reopen an already completed ordinary
  one-shot schedule. A last dispatched dream can be suspended while its job is
  still in flight, but a spent final budget cannot be resumed as another run.
- Source task cancellation/replacement retains existing terminal invalidation;
  it is not converted to a recoverable owner pause. Cancelled monitors cannot be
  revived by unarchiving or resuming. Old callback outputs cannot affect the new
  task incarnation.
- Original bot ownership permits explicit cancellation even if its source/bot
  record is unavailable. Cancellation never needs a new source or a new owner.

Authenticated RPC attribution is a separate boundary from the responsible bot.
The host records `ownerFileOwner` from canonical source/ancestry (default local
for local host input). routine/list and routine actions, including dry-run,
resume and cancel, use the connection's trusted fileOwner. A missing source
therefore still permits the recorded client owner to cancel, but cannot resume.
Legacy rows without attribution use conservative canonical ancestry checks.
Trusted host callers may omit fileOwner for administrative operations, preserving
the existing host API; this is not automatic ownership transfer.

Scope: these checks protect routine list/actions. Existing daemon snapshots,
other views and the shared event stream were not redesigned as a multi-tenant
confidentiality system. No broader data-isolation claim is made.

## Verification

New fixtures in test/proactive-owners.test.ts and
 test/proactive-owner-sdk.test.ts cover non-first-bot monitor/dream delivery,
foreign-bot refusal, unregistered/forged bindings, archived owner with late I/O,
persistent pause and explicit same-owner recovery, source/bot/route loss,
shared-bot Alice/Bob RPC control, cancellation after source loss, terminal
one-shot preservation and spent dream budgets. Existing dream/proactive suites
continue to cover repeated ticks, finite admission budget, timeout/cancellation,
foreground progress and restart uncertainty.

All fixtures use local fake detectors/workers; no real monitor source, model,
external notification, credential or system network change is enabled.

Final validation: full `npm test` 382/382 passed with zero failures/skips;
`npm run check` and `git diff --check` passed. Thirteen new ownership fixtures
were added without removing existing business/lifecycle tests. Local ignored
log: `work/owner-lifecycle-final.log`. The release checkout was not edited.
