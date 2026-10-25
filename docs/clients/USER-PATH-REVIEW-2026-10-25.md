# Pibo user-path screenshots and composer menu review

Date: 2026-10-25. Base revision: 0950971. Changes made only in the independent checkout `/Users/xiaoyang/Documents/Codex/2026-10-25/task/pibo-menu-review`; original checkout retained read-only. No app signing, upload, git push, deployment, account changes, real model execution or changes to the user's existing bots.

## Implemented menu behavior

Existing Radix DropdownMenu now measures the entire composer shell rather than anchoring only above the plus button. It stays left-aligned and 8px above the shell including text and previews, never flips down, and scrolls within the remaining height. Existing Photos/File actions, native hidden inputs, focus behavior, outside-click and Escape remain intact. User reference: libfile_35529e89dd6c81919e17605bf7060a65 (actual pixels inspected).

## Evidence provenance

01–04: previously captured isolated browser connection fixtures. 05: mislabeled file; pixels are a bot list, identical to 06, not connecting. 06–08: existing audit files labeled browser local runtime; pixels show the local verification bot, empty chat and multiline input. This report does not independently attest to a native runtime or device for these inherited captures.

10–14 and 42: actual React composer rendered in the explicitly labeled OFFLINE UI FIXTURE. 15–41 and 43–51: actual full application rendered with isolated in-memory runtime/RPC/native-bridge fixtures. Synthetic bots, service URLs, test password and attachments only. All new captures use the modified source; no real model responses are fabricated as successful work. Message processing/failure states are explicitly injected protocol fixture states.

None of these are native iPhone screenshots. 402x390 and 874x250 simulate keyboard height, not a real iOS keyboard. 09 is obsolete and intentionally excluded.

## Finite coverage table

| User path | Evidence | Result / boundary |
|---|---|---|
| First connection, Tailscale login, HTTPS form, wrong password | 01–04 | Real rendered forms; native/network outcomes mocked |
| Connecting, cancel, successful password login | 38–41 | Actual UI operations; cancellation remains disconnected after pending fixture completion |
| Bot list, empty list and chat/back | 06–08, 15, 18, 43 | List/chat/back exercised; empty state captured |
| Create bot and rapid repeated submit | 16–17 | Two immediate button clicks => exactly one bot/create RPC; only synthetic bot created |
| Chinese multiline input, IME and Shift+Enter | 08, 11, 19; browser-qa-results.json | IME Enter and Shift+Enter do not send; Enter sends once |
| Attachment menu empty/multiline/thumbnail/small/keyboard | 10–14, 19–20, 42 | Five viewport geometry assertions pass; outside/Escape close |
| Photo/file selection and removal | 20–21 | Actual hidden inputs and synthetic files; removal leaves no selected preview |
| Upload cancellation, send, integrity download/export | 21–25, 49 | Cancel leaves no pending attachment; queued send event; SHA-256 download/export bridge invoked; native share sheet not opened |
| Message queued/processing/error | 22–24 | Explicit protocol fixture states; real view renders them; no paid model execution |
| Conversation details, schedule/monitor forms, avatar | 26–27, 50–51 | Forms opened, cancelled; no routine enabled or avatar saved |
| Desktop preview/open/return | 28–29 | Synthetic preview; unavailable live stream displays reconnect state; closed and returned; no desktop lease taken |
| Runtime settings/switch/disconnect | 30, 32–33 | Second synthetic runtime activated; explicit disconnect clears active and disables restoration |
| Cold start restore/offline/reconnect | 34–37 | Actual useRuntime hook; failed connection then retry succeeds (two connect RPCs) |
| Model failure/empty config/auth management | 31, 47–48 | Rendered unavailable and unconfigured states, no real credentials read or entered |
| Global search no results | 44 | Actual search dialog and empty result state |
| Group create and chat | 45–46 | Actual form and group route; only in-memory synthetic group created |

## Validation

- TypeScript check passed; GUI ESLint passed; 21st deterministic review: 1 file, 0 findings.
- Existing connection-flow, file-transfer, GUI-presentation and native-viewport tests: 18 passed, 0 failed. Initial sandbox loopback restriction resolved by running those isolated tests with approved local socket access.
- GUI production bundle passed using Vite config runner (avoids writing shared dependency cache). Existing use-client/chunk-size warnings remain.
- Browser geometry: 402x874, 320x568, 402x390, 874x402, 874x250; menu left matches shell left, menu bottom is shell top minus 8px, no page overflow, menu remains above with bounded scrolling.
- Reproducible local browser assertions and full isolated fixtures retained under ignored artifacts/review/. browser-qa-results.json contains measurements.

## Remaining boundaries and observed issues

Native picker dismissal, photo permissions, actual software keyboard/safe-area behavior, real Keychain persistence across restart, live Tailnet, paid model output, provider OAuth/API-key login, live noVNC connection/control and system share-sheet delivery are not verified here. These require authorized device/service checks. Browser hidden-input selection, upload cancellation and export bridge are covered; this is not a claim that the native dialogs were exercised.

Existing detail/schedule/monitor overlays show a horizontal bottom scrollbar in the phone fixture (26–29, 50). It is outside the menu positioning change and remains an explicit UI follow-up. No indefinite permutation coverage or routine execution is claimed. Other task/job detail and collaboration execution states were not exhaustively generated because they require fixture expansion or executing work beyond this review.

