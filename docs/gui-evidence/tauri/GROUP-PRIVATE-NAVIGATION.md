# Sender avatar opens existing private conversation

Implemented sender-avatar buttons using the resolved sender's existing bot ID and the existing chooseConversation/route path. Opening performs no bot creation, turn start, message send or credential action. Available sender is rechecked against the current snapshot; missing/deleted identities only report `该成员已不可用，无法打开私聊。` and keep the group route.

Visible avatar remains28px; button target44×44px, explicit accessible name, native Enter/Space behavior and focus ring. Unavailable members retain a keyboard-discoverable unavailable state. Group origin/runtime metadata is carried in history; return controls use existing history back. Group draft remains in the existing conversation-scoped draft store. Current scroll/bottom state is saved before leaving and restored before paint. Sidebar/search/inspection selection shares the same route path so old private-origin metadata is not accidentally reused. New bot/group creation clears stale route metadata while the snapshot catches up, without changing its backend operations.

## Actual checks

- GUI lint, TypeScript,23 existing layout/color/presentation regression tests, production GUI bundle and Tauri debug macOS app build passed.
- Native desktop: teal Fixture Bot7 avatar opened existing bot route `5e1f3e49-8d67-49db-ac37-30786961387a`; Custom Dark Fixture avatar opened existing route `d79a349a-3fc9-4051-817f-f0949121f2ed`. Repeating senderB used the identical target and one return step. No duplicate bot entries appeared.
- Keyboard: clicked senderB label, Shift+Tab focused its explicitly named avatar button, Enter opened senderB's existing private conversation.
- Removed member: native AX exposed unavailable state; pointer activation produced the concise unavailable notification and URL remained the source group. An earlier keyboard observation returned a stale-app-handle error; state was re-queried before subsequent actions. No wrong conversation opened.
- Desktop return preserved unsent `Private navigation group draft`; before/after captures showed identical transcript scroll anchor.
- At360px, both senderA and senderB opened their exact private routes and the back button said `返回群聊`. Back restored group draft/position. A second back reached the phone conversation list; reopening the group retained its draft.
- A nonzero narrow scroll position was also tested. Comparing transcript pixels before/after the private-chat round trip found best vertical offset0 raster px (mean absolute RGB difference0.00108, mostly cursor/hover).
- No message was sent by these navigation checks; the draft remained unsent and private composers stayed empty. Existing fixture history was preserved.

## Deliverable screenshots (Library version0)

- Phone private target: `libfile_cd2b489d2638819189f182fa2d5e9c05`
- Phone group restored: `libfile_e9349cb14c34819198a7781ab97bf7a3`
- Desktop group restored: `libfile_40a59b9252688191814ebb22d649c9fa`

Additional before/after nonzero-scroll captures are local alongside this record. Captures were inspected and contain isolated fixture content only; no credentials or private runtime data. No push, publication, installer replacement or live-daemon changes. Real iOS hardware gestures and spoken VoiceOver remain unverified; native macOS keyboard/accessibility and narrow-layout behavior were exercised.
