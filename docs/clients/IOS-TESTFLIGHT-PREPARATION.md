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

Android initialization failed because no SDK/NDK was installed; JDK 17/21 already
exist. Installation was subsequently authorized and `aarch64-linux-android` was
installed. The official SDK download explicitly requires the Google Android SDK
License Agreement; acceptance is separately pending. Nothing from the Google SDK
has been downloaded or accepted. No APK or Android native credential backend has
been validated. Do not present an interface-only Android build as a working client.
