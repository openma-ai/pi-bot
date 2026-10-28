# Astra connection-state and native-window follow-up — 2026-10-27

Branch: `feat/astra-visual-refresh`, following `5002e1a` / `7668c95`. No push, release, installation over the production app, or TestFlight upload.

## Final behavior

- Loading is a small spinner beside the chat/list title. Failure shows “连接失败 · 设置” in that same row. No-runtime state says “未连接 · 设置”. Following the latest user feedback, a low, soft rounded rectangle surrounds that compact state: 32px visual height, with a 44px Settings hit target. The full-width colored strip and repeated center/sidebar instructions remain removed.
- A transport loss retains the same workspace's conversation, draft and navigation in memory. The disconnected client cannot send or resolve requests. Connecting another workspace mounts a fresh store, clearing the previous workspace's visible data. This is not a persistent/offline message cache.
- First-time connection, cancellation and switching are handled in Settings. The full-screen recovery component has been removed.
- Settings presents connection targets as a compact list. The unpublished installer is inside an optional disclosure. A local target says it needs an independently running service. Connection failures are not duplicated in a toast.
- The visible “置顶” heading is removed; pin functionality, ordering and accessible group naming remain.
- On native Mac, the conversation heading shares the existing 52px native toolbar row. Window controls and drag regions remain. Browser and iOS layouts do not acquire this Mac-only fixed heading.
- The approved π raster is unchanged. The macOS ICNS now has a deterministic 824px rounded container on a transparent 1024px canvas, with padding and a small shadow. iOS assets remain unchanged. `scripts/brand/macos-icon.swift` and the existing generator reproduce it.

## Actual local development entry

`artifacts/development/Pibo Development.app` is an independent local development wrapper around the compiled debug binary, with identifier `dev.pibot.desktop.development`. It loads this checkout's real native bridge and GUI from `http://127.0.0.1:5194` and is left running. It is not a fixture runtime and does not replace the installed Pi Bot Preview.

`clients/tauri/scripts/dev-gui.mjs` provides loopback-only hot reload. `clients/tauri/tauri.dev.conf.json` gives `npm run dev` an isolated identifier. The current binary was built offline with `embedded-tailscale`, using the already-installed native archive; compiling this feature does not start a node or log in. Reproducing this variant uses `npm run dev -- --features embedded-tailscale` with `PIBO_TAILSCALE_LIB_DIR` pointing to the existing native archive; plain `npm run dev` is the standalone GUI/native build without that optional feature.

For this Mac, the existing Tauri CLI was in the 2026-10-21 checkout, and Cargo dependencies were reused from the 2026-10-25 `pibo-main-integration` target directory. No disk cleanup was performed in this follow-up. The current checkout initially lacked a CLI executable and Rust cache. The native app was successfully compiled and observed through native accessibility and screenshots.

### Why the earlier browser did not reply

Port 5193 runs `clients/tauri/test/ui/serve.mjs`, an isolated UI acceptance fixture. Its factory's `run` is empty; the story is synthetic. It cannot make real model calls. Opening that page was insufficient for the requested usable development application. Its synthetic send path now rejects requests instead of silently accepting more work. The original `mac=1` fixture query also deliberately simulated a native toolbar in Chrome; it was not evidence that the real browser needed native titlebar padding.

### Real runtime boundary

The parent supplied the existing real endpoint `100.127.171.114:4319` and container `pibo-tailnet-test-live-1`. Read-only inspection confirmed the container is running. Requests from the Mac to `/pibo/service` and `/readyz` timed out after five seconds. A container-local loopback discovery request returned 403, while the Tailnet-address request timed out. The user subsequently confirmed that the Mac OS is not in the Tailnet: host curl timeouts are therefore expected and are not evidence that the runtime is unhealthy. The client uses its own embedded network. No authorization bypass, restart, network adjustment or credential read was attempted.

The native Settings > Add connection > Tailscale form was filled with this host and port, and left open. A fresh read-only status request through the actual native bridge returned NeedsLogin, rendered as “等待登录应用内网络”, with “打开授权页面” available. The app is not yet Running. Network login/authorization and the service password were not submitted; completing this application login does not require a system Tailscale VPN. Model configuration is unknown. Therefore real assistant replies remain unverified; an open native window is not a successful model connection.

## Computer Use / VNC implementation audit

This audit is of code, not a claim that the user's host has enabled these capabilities.