The first four connection screenshots can be reused; 05 must not be described as connecting. 06 visibly contains one local verification bot, not an empty list. New 38 is the actual connecting screen.

## Native Library screenshot manifest

| File | library_file_id |
|---|---|
| 01-first-connection-browser-fixture.png | libfile_6914c3389ef481918c58830316da7ca6 |
| 02-tailnet-login-browser-fixture.png | libfile_f29aa07d1bc48191ac63fec5604edc09 |
| 03-https-password-browser-fixture.png | libfile_4f2690023e84819185f3a2aa4b9a0fbf |
| 04-password-error-browser-fixture.png | libfile_8c167803c8308191a94b8c6024c39676 |
| 05-connecting-browser-fixture.png | libfile_4ec00de0b2d881918691734f999d879c |
| 06-bot-list-browser-local-runtime.png | libfile_b324f4ff87b481918a2abd0586a6884f |
| 07-chat-empty-browser-local-runtime.png | libfile_d73e422ce0d88191bde5a0f289f6df2b |
| 08-composer-multiline-browser-local-runtime.png | libfile_a59adae6aa088191b40212fac05cbb4b |
| 10-menu-empty.png | libfile_9cada822f9308191a9e3cdafab9916ad |
| 11-menu-multiline.png | libfile_20e868763b7c8191a4b4e5d2435fc8d7 |
| 12-menu-thumbnail.png | libfile_892019f659348191a6cf2a1e7ee518d6 |
| 13-menu-keyboard-height.png | libfile_da85c3b23d6c8191b1cd6b2df1416559 |
| 14-menu-small-phone.png | libfile_7dc34e7364748191a29529f117bcd473 |
| 15-app-bot-list-fixture.png | libfile_20a4d59bd00c8191b76a631d2822def5 |
| 16-create-bot.png | libfile_3a561f9dcdb88191ac4fd296e3e40580 |
| 17-create-single-flight.png | libfile_245248733800819192d0e5b343980f6f |
| 18-app-chat-empty.png | libfile_5f0fe12fcbdc8191a06e222790c76448 |
| 19-app-menu-fixed.png | libfile_d4096b906dd48191ae30b82fbb46691d |
| 20-app-image-menu.png | libfile_7eb4c8051e848191a0b7b7a95ac19a6c |
| 21-file-ready.png | libfile_b43a77825c4c81918cecf154c9e8a509 |
| 22-message-queued.png | libfile_22ce429558988191867827d8485a416f |
| 23-message-processing.png | libfile_fbc60f91cc0c8191bae910260046c5de |
| 24-send-error.png | libfile_ebb19be5ada881919091a7561d7c8cf4 |
| 25-upload-cancel.png | libfile_15804a6400308191866caba62e4343d2 |
| 26-chat-details.png | libfile_09e08bf14c6c8191a081a0560b1c3d80 |
| 27-schedule-form.png | libfile_d514d360a10c8191882cd6b6c1bc10bf |
| 28-desktop-preview.png | libfile_d11a20a4097481918e329097e9e287b1 |
| 29-desktop-open-offline.png | libfile_b558db61cd3881919bf9355316dda245 |
| 30-runtime-settings.png | libfile_110289b3d9548191811e425f8a9e1a1c |
| 31-model-unavailable.png | libfile_184db4c43dfc819190027b1bfe5f0901 |
| 32-runtime-switched.png | libfile_82c379b74fdc819196528baeaa5d5b3d |
| 33-disconnected.png | libfile_026e7b2a83648191b78a981ac3751d1c |
| 34-cold-restoring.png | libfile_2eccb41dfb00819180350aeee44a02b3 |
| 35-restored.png | libfile_c6fed923cafc8191bd6dc08be5f43cac |
| 36-offline.png | libfile_4327af00f8ac8191b1a3197da1198303 |
| 37-reconnected.png | libfile_388ca998a71c819191465178e6a3295a |
| 38-connecting.png | libfile_4c448b86c3ec8191956a1f351285719d |
| 39-connect-cancelled.png | libfile_559661a95c588191869dd17019c75c0f |
| 40-login-success-connecting.png | libfile_6896d8d93e4c8191bf58d6cf2fb90a5b |
| 41-login-success-list.png | libfile_84c5d28ca5f48191b195436afb0f1c1d |
| 42-menu-landscape-keyboard.png | libfile_19cff3e16f2c8191a461333d702b9fcc |
| 43-empty-bot-list.png | libfile_d9e226b983b88191a9544244a65494d3 |
| 44-search-no-results.png | libfile_0d71cd2c14c88191b4e4cab6ca1d8508 |
| 45-group-create.png | libfile_a12bccf84d7c8191a770becfed666d35 |
| 46-group-chat.png | libfile_2c8ce68edc448191bc771196d887094f |
| 47-model-empty-config.png | libfile_3cc10fe423dc8191830eebf2ea0dd6e1 |
| 48-auth-management.png | libfile_9dc73f21fd8081918a0688c7b6578e81 |
| 49-image-preview.png | libfile_a0eea6c7ae3481919455690785423d32 |
| 50-monitor-form.png | libfile_3ce3ce5387508191b107ad2d1501a67f |
| 51-avatar-editor.png | libfile_cb0e4efd11848191bfd46e19a3e02a46 |

