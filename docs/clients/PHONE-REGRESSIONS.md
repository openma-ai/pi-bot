# Phone regression fixes (local, 2026-10-25)

## Evidence and root causes

All five supplied Library images were materialized with the official transfer helper and visually inspected: IMG_1123.png, IMG_1124.png, IMG_1125.jpeg, IMG_1126.jpeg, IMG_1127.jpeg. Python's default CA file was missing; supplying its existing certifi trust bundle to the helper fixed downloads without disabling TLS or changing system trust. Copies and Library metadata remain in ignored `artifacts/phone-regressions/`.

- The old composer placed two visible native file inputs (each up to 180px) beside a flex textarea and a nonshrinking send button. On the supplied phone screenshot they consume the available width. The reference calls for one compact text row with an attachment menu and a preview region that grows upward.
- The create button had no synchronous in-flight guard. Each `bot/create` called `randomUUID()` and wrote a new bot, with no operation receipt. Replayed bot events are already indexed by bot ID, so repeating one ID does not explain two different deterministic default avatar colors. Synthetic concurrent requests reproduce real duplicate creation. We did not read the user's database or request logs; the exact original tap/request sequence remains unknown, and no existing bot was deleted or merged.
- Profiles and Apple device-only session credentials already persisted, but cold start never selected/reconnected the last successful runtime. Foreground restoration was a single attempt and initially showed the connection wizard. Generic native service errors also conflated transient503 with expired credentials.

## Changes

`ComposerAttachments.jsx` implements a compact plus/text/send frame, accessible Photos/File menu, hidden native pickers, horizontally scrolling local image previews and individual removal. Preview URLs are revoked on send/removal/scope change. Upload attempts are single-flight and stale completions cannot populate another conversation. Chinese composition and Safari keyCode229 do not submit; Shift+Enter remains a newline. The textarea follows the CSS viewport-dependent maximum and keeps long drafts internally scrollable. Very short keyboard layouts retain visible controls and a scrollable conversation.

No microphone button or voice capability was fabricated. The existing upload path supports photos/files; direct camera capture still requires a separately implemented native capture/permission path, so no camera menu or permission request was added.

`create-bot-attempt.ts` provides one stable operation key per draft, a synchronous double-tap guard and cached successful result. New servers accept optional `bot/create.key` and atomically persist a fingerprint/bot-ID receipt; the same operation survives reconnect/server restart and does not emit a second created event. Different keys may intentionally create bots with the same name. A conflicting reused key is rejected. Older clients remain supported. New clients use a legacy fallback only when the old registry explicitly rejects unknown `/key` before dispatch; an ambiguous legacy result cannot be resent automatically and asks the user to check the list/update the service.

`runtime-restoration.ts` persists only last-successful runtime ID/name/mode, never secrets. It shows that workspace's loading/offline view immediately, with no invented bot cache, while reconnecting through the existing native credential path. A failed new selection never replaces the last success. Reconnects are single-flight with bounded backoff, paused in background; deliberate disconnect/logout disables restoration. Transient failures do not clear credentials. Actual401/403 stops automatic authentication retry and surfaces a login/access message. The service session lifetime and Keychain protections remain unchanged. Desktop transport retries return to view-only and release control rather than silently taking a lease.

## Validation

- Full synthetic aggregate: 340 passed, zero failed.
- Connection-flow checks: 4 passed.
- Native offline transport/SDK checks: 18 passed.
- TypeScript, GUI lint, native GUI production bundle and iOS real-SDK Release static library build passed; no signing/archive/upload performed.
- Deterministic JSX review: 3 files, zero findings. Existing informational hardcoded-color notes elsewhere in the shared CSS were left outside this change.
- Real component browser fixture: 402x874, 320x568, 874x402, keyboard-height402x390 and landscape-keyboard874x250; no page overflow or clipped send button, text remained scrollable and native pickers stayed hidden. Chinese composition, Shift+Enter, image removal, menu/Escape and light/dark component rendering checked.
- Actual `useRuntime` hook with synthetic RPC: cold start displayed the remembered workspace before completion, connected automatically, recovered after simulated visibility changes with maximum one pending connect, and respected manual disconnect after reload.

These browser viewport/visibility fixtures do not prove iPhone software-keyboard positioning, photo/camera permissions, real Keychain restart persistence or live Tailnet/noVNC recovery. A new authorized client build is needed for device validation; deploying the optional server receipt support needs separate approval. The running test services, real credentials, published build and user bots were not changed.

Evidence: ignored `artifacts/phone-regressions/gui/` contains before-source Library images nearby, `composer-after.png`, `composer-menu-after.png`, `runtime-restoring.png`, `layout-checks.json`, and the explicitly labeled synthetic fixtures. Raw personal reference images are not republished.
