# Pi background execution and observation

This local extension wraps Pi 1.2.0's existing codemode and bash definitions.
QuickJS, MCP dispatch, native tool hooks and bash execution remain owned by Pi.
It separates execution from waiting: a quick call returns its final result;
new input or a bounded wait yields a receipt for the same running execution.
It does not restart the script or launch another process.

## Install and enable

```sh
npm ci --ignore-scripts
npm run prepare:background
PI_BOT_BACKGROUND_TOOLS=1 npm start
```

The normal CLI provider/model authentication configuration still applies.
The preparation command checks both SDK and codemode versions, verifies patch
anchors before writing, and retains originals under `work/pi-background-sdk-original`.
It is idempotent. Reapply after reinstalling dependencies. An SDK upgrade fails
explicitly until the bridge has been reviewed.

The bridge supplies narrow capabilities missing from the public extension API:
detached nested-call identities and originating assistant inheritance, worker
output observations, and a scoped output-file directory. It patches the SDK's
dist modules, **not Pi's bundled standalone CLI**. No upstream release is implied.

SDK hosts can opt in through `piSessionFactory({ ..., backgroundTools: {} })`.
The default adapts native bash; pass `additionalTools: []` for codemode only or
provide existing tool definitions to adapt other executors. Calls made inside
codemode or `start_job` retain their existing owner instead of creating nested
background executions. Models can call bash/codemode directly; they need not
wrap those calls in `start_job`.

For a standalone Pi SDK host:

```ts
const background = createBackgroundCodemodeExtension({
  directory: '/absolute/project/work/executions',
  additionalTools: [createBashTool(cwd)],
});
// Add background to DefaultResourceLoader.extensionFactories.
// Activate codemode, codemode_wait, codemode_read, bash and exec_wait.
// Before session.dispose(): await background.close(); await session.waitForIdle();
```

## Model-visible process and result

- `codemode` returns the native final result or a `cell_id` receipt.
- Adapted `bash` returns the native final result or a `task_id` receipt.
- `codemode_wait({cell_id, after_seq, yield_time_ms})` and
  `exec_wait({task_id, after_seq, yield_time_ms})` observe the existing execution.
  Pass the previous `next_seq` for incremental events; never restart to obtain
  output. `terminate: true` requests explicit cancellation.
- Observations include `text`, console and image output; every nested tool's
  start, progress, full result and error; and final execution status. Descendants
  of tools are included, with unique IDs and parent relationships.
- Each cell has a complete JSONL trace and saved final-result record. The normal
  observation page holds at most 32 events/32 KiB. A large event provides
  `event_seq`, `cell_id` and `retrieve: codemode_read`; the original remains saved.
- `codemode_read({cell_id, event_seq, offset, limit})` reads the full event as JSON
  character pages. Omit `event_seq` to read the saved final-result object. Use
  `next_offset` until `done`. This makes large records accessible to a bot whose
  ordinary filesystem tools are disabled. Native output spill files remain
  referenced in native result details.

All execution records, images and output spill files use the supplied project
directory. Scoped artifact routing uses AsyncLocalStorage; simultaneous sessions
cannot redirect one another's output by changing a global environment variable.
Only the owning Pi session can collect a cell. Completed results remain readable
when reopening that session. A record left running after process exit is
**uncertain**, never replayed automatically. A restarted process does not resume
an old QuickJS worker or bash process.

## Bot task ownership and completion

The bot adapter routes execution through its existing durable jobs and inbox.
Completion creates one job event with the original task ID, source message and
reply route. New chatter does not change that source. A model should supply
`source_message_id` from the original inbox envelope on codemode/bash calls;
the legacy leading `// @source: <messageId>` code header is also understood.
The host removes this metadata before invoking Pi's original executor.

Native task tools called by a background descendant inherit the same source.
The adapter checks task replacement/cancellation and permissions before each
new nested action. An already dispatched tool can finish; later stale actions
and replies are blocked. Each native call still traverses Pi hooks. The
execution's own job-completion input does not interrupt its quick final return.

Default limits: 1 second foreground wait, 10 minute execution deadline, 4 active
cells, 128 cells per session, 32 MiB complete trace per cell. Waits are at most
60 seconds. A trace-limit failure retains a marker instead of silently losing
observations. Cancellation/deadlines depend on a tool honoring its signal;
an uncooperative executor can continue holding a slot until it settles.
Final persistence failures are explicitly reported as memory-only results.

## Reproduce and distinguish evidence

```sh
mkdir -p work/regression-runtime
TMPDIR="$PWD/work/regression-runtime" npm test
npm run check
npm run smoke:background
# Authorized local host-only DSH credential import; never print/export the key:
npm run smoke:background -- --real
```

The offline smoke uses Pi's faux provider but real native Pi, QuickJS, tool hooks,
jobs and inbox. The feature tests additionally exercise real native bash process
identity, input yielding, explicit termination, permission refusal, reopened
sessions, full-output paging, and multi-layer routing. These are runtime proofs,
not real-model scores.

The real smoke uses official DeepSeek `deepseek-v4-flash`, thinking enabled,
high effort, at most 16 requests/384k conservative input reservations,
16,384 output tokens per request including reasoning, 10 minutes per request
and 10 minutes overall. It imports the explicitly authorized local credential
into the in-memory inference host only; no credential enters tools, code,
reports or chat. There are no automatic retries or external tool effects.
Background summaries are disabled; this does not validate real compaction.

Task A holds a native tool while 8 distinct no-reply messages and independent
task B enter the real Pi inbox. B must collect live `MCP_PROGRESS` observations
and reply through `send_message`. The host then releases the same A execution;
the model must recover its final result and reply to A's original thread.
Reports retain sanitized inbox, job, tool/result, cell and outbox evidence under
fresh `work/background-smoke/<run>/` directories. Fees are SDK estimates from
reported usage, not provider invoices. This is a focused custom fixture, not
a multi-agent benchmark or a complete model behavior evaluation.

The bridge pins codemode 1.2.0 with the matching Pi agent/core/AI/MCP/TUI 1.2.0 family. Agent 1.1.0 cannot be mixed with codemode 1.2.0: its MCP declaration imports were removed. The output observation patch now targets `runtime/execution.js`, specifically `execute()`; the new deterministic `start()` API is unchanged. Patch anchors are checked before any write, and original files are backed up by SDK version. `test/pi-background-bridge.test.ts` verifies live output before settlement and successful store writes using the real worker/WASM sandbox.
