# iOS development and TestFlight preparation

The client now has a real generated Xcode project and an embedded SSH transport.
iOS connects only to an already-running remote daemon; it never executes or
installs a local runtime. Apple distribution signing and upload are not configured.

## Build identity

- Product: Pi Bot; version 0.1.0; build 1; minimum iOS 16.0.
- Provisional local bundle ID: `dev.pibot.ios`.
- Apple development team and existing App Store Connect destination: unconfirmed.
- No Apple certificate, profile, app record, API key, invitation or agreement was
  created. No App Store Connect/TestFlight upload occurred.

The generated project is `clients/tauri/src-tauri/gen/apple/pi-bot-desktop.xcodeproj`.
The shared Rust library supplies Tauri's mobile entry point; desktop `main.rs`
delegates to that library. Desktop retains system OpenSSH and local connections.

## Remote connection

iOS supports explicit `user@hostname`, SSH port, a verified full host public key,
passwords, Ed25519/RSA software private keys (including supported encrypted
OpenSSH/PEM keys), and bounded keyboard-interactive challenges. RSA authentication
requires SHA-2; there is no SHA-1 downgrade. Unknown, malformed, changed and
certificate-wrapped host keys are rejected without TOFU. OpenSSH aliases/config,
SSH agent, hardware-backed keys, certificate login and browser/push MFA are not
supported. See [SSH authentication](SSH-CLIENT-AUTH.md) for precise coverage.

Credential saving requires an unchecked-by-default consent checkbox. Otherwise
credentials remain in native memory for this app process. Opted-in credentials
use Apple Keychain with `AccessibleWhenUnlockedThisDeviceOnly`, no cloud sync,
and an identity bound to profile ID, host/user, port and pinned host public key.
Saved encrypted keys include their decryption passphrase under that protection.
Challenge responses are never saved. Removing a profile or changing its SSH
identity removes old stored credentials. Profile JSON, runtime status, app events,
URLs, chat transcripts and logs contain no private key, password or passphrase.
Only bounded untrusted server prompts are sent to the verification dialog; answers
return through one-shot native IPC, not daemon/chat events. Verification used
only disposable dummy credentials and ephemeral keys.

The adapter reads existing `daemon.json` and the transport token over the verified
SSH session. Discovery must identify the supported protocol and a loopback-only
HTTP endpoint. Independent SSH direct-TCP channels forward HTTP/SSE; the client
listener binds only to `127.0.0.1`, preserves the remote Host header and adds the
transport bearer credential natively. Dropping an endpoint aborts its owned
forwarding tasks. No remote runtime is started. A dropped SSH session can be
reestablished using the settings menu's reconnect action; this is not an
always-running iOS background agent. App visibility suspension retires the client connection; foreground resumes with a new snapshot and never resends a turn.

## Toolchain and resolved initialization blocker

Installed tools: Xcode 26.6 (17F113), iOS SDK 26.5, Rust 1.97.1, device and ARM64
simulator targets, XcodeGen 2.45.3 and CocoaPods 1.16.2.

After explicit user approval, `brew reinstall libimobiledevice` succeeded and
installed its normal package dependencies. The prior failed sandbox attempt was
not bypassed. `tauri ios init --ci --skip-targets-install` then generated the real
Xcode project. No additional SDK or simulator runtime was installed.

CLI 2.12.2 checks libimobiledevice unconditionally during initialization, although
it is device/log tooling rather than an archive linker input. The standard CLI's simulator
archive path also requires a simulator runtime matching SDK 26.5, while this Mac
has iOS 26.4 available. Direct Xcode builds target the installed iOS 26.4 simulator
or a generic iOS device; no runtime version or security check was falsified.

## Build/run

From the repository root, build the frontend:

```sh
npm --prefix clients/tauri run build:gui
```

Keep Tauri's official Xcode context process running in a terminal:

```sh
cd clients/tauri
npm run tauri -- ios build --debug --target aarch64-sim --no-sign --ci --open
```

It opens Xcode and supplies the build-script context. In another terminal, from
`clients/tauri`, select the existing simulator UUID and build:

```sh
xcodebuild -project src-tauri/gen/apple/pi-bot-desktop.xcodeproj \
  -scheme pi-bot-desktop_iOS -configuration debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=<installed-iPhone-UUID>' \
  -derivedDataPath /tmp/pi-bot-ios-derived \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= build
```

