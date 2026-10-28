# Safe provider failure diagnostics

The previous foreground adapter replaced every failed SDK result with `Provider request failed`, and the daemon then classified it as `internal`. The GUI consequently showed `executionFailed`. A read-only check of the existing development runtime confirmed this chain; its historical record cannot recover an HTTP status or provider cause that was never persisted. Zero recorded usage is not a billing guarantee or proof that the remote request never started.

The foreground adapter now preserves only a bounded, fixed-vocabulary diagnostic:

- category: authentication, permission, rate limit, quota, model, request, network, timeout, service or unknown;
- HTTP status, when explicitly supplied by the SDK;
- a provider error code from an explicit allowlist;
- a fixed readable explanation and suggested prerequisite for a later retry;
- the adapter phase: before stream creation, failed response, or stream reading.

An adapter phase is not evidence that the server did or did not execute a request. Retry guidance does not enable automatic replay. Failed turns, uncertain inbox entries, cancellation, host guards, and the existing explicit recovery rules remain in place. RPC `retryable` remains false for these failures.

`src/pi/provider-failure.ts` examines bounded SDK error fields and known SDK message formats. It never returns raw messages, bodies, URLs, model/account identifiers, headers, credentials, or error causes. Unrecognized codes are discarded. Getters, object serialization, and unbounded recursive traversal are avoided. Unknown formats remain unknown rather than inventing a diagnosis. The browser decoder independently validates the versioned safe envelope; details disclose only validated metadata.

The handling covers foreground response errors, stream exceptions and exceptions before stream creation. SDK-aborted messages also discard raw diagnostic text while retaining their aborted status. Background summarizer and isolated coding-worker diagnostics are unchanged by this patch.

## Verification, 2026-10-28

The focused run passed 61 checks: 17 new provider-diagnostic tests, 26 existing Pi task/audit tests, nine GUI presentation tests and nine layer checks. The tests cover authentication/permission failures, rate and subscription limits, invalid models/requests, network/timeouts, service errors and unknown errors. Actual Pi sessions use an in-memory faux provider and temporary data, covering all three adapter phases and cancellation. They assert single execution, unchanged task statuses, structured safe details, and absence of synthetic secrets from inbox, turns, items, errors and native session transcripts. TypeScript, GUI ESLint and the GUI build also passed; existing dependency directive warnings remain.

No real OAuth grant, credential read, provider inference, runtime restart, native rebuild or disk cleanup was performed. The running development app still uses its previous bundled backend, so the new diagnostics are not yet active there. After sufficient build space is approved and available, activate the next candidate only when no authentication/task is in progress. A later user-authorized real request can then produce new diagnostic evidence; this patch does not explain the historical failure retroactively.
