# Direct application Tailnet connections

Local implementation, 2026-10-22. Branch `feat/embedded-tailscale`.
Upstream `main` at `7c78b356a1ca165283bd7ddc12b98b72dc595176` was fetched and
already contained in the working branch. Existing local/SSH profiles remain valid.

## Product flow

On native Apple clients, choose Tailscale → log in using the system authentication
sheet → choose an online peer → check its Pibo service → pair once → enter the
workspace. SSH remains an advanced connection choice. A peer being online does
not establish that Pibo is installed or ready. Service discovery checks only the
selected address/port; there is no port scan or Tailnet management API credential.
The initial port is 4319 and can be changed explicitly.

The SDK is the existing pinned libtailscale C ABI (`d1dc45d039edb7759ecbee6ba2aea0c4bca884b8`,
Tailscale 1.104.1). The flow is inspired by Rootshell; this change independently
implements it without incorporating Rootshell source. Authorization uses
ASWebAuthenticationSession, while SDK status polling dismisses it on Running.
Closing the sheet is not proof of login. Login cancellation, node stop, local
identity deletion and server-side pairing revocation have separate semantics.

- Login restores a non-ephemeral node from a non-synchronizing, device-only
  Keychain item. Running status snapshots `tailscaled.state` to that item.
- The SDK needs working state on disk while running: its temporary directory is
  mode 700, restored state mode 600, excluded from backup, and protected with
  NSFileProtectionComplete on iOS. Normal shutdown removes it. A process crash
  may leave this private working directory; the Keychain is the authoritative
  restart snapshot. This is not a claim that active SDK state exists only in RAM.
- Stopping/cancelling the network closes its current session but retains a saved
  identity. Disconnecting a runtime does not stop the network node.
- “退出网络并清除本机节点身份” stops the node and deletes this app's local node
  snapshot. It does not delete the device in the Tailnet administrator console,
  and does not revoke Pibo service pairings. Remove the old network device there
  if necessary before deliberately registering a replacement.
- “清除本机配对” deletes the selected service's local bearer; it does not revoke
  its server record. The server owner can revoke that record separately.
- Pairing credentials are bound to the control-plane Tailnet ID (MagicDNS suffix
  fallback), peer stable ID, IPv4 and port, rather than IP alone. Switching
  Tailnets or replacing a peer cannot silently forward an old service credential.

A native loopback tunnel opens TCP streams with SDK `dial`. Existing RPC, SSE,
chunked file/image RPC and desktop HTTP/WS use that tunnel. The WebView receives
no service bearer. Desktop WS has an additional loopback proxy with a random
per-view ticket, exact app-Origin checks and native header injection. Its task is
aborted when the view/runtime closes. The CSP allows this loopback WS endpoint.
Desktop snapshots use authenticated fetch/Blob instead of an unbridged img URL.
Pending SDK dials are bounded to eight; cancelling/timing out one connection no
longer destroys the shared node. Outer connectivity still follows OS/VPN routes.

## Explicit server opt-in (not executed on the user's network)

The usual daemon remains loopback-only. An owner may opt into one specific
existing Tailnet IPv4 interface; wildcard/public listeners are rejected:

```sh
npm run pi-bot -- daemon --data-dir /absolute/workspace/data \
  --listen http://127.0.0.1:4318 --tailnet-listen 100.x.x.x:4319 --name 'My workspace'
npm run pi-bot -- tailnet-pair --data-dir /absolute/workspace/data
npm run pi-bot -- tailnet-devices --data-dir /absolute/workspace/data
npm run pi-bot -- tailnet-cancel --data-dir /absolute/workspace/data
npm run pi-bot -- tailnet-revoke --data-dir /absolute/workspace/data --device DEVICE_ID
```

Replace placeholders before running. Without any Tailnet flags, the daemon only
opens its ordinary loopback listener. `--tailnet-listen` alone requires the given
100.x IP to exist on the server and fails if it cannot bind: there is no fallback.

For an explicitly approved userspace-only node, add `--tailnet-serve-loopback`:

```sh
npm run pi-bot -- daemon --data-dir /absolute/workspace/data \
  --listen http://127.0.0.1:4318 --tailnet-listen 100.x.x.x:4319 \
  --tailnet-serve-loopback --name 'My workspace'
```

This binds the gateway **only to 127.0.0.1:4319** while requiring the advertised
`Host: 100.x.x.x:4319` on every incoming request. The flag requires an explicit,
valid `--tailnet-listen` and a local HTTP runtime; it accepts no arbitrary bind
address. CLI options are validated before daemon creation. A separately approved
Tailscale TCP Serve forward must target `tcp://127.0.0.1:4319` in the **same network
namespace**. TCP forwarding preserves the original Host; an HTTP reverse proxy
that changes Host is deliberately rejected. The local owner administration
endpoint stays on the ordinary runtime's loopback listener, and remote paired
devices cannot call it. No Serve/Funnel, ACL, Docker or host port configuration is
created by this option. Stop the daemon to close its listeners; disabling this
single Serve port is a separate owner action. Never use a global Serve reset to
remove unrelated forwards.

