# Pibo visual refresh — 2026-10-27

Base: `e1b7d9739795e51ef1888b8a30c865d9b3e0a586` (approved logo plus native keyboard origin fix).
Branch: `feat/astra-visual-refresh`. Independent local checkout; no push, packaging or release.

## Result

The approved asymmetric coral pi raster is unchanged. A warm cream canvas, legible warm neutrals, coral actions and peach outgoing bubbles now unify chat, contacts, menus, dialogs, model settings and connection/recovery. Existing React, Radix and Tauri architecture remains in place. Bot avatars retain their own identity. No manual schedule creation UI was added.

- Shared VisualViewport sizing now covers startup and settings as well as chat.
- Dialogs fit the visible area; settings have a single bounded scroll region without a fixed minimum height. Radix portal padding is accounted for.
- Conversation details overlay the desktop chat without changing its width. The attachment menu stays above the whole multiline composer.
- Native iOS remains in phone layout in landscape even with a fine pointer. Desktop-only hiding no longer suppresses the phone back button.
- Draft textarea size is recalculated when its route becomes visible, with a 44px minimum even when initially measured while hidden.
- Successful bot creation opens its chat. Existing durable creation/idempotency behavior is retained.
- Model actions have a synchronous in-flight guard against duplicate clicks.
- Startup makes one automatic restoration attempt. On failure, the stable recovery view exposes configuration and explicit retry; saved identity is retained. Cancel disables automatic restore without clearing the remembered identity.

## Verification

Passed on this revision's code:

- `npm run gui:check`
- `npm run check`
- `npm run gui:build` (web assets only; existing large-chunk and dependency `use client` warnings remain)
- `node --check clients/tauri/test/ui/mock.js`
- 44 targeted tests: phone-regressions, gui-mobile-lifecycle, native-viewport, gui-presentation, gui-message-layout, gui-identity-color, gui-atomic-replies, pi-settings-client.
- 36 browser assertions in `astra-check.py` plus 5 in `astra-extra-check.py`.
- `git diff --check`

Browser assertions cover title-pill open/close geometry, multiline sizing, attachment placement, blank-name validation, cancellation, double creation/save, actual creation in a disposable daemon, unsaved model cancellation, simulated save/create failures, restore failure/configure, late-response cancellation, route navigation, and viewport containment at 393×852, 320×568, 874×402 and 874×250. Desktop checks at 1280×900 simulate the native Mac titlebar and verify overlay geometry.

The keyboard checks change the actual application's visible-height CSS variable and viewport. **These are desktop browser simulations, not physical iPhone, Safari/WKWebView or native simulator keyboard validation.** Native OS permission dialogs, real provider authentication, and paid model calls were not exercised. No user credentials were read, copied or configured. No Docker or runtime networking/security settings changed.

`21st search` was unavailable over the network; existing project primitives were reused. Local `21st review` completed with informational hardcoded-color suggestions for the palette definitions; no error-level findings or automatic changes.

## Reproduce locally

```sh
PIBO_UI_PORT=5193 node --import tsx clients/tauri/test/ui/serve.mjs
# In another terminal from this checkout:
python3 clients/tauri/test/ui/astra-check.py
python3 clients/tauri/test/ui/astra-extra-check.py
```

Requires the installed agent-browser CLI. Uses only `127.0.0.1`, a new temporary daemon directory, no-op session factory and clearly labeled fake provider/model data. The fixture intercepts model APIs; all remaining authentication operations are rejected in model QA mode. Native calls are mocked. `story=1` injects clearly labeled demonstration messages only in the QA entrypoint; it is absent from the production bundle. Avoid editing imported files during a browser pass because Vite hot reload can interrupt navigation.

Evidence is retained in ignored `artifacts/astra/`: original PNGs, browser assertion JSON, unit/build/review logs. Library IDs are recorded in `library-files.json` beside them. Initial core screenshots were saved before the final desktop checks; later evidence includes landscape and runtime recovery.

## Native iOS simulator follow-up

