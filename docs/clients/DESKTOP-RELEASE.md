# Desktop preview and production packaging

The currently verified desktop target is **macOS Apple Silicon (arm64)**. The
source uses Tauri, but Windows/Linux installers and Intel Mac builds have not
been verified. These packaging scripts fail on other hosts instead of implying
those packages are ready. Mobile artifacts are built separately.

## Preview

From a clean checkout with Node 24+, Rust, Xcode command-line tools and installed
locked dependencies (`npm ci --ignore-scripts`, and `npm --prefix clients/tauri ci`):

```sh
npm --prefix clients/tauri run package:preview
```

- App: **Pi Bot Preview**, identifier `dev.pibot.desktop.preview`.
- Separate native app data and WebView storage from `dev.pibot.desktop`; it does
  not import production connection profiles, drafts or credentials.
- Latest shared GUI; desktop can connect to an existing local runtime or remote
  over system OpenSSH. It never starts/restarts an unrelated runtime implicitly.
- Local test build, ad-hoc signed, **not notarized**. Gatekeeper may require the
  user's normal explicit Open action; never disable global security settings.
- Output: `artifacts/releases/Pi-Bot-Preview-<version>-macos-arm64-<gitsha>.zip`,
  plus JSON metadata and SHA-256 sidecar. A dirty build is explicitly named dirty.

The script builds the GUI, uses the dedicated Tauri config, verifies the app's
signature and records client version, numeric build number, full source commit,
dirty status, identifier, architecture and installed Node/Rust/Xcode versions.
`PIBOT_BUILD_NUMBER` may supply 1-4 digits; otherwise Git commit count is used.
Version comes from `clients/tauri/package.json` and must be major.minor.patch.
Lockfiles and recorded inputs make a build reproducible in scope; ZIP timestamps,
SDK output and signing mean this is not a claim of byte-identical archives.

## Production

Production is **not ready for distribution on this Mac**: no usable Developer ID
identity, Apple Team or notarization profile was established. No Apple resources
have been created. A developer-account login alone does not provision those assets.

```sh
# References to EXISTING assets; obtain/approve missing assets separately.
export APPLE_SIGNING_IDENTITY='Developer ID Application: <existing identity>'
export PIBOT_NOTARY_PROFILE='<existing notarytool Keychain profile name>'
npm --prefix clients/tauri run package:prod
```

This fails before building if required references, a matching valid Developer ID
Application identity or clean source state are missing. It uses `dev.pibot.desktop`
and a hardened distribution signature. Without notarization, the ZIP is explicitly
**Production-Candidate**, and metadata says `productionReady: false`.

Only when an authorized operator explicitly wants to upload the artifact to Apple:

```sh
npm --prefix clients/tauri run package:prod -- --notarize
```

That flag submits via `notarytool --keychain-profile`, waits for Accepted, staples,
validates and assesses the bundle, then creates a distribution ZIP. It is the only
upload path in this script. Preview never uploads. Ambient Apple ID/API/password
variables are removed from the Tauri build environment to prevent implicit upload.
Never place Apple passwords, API keys, certificates or private keys in source/config.
No production signing, notarization or publishing has been executed in this task.

## Runtime and mobile status

The app is a client, not a bundled agent distribution. Existing daemon protocol
must match, and the daemon must already be running. Desktop SSH uses system
OpenSSH, existing auth and strict known-host verification. iOS/Android use embedded
SSH with a separately verified full server public-key pin, never accept-any trust.

- iOS: remote-only, simulator checked, unsigned device archive exists; TestFlight
  remains blocked on the user's Apple account/team/signing destination.
- Android: remote-only arm64 debug APK, session-only native secrets; see
  [Android build and verification](ANDROID-TEST-BUILD.md).
- Completed replies appear atomically, with bot-owned Running state and
  runtime-scoped conversation pins shared across clients.

## Verified Preview (2026-10-15)

`Pi-Bot-Preview-0.1.0-macos-arm64-0e95f03.zip` was built from clean commit
`0e95f03b90812f8642efc7647d5c48cc9c73bc3f`, version0.1.0/build48. Ad-hoc
signature and bundle ID were verified and the isolated application launched.
SHA256: `2abe6781d1376c83cdd3255d053288f874f9ab4caf7ae220def1d1860073c0e9`.
No desktop visual QA or Gatekeeper-approved distribution is claimed. The original
Mac test ZIP is unchanged. Production preflight was tested with absent signing
references and stopped before building or uploading. Subsequent script guards
check the version/build/identifier after packaging.
