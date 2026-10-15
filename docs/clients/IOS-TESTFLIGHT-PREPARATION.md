# iOS TestFlight preparation — 2026-10-15

Status: source preparation and device-target typecheck only. No Xcode project,
archive, IPA, signing, App Store Connect upload, or TestFlight build was produced.
Includes the interface work through `1d38c69`.

## Local build identity (provisional, not an Apple destination)

- Product: Pi Bot
- Version: 0.1.0
- Build: 1
- Bundle ID: dev.pibot.ios
- Minimum iOS: 16.0
- Development team: unset
- Existing App Store Connect app: not established

Confirm the existing team/app/bundle destination before any upload. Do not create
an app record, signing certificate, provisioning profile, API key or agreement
acceptance as part of this preparation.

## Source changes

The desktop binary now delegates to a shared Rust library with Tauri's mobile
entry point and static library output. iOS starts with no local profile, rejects
local connections in native commands, hides the local option in settings, excludes
Tokio process support and the runtime payload staging primitive, and excludes the
desktop title-bar dragging permission. The runtime installer remains unavailable
on iOS. No runtime executable or downloaded executable is bundled.

**Remote functionality is incomplete:** the existing iOS transport deliberately
returns an explicit “embedded SSH adapter not yet verified” error. Desktop uses
system SSH; iOS must use an embedded adapter with host verification and secure
credential storage. There is no successful iOS remote connection/streaming test.
This is a functional blocker to a useful tester release, independent of signing.

## Installed tools and signing inspection

Xcode 26.6 (17F113), iPhoneOS/iPhoneSimulator SDK 26.5, Rust 1.97.1,
`aarch64-apple-ios` and `aarch64-apple-ios-sim`, XcodeGen 2.45.3, CocoaPods 1.16.2.
Read-only inspection found zero valid code-signing identities, zero provisioning
profiles in the standard user directories, no configured Xcode provisioning team,
and no App Store Connect API private keys in the standard user directory. This
only describes this machine; it does not establish the user's Apple membership.

`tauri ios init --ci --skip-targets-install` stopped before project generation:
the CLI tried to install missing `libimobiledevice` via Homebrew and sandbox
filesystem restrictions prevented that install. No escalation/install retry or
Homebrew permission changes were attempted. The Rust iOS dependencies were fetched
for the target check; no new SDK was installed.

## Verification

From repository root:

```sh
npm run gui:check
npx tsc --noEmit
cargo check --manifest-path clients/tauri/src-tauri/Cargo.toml --target aarch64-apple-ios --lib --offline
cargo test --manifest-path clients/tauri/src-tauri/Cargo.toml --lib --offline
```

Device Rust check passed without warnings after platform gating. Native tests:
6 passed (the loopback fixture test required sandbox permission to bind localhost).
GUI lint, TypeScript and the bundled frontend build passed. Desktop binary target
check passed. No simulator/device launch or archive validation is claimed.

## Continue after prerequisites are resolved

1. Complete and test the remote adapter on iOS; retain strict host verification,
   secure credential storage and remote-only execution.
2. Confirm permission to install the missing CLI support dependency, then generate
   the Xcode project with `npm exec tauri ios init -- --ci --skip-targets-install`
   from `clients/tauri`.
3. Confirm the existing Apple team/app/bundle and configure signing through Xcode's
   secure account UI. Never place passwords or production credentials in source.
4. Produce and inspect a device archive before any signed export or upload:
   `npm exec tauri ios build -- --ci --target aarch64 --no-sign --archive-only`.
   This unsigned output is not TestFlight-ready. Use the approved existing signing
   assets for a signed App Store Connect export only after the destination is known.
5. Validate/export/upload through Xcode after reporting the concrete destination.
   No automatic provisioning updates or resource creation are authorized here.

An iOS foreground client can display remote work, but cannot promise continuous
background streaming or an always-running local agent. A physical-device install
and TestFlight require the appropriate signing/distribution setup; a Rust check
alone does not provide an installable app.
