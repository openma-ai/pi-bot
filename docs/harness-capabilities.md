# Harness desktop capability contract

The harness reports the capabilities of its configured desktop companion. A
`control.json` file means configured, not ready. It does not detect unrelated
desktop applications or assume that the host's permissions have been granted.

`snapshot.desktopCapabilities`, the `desktop/capabilities` RPC and agent
`desktop_list` use the same report:

```ts
{
  configured: boolean,
  canOpenView: boolean,
  platform: string,
  browser: { state, reason, checkedAt },
  computerUse: { state, reason, checkedAt },
  screenCapture: { state, reason, checkedAt },
  vnc: { state, reason, checkedAt },
  availableTools: { browser: string[], computer: string[] }
}
```

Every state is one of `unsupported`, `unconfigured`, `permission-required`,
`unreachable`, `ready` or `unknown`. `checkedAt` is epoch milliseconds. Reasons
are fixed, credential-free explanations; raw doctor output, local paths,
window contents and authentication values are not published.

The RPC accepts `{botId?: string, refresh?: boolean}`. With a bot ID, VNC refers
only to that bot's already opened viewer. Without one, the report summarizes
existing viewers. `desktop/capabilitiesChanged` carries
`{desktopCapabilities}` and the SDK reducer applies it. The daemon monitors
every 10 seconds without delaying chat startup or snapshots. Client checks are
deduplicated, cached for 5 seconds and bounded to 2.7 seconds. The companion
caches for 2 seconds; each independent probe has a 2-second deadline, subprocess
probes are killed after 1.5 seconds, and RFB has an absolute 1.5-second deadline.
Probe results started before an explicit viewer transition are invalidated.

## What constitutes evidence

| Capability | Evidence | Does not imply |
| --- | --- | --- |
| Browser | The existing Chromium connection answers CDP `Browser.getVersion` | Computer Use, host browser availability or VNC readiness |
| Computer Use | The pinned Linux doctor verifies owned-window discovery/focus and input backend readiness, plus `xdotool getmouselocation` and a live XTEST extension query succeed | A successful action in every application, accessibility selectors, or screen-capture consent on another platform |
| Screen capture | A one-pixel read from this adapter's X11 display succeeds, with no file/image retained | macOS Screen Recording permission or another display/session |
| VNC | An already opened localhost viewer completes RFB 3.8 version/security/shared-client initialization and exposes a framebuffer | Input control or takeover permission |

The upstream [0.7.16 doctor schema](https://github.com/agent-sh/computer-use-linux/blob/v0.7.16/src/diagnostics.rs)
explicitly distinguishes screenshot route discovery from verified capture.
Therefore doctor alone does not mark screenshots ready. The adapter never
calls setup tools or changes accessibility settings to improve a probe result.

`computerUse.ready` can mean coordinate-only operation. Its reason says so and
`availableTools.computer` excludes `get_app_state`, `set_value` and
`perform_action` unless accessibility is verified. Semantic selectors on
`click`/`scroll` are rejected both by the agent wrapper and service when that
backend is unavailable. Screenshots are listed only after the independent
capture probe succeeds. A failed operation invalidates its cached state and
starts a read-only refresh; the operation itself is never replayed.

## Opening a view is explicit

`canOpenView` requires a working CDP connection, owned-window backend, live X11
input/display queries, capture, and a successful `x11vnc -version` check. It
means the user can try to open a view, not that a VNC listener already exists.

Capability discovery never calls `/bind`. Agent window binding no longer
starts VNC. The client's explicit `desktop/bind` action sends `openView:true`
to the companion and waits for an actual RFB handshake, for at most 2.5 seconds,
before returning success. A stopped viewer becomes `unreachable`; a health
probe does not restart it. Another explicit open can start it again. Viewing
does not claim an input lease. Existing ownership and takeover checks remain.

The default companion configuration remains `work/gui/desktop/control.json`;
`PI_BOT_DESKTOP_CONTROL` can select an explicit file. No credentials are copied
or discovered from other installations. An old companion that has no
capability endpoint is `unknown`, with an update reason, rather than presumed
ready. Missing or malformed configuration does not crash the harness.

## Platform boundary and verification

The current desktop adapter is Linux X11. A macOS/Windows harness can use a
configured companion, but native host Computer Use is not implemented here.
With no companion, native Computer Use is `unsupported`; native screen capture
is `unknown`, specifically without assuming macOS Screen Recording or
Accessibility approval. No OS permissions, VNC service, firewall, proxy,
Tailnet authorization or system service is enabled by detection.

2026-10-27 verification:

- 45 scoped tests pass: capability classifications, timeout, no-bind discovery,
  input handshake requirements, partial accessibility, shared failure/recovery,
  real local RFB handshake/authentication/timeout, tool gating, approval and
  cancellation, ownership, protocol and architectural layers.
- `npm run check` passes.
- Actual Linux arm64 desktop smoke uses cached image
  `pibo-tailnet-direct:phone-0950971` with current source mounted read-only,
  `--network none`, no published ports, temporary `/data`, and a 1 GiB memory
  limit. It does not mount the user's home, credentials or runtime volume.
  Evidence is in `harness-capabilities-evidence-20261027.json`.
- The real image has no working AT-SPI accessibility backend. Coordinate
  Computer Use, CDP, X11 capture and VNC are tested; semantic tools remain
  unavailable. No setup command was run to change that state.
- The smoke checks no side effects during detection, no VNC start during agent
  binding, exact tool availability, actual Pi browser dispatch (`6 * 7` → `42`),
  first-open readiness, viewer failure and explicit recovery. No paid model,
  external website or real user UI action is involved. The disposable container
  is removed after the run; both pre-existing runtime containers are preserved.
- A separate real daemon with empty, isolated model settings returns
  `setupRequired` with “设置的「模型」” guidance and accepts no chat turn. It does
  not silently queue work or invoke a model.
- No new native macOS/Windows Computer Use, Wayland adapter, or mobile network
  authentication was implemented or claimed as tested in this change.

Focused test command:

```sh
node --import tsx --test test/desktop-capabilities.test.ts \
  test/desktop-environment.test.ts test/desktop-nonblocking.test.ts \
  test/desktop-ownership.test.ts test/protocol.test.ts test/layers.test.ts
```

The Linux smoke script is `test/fixtures/desktop-capabilities-smoke.mjs`. It must
only be run in the disposable network-isolated container described above, with
`PIBO_ISOLATED_DESKTOP_QA=1`. It deliberately stops only that container's own
temporary viewer to exercise failure and recovery.