For the proposed isolated Docker test, this enables the new direct-runtime
container to share the test Tailnet container's network namespace without TUN or
NET_ADMIN. Its desktop broker should use 127.0.0.1:8091 rather than the existing
HTTP echo's 8080. The original desktop container and unrelated Mac containers
remain separate. Actual port availability, node IP/login and ACL must still be
checked after Docker becomes available; no current live state is inferred from
old configuration files.

`/pibo/service` returns a minimal service/version/name advertisement.
`tailnet-pair` opens a 120-second, 96-bit, single-use code with at most five
attempts; cancel/restart closes it. A pairing grants full access to this Pibo
workspace (including its existing agent capabilities), not just viewing a peer.
A paired device receives its own 256-bit bearer; only its hash and creation time
are stored mode 600. The daemon master token is never returned by pairing.
At most 32 devices can be paired. Revocation removes its hash and closes tracked
HTTP/WS sockets. The administrative pairing/revocation endpoint remains available
only on the original loopback listener with the daemon bearer and no Origin.
The private ingress rejects browser Origins and incorrect Host, and cannot proxy
arbitrary destinations or the administrative endpoint. Tailnet membership alone
never authorizes workspace access. No public ingress, default listener, system
VPN, DNS, proxy, signing or distribution setting is changed by building this code.

## Verification and limits

Passed locally:

- TypeScript check, GUI ESLint, Vite production bundle.
- macOS and arm64 iOS native `cargo check`, embedded SDK feature enabled. These
  are unsigned compilation checks, not archive/TestFlight or device execution.
- 23 Node tests across client profiles/runtime, file/image transfer and context,
  desktop ownership, and gateway pairing/auth/expiry/cancel/revoke/binary/WS.
- 18 native tests with the C ABI offline double: direct SDK HTTP binary and
  reconnect without SSH, existing SSH HTTP/SSE/WS regression, peer-field
  filtering, network/peer credential scope, URL/profile validation and desktop
  ticket/Origin/header/byte forwarding. Two existing SSH tests requiring a
  separately running fixture are explicitly excluded.
- Isolated Chrome mock at 390×844: login double-click calls start once; mock
  approval enters peers; offline peer disabled; independent service check and
  pairing enter chat; cancel returns NotPrepared and back returns to selection.
  Simulated hidden/visible events disconnect/reconnect runtime while network
  remains Running and start count remains one; Tab reaches labeled controls.
- `21st review src/gui/TailnetConnect.jsx --json`: zero findings.

Reproduce isolated native and UI tests:

```sh
sh clients/tauri/test/tailscale-offline/run.sh '' \
  --skip ssh_fixture::tests::embedded_remote_send_stream_reconnect_and_trust \
  --skip ssh_fixture::tests::encrypted_key_and_keyboard_interactive_authentication
node --import tsx clients/tauri/test/ui/serve.mjs
# Open /clients/tauri/test/ui/index.html?phone=1&approve=1&success=1 on port 5189.
# Omit approve=1 to exercise cancellation. All identities/services are synthetic.
```

Screenshots: [pairing](evidence/tailnet-pairing-mock.png),
[cancel/back](evidence/tailnet-cancel-mock.png). They contain only synthetic data.

Not yet verified: real Keychain persistence/relaunch on either platform, native
ASWebAuthenticationSession approval/cancellation UI, real Tailnet service pairing,
this new desktop bridge in WKWebView, true device background/lock-screen and VPN
coexistence. Actual login, saving persistent network credentials, opening a real
listener/Serve forwarding each need a concrete new confirmation before testing.
No real login, persistent credential write, listener, TestFlight build/upload or
system security/network change was performed for this iteration.

## Explicit userspace forwarding adapter follow-up

`--tailnet-serve-loopback` was added and tested without starting Docker, Tailscale
or Serve, or writing real network credentials. Five focused listener/gateway
tests cover malformed/ambiguous flags, fail-closed binding selection, the actual
loopback socket, advertised Host rejection, local-owner pairing, authenticated
health, remote-admin denial and device revocation. These use only synthetic
127.0.0.1 services. TypeScript check and the full `npm test` aggregate passed: 327/327 tests, no
skips, approximately 13 seconds (`/tmp/pibo-tailnet-forward-aggregate.log`).

## Simulator entitlement packaging diagnosis (2026-10-23)

