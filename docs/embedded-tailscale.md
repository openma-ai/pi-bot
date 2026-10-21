# Embedded userspace Tailscale (Apple experimental MVP)

The optional `embedded-tailscale` Cargo feature links the official libtailscale C
archive. This uses the same Go userspace network engine as TailscaleKit, through
its documented C ABI rather than introducing a Swift Tauri plugin. The existing
Rust SSH/HTTP/SSE stack can consume its socketpair directly. Default builds and
profiles retain their existing direct transport.

Path: native IPC → embedded libtailscale TCP dial → host-pinned SSH → remote
runtime loopback. No system VPN, TUN, NetworkExtension or system proxy is created.
The SSH server must already run on the Tailnet host, and the runtime must already
run independently. The client only reads discovery/token files and forwards to
that discovered loopback endpoint; it never starts or restarts the service.

HTTP/SSE use the existing native reqwest bridge, with runtime tokens kept out of
the renderer. The TCP forward also supports WebSocket upgrades (covered by an
offline handshake/frame test). Pibo currently uses SSE; this change does **not**
redirect arbitrary JS `fetch` or `new WebSocket` calls or add a general-purpose
renderer WebSocket API. A future renderer WebSocket consumer needs its own scoped
native command bridge. There is no fallback from an embedded dial to system TCP.
Outer control/DERP/UDP traffic still follows the machine's existing network/VPN
routes; this cannot promise to bypass another VPN.

## Source and build

Upstream app source: `https://github.com/openma-ai/pi-bot`, `main@7c78b35` merged
into the existing `feat/minimal-apple-clients@eb87e8c` history without conflicts
(merge `c408158cd9fb098c1ba43b7079d8f2477933fff7`). The original checkout is unchanged.

Official SDK revision: `tailscale/libtailscale@d1dc45d039edb7759ecbee6ba2aea0c4bca884b8`.
This revision requests Go 1.27.1 and tailscale.com v1.104.1. Xcode is required.
The helper pins that revision, builds only, and does not authorize any node:

```sh
npm ci --ignore-scripts
npm --prefix clients/tauri ci --ignore-scripts
node clients/tauri/scripts/build-gui.mjs
sh clients/tauri/scripts/build-embedded-tailscale.sh macos
export PIBO_TAILSCALE_LIB_DIR="$PWD/clients/tauri/.tailscale-build/macos"
cd clients/tauri
npm run tauri -- build --features embedded-tailscale --config src-tauri/tauri.tailscale.conf.json
```

The macOS configuration sets a minimum OS of 15.0, matching the SDK build.
For iOS use the helper's `ios` or `ios-sim` argument; always enable `embedded-tailscale`.
The default build path selects the platform automatically. Simulator archives are
split into `ios-sim/aarch64` and `ios-sim/x86_64`: rustc cannot bundle the universal
archive. If setting `PIBO_TAILSCALE_LIB_DIR`, select that architecture subdirectory.
Do not reuse a macOS archive for an iOS target. Static linking includes Go in the
client artifact; no separate daemon or shared library is installed. The official
Swift framework is not needed by this implementation.

## Explicit authorization and lifecycle

In an enabled native build, edit an SSH runtime and choose “应用内 Tailscale”.
Enter `user@Tailnet-host`, the independently verified **full** SSH host public key,
and SSH credentials. Desktop embedded SSH accepts password, Ed25519/RSA software
keys and interactive challenges; desktop direct SSH keeps system configuration.
Desktop embedded SSH credentials remain in process memory; iOS retains its
existing opt-in Keychain behavior. No credentials are profile fields.

The temporary-node button accepts a Tailscale auth key in memory and prepares the
node. Enabling the runtime performs the first network dial and may register the
node with Tailscale; obtain user authorization before doing this in testing. It
requires a suitable key/ACL/device approval policy. This MVP does not implement
interactive browser login, custom control servers, exit nodes or subnet routing.
There is one embedded node per app process; stop it before changing Tailnets.

The node is ephemeral and uses a fresh mode-0700 temporary directory; auth keys
are never stored in profile JSON or application logs. SDK state **can** contain
private keys on disk during the session. Normal stop/exit closes the node and
removes its directory; process crashes/forced kills can leave that directory and
require manual cleanup. This is not a persistent-login implementation and does
not promise no disk writes. Do not use a real key without authorization.

Stop closes the node and retires the active runtime/streams. A 10-second failed or
cancelled dial closes the node to cancel the blocking SDK operation; stop and
prepare it again before retrying. SSH still verifies the full pinned server key.
iOS uses its existing visibility lifecycle: disconnect streams in background,
reconnect the configured runtime on foreground, and never replay business
requests. Successful foreground recovery on a physical device remains untested.

## Offline verification

```sh
# Genuine library linked, no SDK node startup:
PIBO_TAILSCALE_LIB_DIR="$PWD/clients/tauri/.tailscale-build/macos" \
  cargo test --manifest-path clients/tauri/src-tauri/Cargo.toml --lib --features embedded-tailscale

# Explicit ABI double, not a Tailnet connectivity test:
sh clients/tauri/test/tailscale-offline/run.sh
```

The offline helper compiles a C ABI double into a disposable directory and runs
only the marked integration test. A marker symbol absent from the real SDK makes
accidental real-node execution fail at link time. Its dial accepts only
`pibo-offline.invalid` and redirects to disposable loopback SSH through a Unix
socketpair. The test verifies HTTP and native bearer auth, SSE, RFC6455 upgrade
and masked-frame round trip, disconnect/reconnect, changed SSH pin rejection, and
stop. It never performs DNS, Tailnet auth, or external runtime access. The stub is
not included in normal builds. Remove `PIBO_TAILSCALE_OFFLINE_TEST` and point back
to the real archive for a real build.