This uses only local ad-hoc simulator signing. It creates no Apple signing asset.
Install/launch the resulting simulator `.app` using Xcode or `xcrun simctl`.
Without a fixture environment, the app starts with no local profile; add the
remote configuration in settings. A device archive can be inspected unsigned:

```sh
xcodebuild -project src-tauri/gen/apple/pi-bot-desktop.xcodeproj \
  -scheme pi-bot-desktop_iOS -configuration release -sdk iphoneos \
  -destination 'generic/platform=iOS' -archivePath /tmp/PiBot-unsigned.xcarchive \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM= archive
```

Do not add automatic provisioning flags or upload until the existing Apple
team/app/bundle destination is confirmed. An unsigned archive is not an
installable TestFlight package. App Store Connect export/upload must use the
approved existing signing assets and destination; the generated debugging export
plist is not an App Store Connect distribution configuration.

## Isolated verification

The opt-in `client-fixtures` feature builds a loopback SSH fixture binary; normal
app builds omit it. The fixture creates an ephemeral host key and accepts only a
clearly named dummy password, a fixed discovery command and forwarding to the
isolated runtime's loopback port. It never reads the user's Pi profile.

```sh
node --import tsx clients/tauri/test/fixture-server.ts \
  /tmp/pi-bot-ios-remote-fixture-<date> --navigation --bubble-colors \
  --message-layout --ssh-testing
cargo run --manifest-path clients/tauri/src-tauri/Cargo.toml \
  --features client-fixtures --bin ios-ssh-fixture -- \
  /tmp/pi-bot-ios-remote-fixture-<date>
PIBOT_SSH_FIXTURE_ROOT=/tmp/pi-bot-ios-remote-fixture-<date> \
  cargo test --manifest-path clients/tauri/src-tauri/Cargo.toml \
  --features client-fixtures --lib
```

Native fixture coverage: changed host-key rejection, wrong-password rejection,
real daemon RPC send, SSE delta and completed reply, forced SSH disconnect and
explicit reconnect, plus desktop transport/install regression checks. A debug-only
iOS probe repeats the transport checks and native Keychain store/read/update/delete
inside the actual simulator app. Its profile must explicitly match the disposable
loopback fixture; it is compiled out of release builds. No real remote server has
been tested or granted access.

UI verification is recorded separately in `IOS-SIMULATOR-UI-VERIFICATION.md`.
Successful transport tests do not establish layout/keyboard acceptance.

## Remaining distribution requirements

Confirm the paid Apple Developer team, existing bundle/app destination and usable
distribution signing certificate/profile (or authorize the exact missing resource
separately). This machine initially had no valid signing identity, profile or
configured team. Real-device install, background/foreground network behavior and
signed archive/export remain separate checks. iOS may suspend foreground streaming
in the background; there is no promise of continuous background execution.

## Read-only Apple/Android setup inspection