- `src/daemon/core/daemon.ts`: `DesktopClient.load(resolve('work/gui/desktop/control.json'))`; snapshot reports only `desktop: !!this.desktop`.
- `src/pi/desktop-client.ts`, `DesktopClient.load`: loads a configured loopback endpoint; no readiness probe. `desktop_list` reports Linux with runtime/container location.
- `src/daemon/core/router.ts`: initialize capabilities contain transports/request kinds, not a supported/configured/reachable/ready desktop status object.
- `src/gui/main.jsx`: Computer tab is always present; its panel is enabled by the snapshot boolean and a connected API.
- `src/gui/DesktopPanel.jsx`: `/bind` success sets local `ready`; a real noVNC `connect` happens only when the viewer opens. Generic binding/screenshot errors become “屏幕暂不可用”; native authentication errors have a separate message.
- `src/daemon/desktop-service.ts`: checks Chromium CDP when starting; exposes `computer_use_linux_doctor` only when explicitly dispatched. Binding searches an X11 window and spawns x11vnc, so it is not a harmless passive capability check.
- `src/daemon/transports/http.ts` and `clients/tauri/src-tauri/src/desktop_transport.rs`: actual screenshot/WS/TLS requests can fail at use time, but do not supply the missing capability-state model.

There is no complete separation of support, configuration, reachability and readiness, and no detected Mac Screen Recording/Accessibility or system-VNC enabled status. No Computer Use/VNC service was enabled by this task.

## Verification and limits

Evidence is under `artifacts/disconnect-review/`. Browser regression exercises retained messages/drafts, disabled writes, Settings open/close, duplicate connection clicks, stable failure, same-workspace reconnect, cross-workspace clearing, cold start, cancellation of a late success, first configuration, narrow/landscape/very short viewports and desktop toolbar positioning. All 37 original checks passed; the latest follow-up adds Enter/Escape dismissal checks for 39 passing browser checks. An earlier failure was traced to an ambiguous test locator matching a different connection action; scoping to the runtime row and observing active transport/SDK readiness resolved it. The final pass checks both normal and 874×192 short landscape layouts. The 44 focused unit tests, GUI lint, repository typecheck, GUI build and native embedded-Tailscale debug build passed. The 21st review completed with 52 informational color findings in the existing token stylesheet; its inspiration search was unavailable (fetch failed), and no external component was installed.

Actual Mac native verification: new app launched, updated toolbar rendered with no duplicate row, Settings rendered as a list, add-connection and Tailscale fields accessible, known host entered without login. A drag was exercised through the retained toolbar region without a tool error; global window displacement was not independently measured.

The Dock ICNS and local app's icon reference were updated. A repeated `cua.getApp('com.apple.dock')` returned `timeoutReached`. A supported system-window capture then succeeded: the existing Screen Recording permission was checked read-only, the visible Dock window ID was resolved, and only that window was captured. Its actual π icon has rounded corners and surrounding clearance. `libfile_7c82f3f868688191a19461465a8ed94c` records the result. The question-mark item remains unchanged; its ownership is not inferred. No Dock item or system permission was changed.

### Current native follow-up

Actual iPhone 17 / iOS 26.4 Simulator testing uses the separately identified `dev.pibot.astra-qa` Tauri/WKWebView app with isolated, explicitly synthetic runtime/model data. It makes no real authentication or model calls.

`testInternalScrolling` also passes in the same run: native message scrolling reaches the oldest synthetic message, and the landscape model form scrolls to its save action while its header remains fixed. The combined result is 2 tests, 0 failures (145.413s).

The new `testInlineConnectionRecovery` passes in `artifacts/astra-native/uitests/touch-close.xcresult` (71.314s), and again on final source in `artifacts/astra-native/uitests/delivery.xcresult` (71.075s), including the assertion that an offline empty chat does not invite sending. It covers disconnect, retained multiline draft, title position, repeated actual software-keyboard open/close, cancelling a delayed connection, cancelling an address form, landscape input, Settings access, a drag that must not activate Close, successful landscape close/back, and returning to the portrait conversation list.

Two native failures were diagnosed and repaired rather than marked as passes:

- The runtime menu's default body portal could leave the Settings content absent from iOS accessibility after dismissal. Keeping its default modal semantics and rendering the menu inside the current Settings content fixes that focus/accessibility restoration. The non-modal experiments were discarded.
- After landscape keyboard dismissal, the Settings Close button received pointerdown and pointerup at its actual coordinates but no synthesized click. `rounded-metrics.json` records this failure; the dialog remained open. A narrow native-iOS primary-touch fallback closes only on a stationary touch ending on the Close button. Pointer cancellation or movement over 8px cancels it. Dialog.Close still handles ordinary click, keyboard and assistive activation. It does not change scrolling or intercept events on message/form regions.

Failing result bundles and diagnostics are retained alongside the passing run; the previous failures were genuine, not just missing test selectors. This is simulator validation, not physical-iPhone validation. Windows/Android native were not run.

The latest Mac window recapture is blocked: Computer Use reports that the Mac is locked and automatic unlock failed. Manual unlock is required for that window inspection. The independent native app PID 79598 is still running (production Preview PID 684 remains untouched), and the loopback frontend on port 5194 is still listening, and its log confirms the latest CSS hot update; that alone is not a new visual-verification claim. The previously verified Dock screenshot remains valid. No system permission or unlock setting was changed.

Library input `libfile_cd0e32ea1dbc81918ca755d5f0a84dc5` could not be materialized: two supported transfer attempts returned `download failed`; the read action returned metadata/text but no accessible pixels. The prior local failure-page image was inspected, and the parent's later pixel descriptions were used; pixel equality with the attachment is not claimed.

Latest screenshots (distinguished by environment):

- Rounded status and preserved draft, native iOS Simulator QA: `libfile_e54afd056d94819188027c89ab25bfc8`.
- Landscape keyboard, native iOS Simulator QA: `libfile_7ce8ffba72b481918b3e4ad668550c95`.
- Successful close/back to list, native iOS Simulator QA: `libfile_31cd9ec3da548191b8532ffb02d25cb8`.
- Landscape model form scrolled to Save, native iOS Simulator QA: `libfile_bf4f2f7971ec81918648f081aeec1fd7`.
- Rounded status, desktop browser QA (synthetic data): `libfile_46f31e7269cc819195af0ddc93421a9a`.
- Rounded status, phone browser QA (synthetic data): `libfile_f9505c4786f88191bf395cf5e0af9bbd`.
- Actual Dock window: `libfile_7c82f3f868688191a19461465a8ed94c`.
- Earlier actual Mac title-inline state, before rounded treatment: `libfile_8337ebd508588191aa5acaae9adb1026`.
- Actual embedded network NeedsLogin, known host filled: `libfile_416f3bba7d288191a9b28b0165edb03f`.

Earlier delivered screenshots (superseded where shown above):

- Offline chat, browser fixture: `libfile_ffd9e42f2d2c81918c66856a79ffeb70`.
- Actual Mac toolbar/window: `libfile_bb8f1ebfaea8819180ca482da1eb699c`.
- Actual Mac connection list: `libfile_fc4c1fd70f748191881689c0d41ae90e`.
- Actual Mac known runtime address, awaiting user login: `libfile_4d85ed5aeae08191ba6bbed0dbd47b2e`.

Final source checks: 39 browser checks (including Enter/Escape dismissal), GUI lint, TypeScript check and GUI production build pass. The final screenshot review also suppresses the empty conversation send invitation while disconnected; this does not hide existing messages or drafts.

## Mac follow-up after unlock

The actual `b009c05` development window was captured on 2026-10-27 after the user unlocked the Mac. `libfile_ccf2bac17fc88191a5b4385fff3eecd1` is the original system-window screenshot, not a browser fixture. Pixel inspection confirms the small rounded “未连接 · 设置” state beside the title, no repeated top spacer, the retained sidebar and bottom Settings entry, and visible native traffic-light controls. No new visual regression was found in that view.

The original development app remains PID 79598; production Preview remains PID 684. Port 5194 had stopped listening and was restored. The frontend now runs detached as PID 97186 (PPID 1), bound only to 127.0.0.1:5194; a fresh request returned HTTP 200. A transport-disconnected tool result initially obscured the startup outcome; PID/file/process/HTTP checks later confirmed success, so no duplicate startup was attempted. The temporary transport outage recovered.

This turn's native interaction tool was unavailable. Therefore clicking Settings, dragging the window, and freshly reading the embedded Tailscale status were not revalidated in this follow-up. Only their visible controls were inspected. Previous NeedsLogin evidence is historical, not a new login-status reading. No login, credential, network or permission change was made. No product code changed in this follow-up.