Real Tailnet HTTP/WebSocket, ACL/device approval, signed iOS installation,
physical-device background/foreground and VPN coexistence remain unverified.

## Verification on 2026-10-21

- macOS arm64, Xcode 26.6: official Mac/device/simulator C archives built.
- `npm ci --ignore-scripts` from merged lockfile; `npm run check` passed.
- Native GUI production bundle built (existing upstream directive/chunk warnings).
- Relevant JS suites: profile/viewport/state-protection 12 passed; runtime manager
  and gateway 6 passed, including refusal of embedded mode outside native clients.
- Actual libtailscale linked: 9 Rust unit tests passed without starting a node.
- Explicit C-double integration: 1 passed, including HTTP/SSE/WebSocket/reconnect.
- `cargo check --target aarch64-apple-ios --features embedded-tailscale --lib`
  passed. This is compilation checking, not a signed/device build.
- Full macOS/iOS client artifact builds were attempted but ran out of disk space.
  Only this task's failed target/incremental caches were removed. Full app
  packaging, iOS final linking/signing/install and physical-device tests remain.

No real Tailnet key or login was used, no real node was created, and no existing
service, system VPN/proxy setting, deployment or remote Git branch was changed.

Follow-up: the file-transfer implementation resolved the disk/build-phase
blockers and produced a local macOS preview app plus an unsigned iOS archive.
See [file-transfer verification](file-transfer.md) for the current build results;
the earlier disk failure remains part of the initial verification history.

## Local simulator initialization check (2026-10-21)

Ran the real arm64 libtailscale in an iPhone 17 simulator on installed iOS 26.4,
using an isolated `dev.pibot.sdk-simulator` app, preserving existing Pibo data.
`PIBOT_TAILSCALE_LOCAL_PROBE=1` enables a debug-only, iOS-only launch probe:
three real create/configure/close cycles, each close returning 0, each state
directory empty and removed. It never calls SDK start/up/dial. The result is
written to the test app's `tailscale-local-probe.json`; no real auth key is used.
The actual WebView/native IPC UI also passed select embedded, prepare with a
synthetic placeholder, stop, back, reenter, invalid-key error, and cancel.
Evidence is local ignored `artifacts/tailscale-simulator/` (JSON, PNG, build logs).

Tauri CLI refused this simulator because installed SDK 26.5 and runtime 26.4
versions differ; direct Cargo + Xcode simulator build worked. Cargo must enable
`embedded-tailscale,custom-protocol` for bundled frontend assets without a dev
server. A temporary Xcode project skipped the Tauri Rust phase and linked the
already-built simulator staticlib, with all SDK/toolchain Swift search paths.
No runtime download was performed. Tauri `ios dev` unexpectedly reinstalled the
existing Homebrew ios-deploy 1.12.2 (268.6 KB) before the command was stopped;
subsequent work used existing tools directly.

These checks prove library loading/configuration/lifecycle and UI IPC only.
They do not prove authentication, Tailnet HTTP/WebSocket, VPN coexistence, or
physical-device/background behavior. Network testing requires explicit approval
for a temporary node login/auth key and an authorized peer/test runtime on the
same Tailnet; no persistent credentials are needed for this test design.


### Authorized browser login attempt

After explicit permission for a temporary Tailnet test node, ran the isolated
simulator app with `PIBOT_TAILSCALE_BROWSER_TEST=1`. The debug-only entry configures
an ephemeral node named `pibo-ios-simulator-test`, removes the placeholder key
before SDK start, and polls a restricted status report. Official tsnet supports
interactive browser login without auth keys (StartLoginInteractive); this is not
an auth-key-only limitation. No auth key/password was requested or generated.
The report excludes peers and keys. A 15-minute guard stops the test node.

The actual attempt remained NeedsLogin with empty AuthURL/no IPs. SDK health
progressed from control-key fetch cancellation to registration POST timeout at
`https://controlplane.tailscale.com/machine/register` (context deadline exceeded).
Mac HTTPS checks to the public control-key endpoint succeeded, including a
single request with proxy bypass; this does not establish the simulator SDK's
registration path. No system settings were changed. No root cause is claimed.
No login URL or approved Tailnet membership was obtained. The test app was
stopped and its temporary identity directory removed. Sanitized evidence:
`artifacts/tailscale-simulator/browser-login-blocker.json`.
Cloud peer was also unavailable, so live HTTP/WebSocket remain unverified.


### Registration diagnosis and application socket fix

Further actual-simulator comparison narrowed the failure to SDK interface binding:
- The same app's no-proxy HTTPS GET to the official control-key endpoint returned 200.
- Host DNS resolved the official control/log endpoints into 198.18.0.0/15 addresses.
- SDK Noise dials on both ports 80/443 timed out; the official Apple netns code binds
  sockets to a default interface, which can conflict with the existing route for
  such DNS addresses. Its route-query option also failed in this simulator with
  `no valid address found` and fell back to the default interface.
- A tiny application Go/C bridge calls the official process-local
  `netns.SetDisableBindConnToInterface(logger.Discard, true)` before node creation.
  With that change, the simulator immediately completed Noise and received an
  official browser authorization URL. Approval was still pending at that point.

The bridge is built with a Go source overlay; the pinned official SDK checkout
is not edited. Rerun the helper to rebuild existing archives. This makes the
application's outer sockets follow existing OS routes; it does not modify system
VPN/proxy/DNS/firewall/routing, create a TUN, disable TLS/Noise, or promise to bypass
another VPN. Device VPN coexistence and live peer traffic still require testing.
Private diagnostic SDK logs exist only in the temporary test-node directory;
restricted reports omit keys and peer lists. The debug diagnostic additionally
accesses only the official public control-key endpoint once. No production
connection automatically triggers browser login.