Environment: iPhone 17 simulator, iOS 26.4, Xcode 26.6 / iPhoneSimulator 26.5 SDK. The separate application identifier is `dev.pibot.astra-qa`. It uses the actual Tauri/Rust/WKWebView shell and this checkout's GUI, with an in-memory transport fixture and explicitly fake provider/models. Authentication calls are rejected. No real runtime, credentials, paid model call, Docker or network/security configuration is involved.

The native pass found issues that browser emulation did not expose: UIKit could briefly pan the outer page by 403px during keyboard transitions, and a landscape keyboard plus its accessory toolbar left only 126px of visible height. The final patch configures only the main iOS webview after page load: CSS owns safe-area insets, native outer gestures are disabled, and a scoped observer restores only the outer content offset synchronously at scale 1. DOM message/form scrolling remains separate. The non-scrolling chat shell uses `overflow:clip` to prevent focus from panning hidden overflow. Below 250px visible height, navigation and the input occupy one row; text remains scrollable and the keyboard can be dismissed to restore message history. OS status-bar behavior is unchanged.

Native acceptance source is `clients/tauri/test/ui/AstraNativeTests.swift`. It uses real XCTest taps, software keyboard typing and dragging, accessible control names, and `XCUIScreen.main.screenshot()`. The earlier `app.screenshot()` capture incorrectly cropped rotated content into a portrait canvas with a black region; direct simulator capture confirmed that particular black region was a capture artifact. The actual input obstruction and transient page movement were treated as failures until separately corrected.

Local evidence is in ignored `artifacts/astra-native/`: build logs, isolated fixture/config/project files, numeric layout reports, original screenshots and XCTest result bundles. `origin-flows.xcresult` is the final full-flow pass; `origin-flow-metrics.json` confirms the native guard was active and records 37 geometry changes with zero page/visual-viewport offsets. Chat header y stayed at 62 in portrait and landscape. Assertions include pill open/close, real keyboard, wrapped multiline input, model search/select/save, return navigation, rotation, and input containment above the actual keyboard accessory toolbar.

`origin-scroll.xcresult` also passed: three explicit keyboard open/close cycles, 12 synthetic sends with repeated focusing, real dragging back to early messages, and landscape form scrolling to its save action. Header/close-button positions stayed fixed. `origin-scroll-metrics.json` records 47 additional geometry changes with zero page/visual-viewport offsets. Together the final two runs contain 84 samples with no recurrence of the earlier 403px displacement. Controls were found by accessibility labels; this is not a VoiceOver audit.

Final GUI lint, TypeScript checking, production web build and 41 browser assertions passed again. The 44 targeted regression tests passed with local loopback access; the initial sandboxed run's two failures were `listen EPERM` test-server restrictions, not application assertions. Native Rust and Xcode simulator builds passed. A disk-full build failure was recovered by deleting only this task's regenerable caches and superseded result bundles, retaining failure logs, representative captures and final evidence; subsequent builds emitted only the required static library with incremental caching disabled.

This is simulator validation, not physical-device validation. VoiceOver, physical keyboard/IME behavior, real provider authentication, native permission prompts and production runtime connectivity were not tested. No push, release, IPA or TestFlight upload was performed.

The local native harness uses `artifacts/astra-native/tauri-qa.json` to point `frontendDist` at the bundled synthetic fixture. Build the Rust library with `CARGO_INCREMENTAL=0 TAURI_CONFIG="$(cat artifacts/astra-native/tauri-qa.json)" CARGO_TARGET_DIR="$PWD/artifacts/astra-native/cargo-target" cargo rustc --manifest-path clients/tauri/src-tauri/Cargo.toml --offline --target aarch64-apple-ios-sim --lib --features custom-protocol --crate-type staticlib`, then build the generated `PiboAstraQA.xcodeproj` for the simulator. Link the archive by its explicit path; a generic `-lpi_bot_desktop` can instead select the host-side dylib. Launch only the isolated QA identifier with `SIMCTL_CHILD_PIBOT_LAYOUT_DIAGNOSTICS=1`, then run the two native acceptance methods using the `PiboAstraUITests` scheme. Never point this fixture/test at the production app identifier.
