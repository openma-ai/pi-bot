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

## Dependency clarification (read-only follow-up)

No install was retried while permission/team selection is pending.

The installed CLI is 2.12.2; its native binary embeds cargo-mobile2 0.22.5 source
paths. The actual failing child command was `brew reinstall libimobiledevice`
(exit 1), not `pod install`. Tauri's project generator wraps dependency errors
under a `pod install` label before invoking XcodeGen, which explains the misleading
outer error. Homebrew reported non-writable targets under `/opt/homebrew`
(including `Cellar`, `bin`, `lib`, `opt` and Homebrew state/lock directories), plus
`~/Library/Caches/Homebrew` and `~/Library/Logs/Homebrew`. This was an ordinary
sandbox filesystem failure, not an automatic approval-review rejection.

CLI 2.12.2's public init options have no skip-device-dependencies flag.
`--skip-targets-install` skips only rustup target installation; `--ci` suppresses
prompts; neither skips the unconditional dependency installer. Its source calls
`deps::install_all(..., true, ...)` before rendering files: that `true` skips the
optional Rust Xcode debugging plugin, not the package loop. Upstream cargo-mobile2
checks `idevicesyslog` for the libimobiledevice package. The package loop also checks
XcodeGen and CocoaPods, both already installed here. No fake executables, patched
CLI, dependency shims or Homebrew permission changes were used.

libimobiledevice is device communication tooling, not a Rust target library or an
Xcode archive linker input. Thus it is a practical prerequisite for this CLI's
standard initialization path, even when preparing a simulator or unsigned archive;
it is not intrinsically required to compile an already-generated Xcode project.
The machine already has Apple's `xcrun devicectl` for modern device tooling.
A manually maintained official-template/XcodeGen project could avoid that init
policy, but there is no documented CLI skip switch and no such alternative project
has been generated or validated. Installing the one missing package after approval
is the smallest standard route; custom project generation adds maintenance work.

Sources inspected:

- Exact CLI version project generator: https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-cli/src/mobile/ios/project.rs
- Exact CLI init options: https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-cli/src/mobile/ios/mod.rs
- Upstream dependency implementation (dev branch, corroborating observed command/binary strings): https://github.com/tauri-apps/cargo-mobile2/blob/dev/src/apple/deps/mod.rs

No iOS transport currently succeeds: `transport::connect` always returns an error
on iOS, and the separate `ssh-spike` is not an app dependency. It tests a host-key
comparison and sketches a direct-TCP channel; it has no key loading, login,
credential persistence, discovery integration or app HTTP/SSE wiring. There is no
implemented direct HTTPS/WebSocket remote fallback. Remote transport remains the
largest code/validation gap, not a packaging flag. A simulator shell could test UI
and explicit unsupported-connection errors first; an honest remote-client
TestFlight build requires the adapter and actual iOS remote send/stream/reconnect
verification before distribution.
