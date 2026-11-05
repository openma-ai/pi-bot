/**
 * Reverse calls: the daemon (bot side) calls capabilities that live on a client
 * device (shell, files, computer use, browser...). Engine-agnostic: nothing here
 * knows about Pi or any other harness.
 *
 * Transport = the daemon's own HTTP API, so it works unchanged on loopback and
 * inside the E2E relay tunnel:
 *   GET  /client-calls/attach?after=<seq>&caps=<m1,m2>   NDJSON stream of HubFrame
 *   POST /client-calls/rpc   ClientPost                  acks + results
 *
 * Reliability (design borrowed from Cindy's device-link reliable-transport-v1,
 * Apache-2.0; no code copied):
 *  - every call frame has a per-client monotonically increasing `seq`;
 *  - the client ACKs cumulatively once a handler has *accepted* the call
 *    (not when it finished), so slow handlers never look like a dead link;
 *  - unacked frames are replayed when the client re-attaches with `after`;
 *  - `id` (requestId) is the idempotency key on both sides: the client never
 *    runs the same id twice and re-sends its cached result; the hub keeps the
 *    first result only;
 *  - bounded buffers: when a client's unacked window is full a new call fails
 *    fast with BACKPRESSURE (it was never sent, so retrying is safe).
 *
 * TIMEOUT IS NOT CANCELLATION. A `timeout` outcome means the hub stopped waiting;
 * the client may still have executed (or still be executing) the call. Callers
 * must treat side effects as `unknown` and must not blindly retry mutations.
 */
export const CLIENT_CALL_PROTOCOL = 1;

export const CLIENT_CALL_LIMITS = {
    /** Max unacked call frames per client. */
    maxUnacked: 64,
    /** Max bytes of unacked call frames per client. */
    maxUnackedBytes: 4 * 1024 * 1024,
    /** Max single call frame (params) size. */
    maxFrameBytes: 1024 * 1024,
    /** Calls waiting for a not-yet-seen client (presence `unknown`). */
    maxWaiting: 32,
    /** Results remembered for dedupe. */
    resultCache: 256,
    defaultTimeoutMs: 30_000,
    pingMs: 15_000
} as const;

/**
 * Presence is tri-state. `unknown` = this hub generation has not heard from the
 * client yet (calls wait, bounded); `offline` = it was attached and its stream
 * ended (calls fail fast with DEVICE_OFFLINE); `online` = attached now.
 */
export type ClientPresence = 'unknown' | 'online' | 'offline';

export type HubFrame =
    | { t: 'hello'; protocol: number; generation: string; replayFrom: number }
    | { t: 'call'; seq: number; id: string; method: string; params: unknown; deadline: number }
    | { t: 'cancel'; id: string }
    | { t: 'ping' };

export interface ClientCallResult { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }
export interface ClientPost { ack?: number; results?: ClientCallResult[] }

export type ClientCallErrorCode =
    | 'METHOD_NOT_ALLOWED'   // not on the hub allowlist (default deny) or not handled by the client
    | 'CAPABILITY_MISSING'   // client attached but did not declare this method
    | 'DEVICE_OFFLINE'
    | 'BACKPRESSURE'
    | 'FRAME_TOO_LARGE'
    | 'HANDLER_ERROR'
    | 'HUB_CLOSED';

export type ClientCallOutcome =
    | { status: 'ok'; result: unknown }
    | { status: 'error'; code: ClientCallErrorCode | string; message: string; /** true when the call never reached the client */ notSent: boolean }
    /** The hub stopped waiting. Side effects are UNKNOWN; never equivalent to cancelled. */
    | { status: 'timeout'; effect: 'unknown' };

export const ATTACH_PATH = '/client-calls/attach';
export const RPC_PATH = '/client-calls/rpc';