The isolated `dev.pibot.direct-simulator` test initially disabled Xcode signing.
The app launched but Keychain returned -34018 (missing entitlement). A subsequent
manual ad-hoc signature incorrectly put team-prefixed application-identifier and
keychain-access-groups into the real signature. AMFI rejected that package as
ad-hoc signed with restricted entitlements. This was test packaging error; it
does not establish that an Apple Development certificate is required.

A separate offline Xcode simulator build succeeded with
`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Automatic`, empty
`DEVELOPMENT_TEAM` and `PROVISIONING_PROFILE_SPECIFIER`, the independent bundle
identifier, and the existing prebuilt static library. No provisioning updates
were allowed. Xcode generated an empty signed `.xcent` and a separate
`-Simulated.xcent` containing the application identifier, linked into
`__TEXT,__entitlements` (plus DER companion). Strict signature verification passed;
the signature is ad-hoc and TeamIdentifier is unset. No certificate/private key
was used. The original project's entitlement file is empty and needs no new
Keychain Sharing entitlement for this single-app test.

This follows the simulator-specific construction tested in the
[official Swift build system](https://github.com/swiftlang/swift-build/blob/main/Tests/SWBBuildSystemTests/EntitlementsBuildOperationTests.swift)
(`simulatorEntitlementsSections`). Do not manually sign device-style restricted
entitlements into the simulator signature, or disable platform verification.

Evidence: `/tmp/pibo-direct-sim-default.log`; generated app
`/tmp/pibo-direct-sim-default/Build/Products/debug-iphonesimulator/PiboDirectTest.app`.
The corrected package was **not installed or launched** in this diagnostic round.
Keychain access, SDK login and restart persistence remain unverified with it.
The test gateway/Serve and containers remain stopped; the authenticated Docker
identity volume is retained. Next verification is a single normal simulator
install/launch of this corrected package, followed by production Keychain API
checks; no new signing identity is indicated by the current evidence.

## Real SDK direct test (2026-10-23)

The corrected Xcode simulator package actually launched and completed official
browser authorization. Client Running IP was `100.65.80.34`; the dedicated
Docker userspace node remained `100.127.171.114` (stable ID
`nq5VdVq41D11CNTRL`). Only these two test endpoints were exercised. Peer discovery
returned the test service node; no other peer service was contacted.

Passed through production embedded SDK transport, not a localhost substitute:

- Service discovery, explicit one-use pairing and Keychain credential storage.
- Multiple independent App process restarts/reinstalls restored the same client
  IP, without another authorization page; service pairing was reused. Server
  container restart likewise retained its node ID/IP from its dedicated volume.
- JSON-RPC HTTP and SSE; synthetic 300,073-byte file and 270-byte 64x48 PNG
  uploaded, copied by the offline fixture agent, returned as file cards and
  downloaded with exact byte/SHA256 equality. No paid model was used.
- Desktop PNG (14,408 bytes) and actual WKWebView noVNC canvas 1280x900 over
  `desktop_open` native WebSocket bridge. Manual takeover UI reached Controlling.
- Synthetic pointer dispatch moved the container pointer to approximately
  (253,176). Keyboard dispatch was attempted but visible text echo was not
  established; therefore keyboard is NOT marked passed. Control-lease switching
  during repeated App restarts still needs a deterministic focused test.

The initial driver incorrectly requested `/api/desktop/bind` as an HTTP route;
that is a GUI adapter name, not the daemon endpoint. It now uses the existing
`desktop/bind` RPC. Radix theme tab text is duplicated in its rendered structure
(`电脑电脑`); the isolated driver uses containment and normal focus/mousedown.
Diagnostic desktop metrics are saved separately from periodic layout metrics.

Evidence (local ignored artifacts):
`artifacts/tailnet-direct/real-sdk-direct-result.json`,
`real-sdk-desktop-ui.json`, `real-sdk-desktop.png`. Public status is redacted to
exclude unrelated peers. Offline native regression: 19 passed, 2 external SSH
fixture tests filtered, `/tmp/pibo-direct-live-regression.log`. iOS simulator
static build and normal Xcode ad-hoc packaging passed after driver changes.

Cleanup verified: one test pairing revoked, zero remain; Serve configuration
`{}`; direct runtime and persistent-node containers stopped, test App stopped.
Node identities remain in the dedicated Docker volume and independent App
Keychain. A future test must explicitly pair again; no node logout was performed.

Not verified: physical iPhone, system-VPN coexistence, lock-screen/background
recovery, actual iOS save/share UI, real vision-provider inference, keyboard echo,
and direct-versus-DERP route. A Tailscale ping timed out despite successful SDK
HTTP/WS traffic, so it is not used to infer route or connectivity failure.
No certificate/key/security/network setting changes or TestFlight upload.
