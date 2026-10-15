# Conversation navigation and feedback verification

Branch: `feat/minimal-apple-clients`, based on `1c7e1ea`. This checkpoint preserves the prior uncommitted avatar sizing, sidebar width, loading phases and scoped activity work.

## Changes

- Pin/unpin live in Radix context menus on ordinary rows and pinned tiles. Left click navigates. Shift+F10/Menu opens the menu. Radix's 700ms touch/pen hold cancels on pointer movement/cancel/up; the post-hold click is suppressed. Actual iOS touch scrolling remains unverified.
- Pinned tiles form a centered wrapping group. Collapsed rail search/new actions sit above settings, with one centered 44px target column. Native titlebar styles now apply only to the header toolbar, preventing footer offset/drag interception.
- Connection state uses a small neutral status capsule with supported connection-settings action. Connecting/loading/reconnecting/offline are distinct; successful recovery appears briefly. No assertion that drafts are durably saved.
- Send failures stay beside the attempted text. Explicit retry retains the original idempotency key, content and conversation scope; uncertain/conflicting results offer status inspection. No automatic write replay. Draft edits are not cleared when a prior attempt finishes.
- Native reconnect supplies the SDK auth-refresh callback because native authentication is owned by Rust, not a browser CSRF session. Rust endpoint authentication remains unchanged.
- Existing `pi-sidebar-width` localStorage is read synchronously during state initialization and written only on explicit desktop resize/toggle. No duplicate persistence state added. Phone route state remains independent.

## Actual checks

- `npm run gui:check`: passed.
- `npx tsc --noEmit`: passed.
- `node --import tsx --test test/gui-presentation.test.ts test/sdk-client.test.ts`: 10 passed.
- Tauri GUI production bundle + debug macOS app build: passed; app ~39.90 MiB.
- Native macOS UI: ordinary right-click opened pin menu without changing chat; Escape dismissed; keyboard Tab then Shift+F10 opened menu; Return pinned; pinned tile context menu unpinned. Ordinary left-click still selected conversation.
- Two pins restored after app restart. Centered two-card group checked expanded and 360px phone list. Narrow menu checked. Populated zero-pin and single-pin states were also exercised through unpin menus; single tile centered and zero pins removed the strip. Local screenshots `pins-centered-one.png` and `pins-zero.png` capture these cases.
- Collapsed search opened search dialog; new action opened bot/group menu. No duplicated top controls in collapsed state. Expanded top toolbar and phone list header remained present.
- Collapsed width 76 restored across multiple app relaunches. Explicit expanded width 281 restored on initial relaunch. Phone list/chat route changes and 360px-to-1100px resize preserved desktop width 76.
- Screenshot glyph bounding-box horizontal centers (2x raster) for pinned/regular avatars/search/plus/settings: 74.5–78px, within 1.75 CSS px; asymmetrical glyph shapes account for the small difference. Targets share the 38 CSS px rail centerline by layout.
- Controlled fixture `ui-fail-send` rejected `turn/start` before execution; adjacent failure + retry appeared; removing switch and explicitly retrying produced one user message and one reply, cleared failure and unchanged draft. No real model or external action ran.
- Controlled fixture `ui-offline` closed SSE and rejected RPC. Reconnecting capsule appeared, send disabled, draft remained editable. Removing switch automatically recovered; AX showed `已恢复连接`, send enabled and unsent draft unchanged. Both desktop and 360px reconnecting layout captured.
- Fixture reconnect handshake corrected to create a fresh daemon connection for initialize, matching production HTTP behavior.

## Evidence

Before: user reference `libfile_298919e6f6ec8191ad1f4985c4992de1` (heavy connection bar), `libfile_8d55919807b88191b91e3fb9cfd7a3ba` (collapsed toolbar placement), `libfile_d3657a40afd88191add80abcdbb61a83` (visible pin action).

After, Library version 0:
- `icon-track-collapsed.png`: `libfile_7ff2c07d30f48191bc551dabadd2429d`
- `pins-centered-phone.png`: `libfile_802c2f3c4458819193a25adca9bcef33`
- `context-menu-phone.png`: `libfile_d813a8eca7e48191ba5ca36f08e4979c`
- `send-failure.png`: `libfile_018dc5bd143c8191a1ee60b106360459`
- `connection-phone.png`: `libfile_96baaecf54f48191a2c648223798b9db`
- `connection-recovered.png`: `libfile_bbbad4e05f0081918e46292705a08a7b`

Additional local images include expanded centered pins and desktop context menu. Old ZIP `Pi-Bot-Mac-Test-1c7e1ea-arm64.zip` was not replaced; these changes are not in that package. No push, deployment, real remote access or credential creation. Actual iOS build, touch gestures and VoiceOver remain unverified. The previous extracted Test app launch attempt was aborted/uncertain; it was not retried in this pass. Standard development app was used instead.

Run: `cd clients/tauri && npm run build:gui && npm exec tauri build -- --debug --bundles app`. Disposable fixture: `node --import tsx clients/tauri/test/fixture-server.ts /tmp/pi-bot-navigation-fixture-20261014 --requests --navigation`. Only the disposable fixture was restarted; original user daemon processes were untouched.
