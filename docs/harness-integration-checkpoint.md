# Harness integration checkpoint — 2026-10-27

Branch: `feat/astra-visual-refresh`. Local development only; nothing pushed,
released, notarized, uploaded to TestFlight, or installed as a host service.

Follow-up build resource checks, current space requirements and other desktop
packaging boundaries: [build preflight](harness-build-preflight-20261027.md).
The follow-up cached-container smoke verifies real readiness, the exact Docker
health script, missing-model rejection, same-volume persistence and clean stops;
see [persistent-container evidence](harness-docker-persistence-evidence.json).
It does not close the new-image build gap.

## Verified stages

- `d435225`: unified desktop capability report and tool gating. See
  [capability contract and Linux evidence](harness-capabilities.md).
- `abcb273`: independent installation and Docker deployment. See
  [installation/deployment guide](harness-deployment.md) and
  [real lifecycle evidence](harness-deployment-validation.md).
- `c1a0280`: app-owned desktop harness, isolated resource/data lifecycle,
  bounded package discovery, and native SDK build paths. The preserved
  candidate manifest records its earlier base commit plus `sourceDirty: true`,
  rather than claiming the earlier commit alone contains its complete inputs.
- Frontend first connection offers compact desktop local/remote choices and a
  mobile Settings entry. A returning connection restores once; failures remain
  in the messenger with a short Settings action. Protected builtin profile is
  distinct from an independently running local daemon. Missing bundled files
  disable the local action.
- Native dev and UI QA now use separate Vite dependency caches. Concurrent QA
  previously removed the native Tauri import bundle; the actual Mac Settings
  UI was verified working again after isolation. Settings tolerates a missing
  status response without rendering a fake connection or throwing on null.
- SDK/runtime restoration tests: 11/11. Layer tests: 9/9. Integrated desktop
  capability/mobile lifecycle/phone regression: 26/26. `npm run check`,
  `npm run gui:check` and production GUI build pass. First-connection browser QA is 21/21 after
  fixing the mobile button contrast (the sidebar reset had erased its fill). Build emits existing
  dependency directive warnings. 21st review found only existing color-token
  information notices in brand.css (52), no automated changes applied.
- Final macOS native suite: 18/18, including the real bundled lifecycle (no
  ignored tests). Detailed hashes, resource provenance, and logs are recorded
  in [native validation evidence](clients/HARNESS-VALIDATION-2026-10-27.json).

## Actual Mac app result — incomplete

The new app is `artifacts/development-harness-next/Pibo Development.app`, with
identifier `dev.pibot.desktop.development`, hot frontend on loopback 5194 and
actual Node/daemon resources inside the bundle. The old development bundle and
installed production application are preserved.

The real native first-run screen was inspected through CUA and saved as
`artifacts/harness-landing/10-real-macos-first-run.png`, Library
`libfile_458515d27f548191a94a2cb703c2bb90`.

Two actual clicks of **在本机开始** reached the 35-second timeout. The owned
child was cleaned up; no daemon discovery file was created. This is a failed
native integration result, despite passing isolated lifecycle tests with the
same SDK and resource bundle. Do not present the screenshot as a connected
runtime or usable model conversation.

System logs tie those attempts to a pending Documents access request for
`dev.pibot.desktop.development` (`tccd` message 415.387 at 23:56:24.476). A
negative Full Disk Access preflight is not a user denial. No consent was
granted and no privacy/network setting changed. Exact accessed paths are
redacted by macOS. An isolated denied-outside-bundle filesystem probe identified
`pi-subagents` 0.77.0 walking from the launcher to ancestor `package.json` files
(including Documents). The bundle-only search boundary, self-contained TypeScript configuration
and explicit TSX configuration have now passed an isolated filesystem guard:
zero attempted reads outside bundle/test-home, and runtime creation is reached.
The complete acceptance test against the app's actual Resources now passes
(1/1, 8.34 seconds), including real protocol initialization, missing-model
rejection, duplicate start, stop/restart, crash recovery, and parent-pipe cleanup.
The guarded startup records zero outside-root read attempts. This fixes the
observed dependency search defect; actual native click verification remains
pending, so it is not yet proof that the GUI launch is fixed.

The corrected candidate is
`artifacts/development-harness-ready/Pibo Development.app`. Its bundled harness
contains 522 packages (441.7 MiB of uncompressed resource files) and passes the
local deep/strict signature check. The previously running `development-harness-next`
process was not replaced underneath the user. The next native acceptance step
is to quit that development process, open the corrected candidate, and choose
**在本机开始**, then verify connection, a clear missing-model error, and stop/return.
It must not reuse a fixture or request model credentials to prove startup.

The Mac subsequently locked. Native UI tooling explicitly requires manual
unlock, so the next click/screenshot is blocked, not passed. Independent tests
continue; no alternate UI mechanism is used to bypass the lock.

Mobile first-connection screenshot (browser QA, not native iOS):
`libfile_0e77ec16d78c8191b6fc569ccba7e601`.

## Scope boundaries

- macOS userspace Tailscale is actually linked into the dev executable. iOS
  Tailscale was previously confirmed by the user; this task does not relogin.
- Android arm64 userspace SDK library generation and `cargo check --offline
  --locked --target aarch64-linux-android --features embedded-tailscale --lib`
  pass. MainActivity with real Tauri/Wry Kotlin sources and strict NDK SDK
  linking also pass; see [Android compile evidence](harness-android-build-evidence.json).
  The app-cache path correction also passes a final offline Rust check (3.85
  seconds). This is not an authenticated device test: actual cache creation,
  JNI execution, SDK login, and full APK build remain unverified. No node was
  started or enrolled.
- The bundled desktop harness currently ships for macOS arm64. Windows, Linux
  desktop, and Intel Mac resource packaging are not implemented/validated by
  this checkpoint; their unsupported build resources must not be shown as ready.
- Plain browser pages use their existing server bridge; they cannot pretend
  to contain native tsnet. Remote direct transport requires HTTPS; loopback
  HTTP and encrypted Tailnet transport retain the existing service auth rules.
- Computer Use currently uses the configured Linux X11 companion. Native Mac
  Computer Use remains unsupported, and Mac screen permission remains unknown.
- No paid model requests, OAuth, copied provider credentials, system VNC,
  firewall/routing changes, or existing runtime data migration were performed.
