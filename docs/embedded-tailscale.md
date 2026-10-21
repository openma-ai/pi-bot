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
For iOS use the helper's `ios` or `ios-sim` argument and pass the matching archive
directory to the Tauri iOS build environment; always enable `embedded-tailscale`.
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