Xcode's saved production Apple account lists were empty and `security find-identity
-v -p codesigning` returned zero valid identities. Neither local provisioning-profile
directory exists. The user has a developer account but must log in personally and
confirm the Team/app destination. No Apple setting or resource was changed.

Android now has an arm64 debug APK and a local AOSP Android15 emulator; see
[Android build and verification](ANDROID-TEST-BUILD.md). The user explicitly
accepted Google's SDK agreement before installation. Android secrets remain
session-only in native memory; no Keystore persistence or real-device coverage
is claimed. Desktop preview/production workflows are documented separately in
[Desktop releases](DESKTOP-RELEASE.md).

## Signed TestFlight upload (2026-10-15)

Later setup supersedes the initial unsigned-only inspection above. User authorized
Apple Distribution creation, the public WWDR G3 intermediate installation with
default trust, the app/profile creation, and this specific TestFlight upload.
No root-trust override, Always Trust, API key, private-key export, new external
testers or public store submission was performed.

- Product display name: Pibo. App Store record: **Pibo - Personal Agent**
  (the shorter Pibo store name was unavailable).
- Team: Yang Xiao / `962863MJ5J`; Bundle ID: `dev.pibot.ios`.
- ASC app: `6823234702`; primary language Simplified Chinese; SKU `pibo-ios`.
- Profile: Pibo App Store Distribution, UUID
  `1be1d9d0-3f8e-41cd-8bb2-4eb0310320c1`, expires2027-10-15.
- Exported IPA: `artifacts/Pibo-TestFlight-0.1.0-build1/Pibo.ipa`,
  **0.1.0 (1)**, 5,949,274 bytes, Library file
  `libfile_75364379e4a88191baee5ba468927825`.
- SHA256: `e6b9018a73dfc7c259caeea53b3baa41e488b13cdbe0d8b57a18d4ffdaddee64`.
- Verified exact IPA's strict/deep codesign, Apple Distribution certificate chain,
  TeamIdentifier, arm64 executable, embedded profile and get-task-allow=false.
- Manual export used existing Xcode account/certificate/profile; no automatic
  signing-resource creation. Upload log `/tmp/pibo-testflight-upload.log` reported
  **Upload succeeded** and **EXPORT SUCCEEDED** at2026-10-15 23:54 local time
  (15:54UTC); Apple reported the uploaded package was processing.

Upload acceptance is separate from processing completion and test availability.
[Authoritative TestFlight page](https://appstoreconnect.apple.com/teams/517afde0-f580-4088-89fa-5377334c9871/apps/6823234702/testflight).
A distribution IPA is not a directly sideloadable development package.

Processing subsequently completed: TestFlight exposes build1 (version0.1.0),
build ID `a9e43959-f6e5-4aec-b1ab-eaa4766afe28`, with **Missing Compliance**.
It is not yet installable. The app implements standard SSH/TLS encryption through
russh/ring and reqwest/rustls, beyond OS-provided encryption. The accurate
standard-encryption choice was prepared but not submitted. Apple's next question
is whether the app will be distributed in France; no answer or final Save has
been submitted. This distribution intent and the export declaration require user
confirmation. No internal group/tester has been created yet.

## Release browser authorization and current upload blocker (2026-10-21)

The embedded Apple build now exposes user-triggered browser authorization in
normal Release Settings/first-run configuration: **登录 Tailscale**, then
**打开授权页面** when the official SDK supplies its URL. The system browser opens
only a validated `https://login.tailscale.com/a/...` endpoint obtained natively
from the active SDK node, never an arbitrary renderer-supplied URL. Status shows
pending login, administrator approval, connected, stopped, or unavailable. Cancel
closes the node and removes its temporary identity; a new login requires another
explicit action. There is no product 15-minute deadline and no automatic login
on launch. The advanced one-session auth-key option remains available.

Public status contains only backendState/authURL/this-node IPs, never raw SDK
status, peers, diagnostic logs or keys. SDK logging is discarded for product
nodes. Status polling does not implicitly start tsnet (its upstream LocalClient
normally would); a prepared auth-key node starts only on explicit connection.
Credentials/identity stay out of profiles and artifacts. All debug simulator
probes, fixed peer addresses, reuse environment variables and probe timers remain
compiled out of Release. The browser-start path uses no placeholder auth key.

Verified without joining a network: offline ABI tests cover explicit start,
duplicate rejection, passive status, cancellation/restart and existing
HTTP/SSE/WebSocket/reconnect; native tests cover official URL restrictions;
frontend tests and a local synthetic phone-mode mock cover default browser login,
waiting/open-page controls and cancellation. The real iOS Release library and
unsigned archive compile/link with the official SDK. This is not a new live
Release browser-login/device acceptance test, nor iOS Tailnet noVNC acceptance.

Current candidate identity remains `dev.pibot.ios`, version 0.1.0, candidate build
1021.15.01 (not yet checked against current ASC builds). Existing Team 962863MJ5J
and Pibo App Store Distribution profile match; distribution identity is listed
valid. Manual signing failed at CodeSign with `errSecInternalComponent`, after
linking. No explicit authorization dialog was observed and the error alone does
not establish whether the Keychain is locked or the exact private-key access
cause. No trust settings, key ACL, certificate, account privilege or signing
resource was changed, and failed signing was not repeatedly retried. The user
should inspect the existing login Keychain/signing-key access locally; never
send a Keychain password to chat. App Store Connect currently redirects the task
browser to login with `authResult=FAILED` and its sign-in component did not load.
The user can open https://appstoreconnect.apple.com/apps/6823234702/testflight in
their browser and sign in personally. Export-compliance/France distribution
intent and testing-channel scope still require confirmation. No new upload was
attempted. Unsigned artifacts and exact logs are under ignored
`artifacts/testflight-1021.15.01/`; they cannot be installed through TestFlight.
