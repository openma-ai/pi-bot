# Shared Pi Bot client: Tauri checkpoint

The current verified deliverable is an arm64 macOS **development** app, using the existing React messenger, SDK/state reducer and a Rust HTTP/SSE/native connection boundary. It embeds frontend assets only: no Node binary, Node sidecar, or Node GUI host. Pi runtime is independently installed and managed. This checkpoint is not a finished multi-platform release.

## Build / run

Install the repository's frontend dependencies and `npm ci` in `clients/tauri`. From `clients/tauri`:

```sh
npm run build:gui
npm exec tauri build -- --debug --bundles app
```

Open `src-tauri/target/debug/bundle/macos/Pi Bot Desktop.app`. The current bundle is about 39.77 MiB; this debug number is not a release performance benchmark. Node is a build prerequisite for frontend tooling, not an application/runtime dependency. The app starts disconnected. Configure an existing runtime's **absolute data directory** in Settings, then Enable. It never starts a local daemon or executes remote `ensure`. Missing discovery or an unavailable listener produces a connection error.

Desktop SSH currently uses system OpenSSH with batch mode, strict host-key checking and no agent forwarding. It reads existing remote `daemon.json`/transport token over SSH, keeps transport credentials in Rust memory, validates loopback discovery and rewrites Host for forwarding. It does not accept unknown host keys, create keys, start remote services, or persist transport credentials. The existing GUI SSH fields for Node/serverPort remain compatibility fields and are not used to provision runtime here. No real SSH host has been contacted during verification.

Model credential provisioning uses a separate restricted native window. Main-window IPC blocks credential setup writes; the secure window can submit its one scoped form through Rust only. Inputs clear on submit, and no secret is emitted into chat or persisted by the client. Raster-avatar downloads and computer-use transports are outside this first boundary; normal generated avatars work. Profiles persist through Tauri's app-data directory and contain connection metadata only. Requests are never replayed after an ambiguous failure. SSE reconnect/history behavior reuses the SDK; native stream tasks are aborted on disconnect/exit. Further lifecycle/cancellation hardening is still needed for simultaneous connect/exit and mobile foreground/background transitions.

## Runtime download boundary

Only macOS/aarch64 is allowlisted for a future runtime download. Other OS/architectures, including iOS/iPadOS, are denied natively. Settings shows install/version state and a disabled **not published** download action. There is no trusted published manifest or artifact URL, so `runtime_install` always refuses and performs no download. A private format-neutral staging primitive tests platform matching, SHA-256 integrity, semver downgrade refusal, and atomic version-directory installation with inert fixture bytes. Production archive extraction, trusted-manifest verification, downloading, activation and update/rollback must be implemented once an approved release format exists; this is not a working installer.

## Verification completed

- GUI build, repository TypeScript check, GUI ESLint and `git diff --check` passed.
- Native `cargo test`: 6 passed (discovery validation; strict SSH trust/path quoting; missing runtime does not start a process; simulated forwarded Host/auth/SSE; install allowlist; verified atomic fixture staging/no downgrade).
- `ssh-spike`: pinned russh 0.64.1 compiled on macOS; 1 host-key rejection test passed. It exposes a strictly pinned handler plus independent `direct-tcpip` channel streams. It does not load keys or contact a host and is **not integrated into the application**.
- Native App fixture QA: saved profile, attached isolated runtime, sent a message, observed streamed reply state and final history; also sent 24 paragraphs, expanded composer, used wheel scrolling, and resized to approximately 648 CSS px. Header/composer stayed fixed and the document had no outer scrollbar. Native screenshots are saved under `docs/gui-evidence/tauri/`.
- Scrollbar root cause was the portal-only second Radix Theme's default viewport minimum. `overlay-theme` now has zero height; document/shell overflow is bounded and only conversation/sidebar/composer viewports scroll.

Disposable fixture command from repository root:

```sh
node --import tsx clients/tauri/test/fixture-server.ts /tmp/pi-bot-tauri-fixture-20261014
```

This is test infrastructure only, with fixed dummy transport auth, isolated Pi configuration, deterministic test replies and no model/network agent execution. It must never be mistaken for real bot output. A tool-session recovery stopped the first fixture; its port was confirmed closed before restarting only this fixture.

## Remaining / blocked

- iOS remains remote-only. The current iOS transport explicitly returns unsupported while the shared russh adapter is being verified; it does not assume `ssh` exists. Full Tauri mobile library/bootstrap, native secure-storage/auth integration and foreground reconnect are unfinished.
- After explicit user approval, Rust iOS device/simulator targets were installed successfully. iOS compile and simulator/device execution have not yet run.
- Windows/Linux architecture has not been build/run tested. Desktop SSH needs OpenSSH, trusted host keys and existing auth. Windows local runtime sandbox limitations remain in the independent runtime; client architecture does not fix them.
- Real local/remote conversations, mobile builds, installer distribution, signing/notarization and production credentials are unverified/out of this checkpoint. No push, deployment, public listener, live restart or original-service change occurred.

Next: finish the shared native SSH adapter with fixture channels and integrate it behind the existing transport boundary; compile the now-installed device/simulator targets. Separately finish narrow/mobile scrollbar QA and production runtime-manifest packaging when an approved artifact exists.

## Conversation request milestone

The standalone pending sidebar destination is removed. Conversation rows retain pending counts; questions, tool approvals and safe credential requests appear in their owning bot/group conversation. Rounded question cards keep grouped letter-labelled option rows, a right checkmark for the submitted answer and a resolved confirmation. Current protocol answers remain single text responses; the reference image does not authorize a new multi-select protocol. Approvals show significant target/command fields and expandable full parameters. Resolved credential cards never show the submitted value.

Verification: GUI lint, TypeScript check, GUI build, macOS debug app build, two conversation routing/security tests and six Rust tests pass. The localhost transport fixture test needed normal sandbox escalation to bind its isolated listener, then passed. Native UI verified question submission, explicit denial and separate secure-window submission using disposable mock requests and a dummy value. Screenshots include `request-cards-resolved.png`, `secure-input.png` and a 360 CSS-pixel window. The request panel now shares the chat scrollbar instead of a nested sticky scroll area.

Runtime scheduling is a separate unfinished milestone. `ask_user` returns a correlated question immediately; approval broker returns a promise for the current operation. That alone does not prove independent task B can progress while A awaits approval. Durable scoped waits, duplicate/late replies, restart and denial need dedicated runtime regression tests before claiming non-blocking behavior.

## Nonblocking request runtime checkpoint

`askUser` creates a durable correlated question and returns immediately. `answer` enqueues one answer envelope with the original taskId/replyTo; identical duplicates do not enqueue another, conflicting replies fail. It now verifies the original task before accepting a previously unanswered question, including direct host replies.

`startJob` returns a durable receipt while authorization waits inside the background execution promise. The same bot lane can process independent B. The native Pi codemode adapter uses this job path and yields its cell on new inbox input; a faux-provider integration test now holds an actual RequestBroker approval while that same Pi session consumes B, then verifies effects occur only after fixture approval. No model network or actual permissions/credentials are used.

Two corrections: later nested approvals no longer require the original inbox envelope still be processing (it may legitimately be processed while a background job continues); current task validation remains mandatory. `startJob` rechecks task validity after authorization and before dispatching effects. This does not cancel a job already dispatched. Pending approval promises are deliberately not recovered/replayed after restart; persisted requests become cancelled. Pending questions survive restart and their answer resumes only the original task once.

Tests: `nonblocking-requests`, `audit-runtime`, `credentials`, `app-server`: 36 passed. Background/codemode/bridge/compaction regression group: 35 passed before adding the native approval case; updated `background-bot`: 6 passed including that case. TypeScript check and diff whitespace check passed. The isolated HTTP test required sandbox escalation solely for localhost fixture binding, then passed.

Secure forms are a separate acceptance criterion. CredentialBroker.request returns form metadata without waiting; scoped submissions remain ephemeral, references are single-use, consumer errors become fixed statuses. New dummy-input tests cover validation error, wrong scope, retry, cancellation and failed use; captures and durable inbox/outbox/request/job/question records contain no dummy value. Existing app-server test checks durable event logs after submission and rejects RPC submission. The native UI clears its input before invoking submit and exposes only a generic result; ambiguity never auto-replays. This is not a guarantee of memory zeroization, and native telemetry instrumentation/all OS lifecycle paths have not been audited.

Limits: the regression guarantee covers question, credential-request receipt, start_job and native codemode execution paths. An arbitrary custom SessionFactory can still block its own lane by awaiting an unrelated promise; the direct desktop foreground gap identified here is resolved by the next checkpoint below. Existing async policy callbacks could also wait before creating a broker request. No scheduler/preemption/compaction code was changed. Do not generalize this checkpoint to all custom integrations.

Library delivery confirmed: narrow card screenshot `libfile_7390aca35bf081918f47a66c7d1eaeda`; desktop screenshot `libfile_2f91284975608191853a97e655b51f9f`. Local PNGs retain Library version xattrs. Navigation work is queued next: desktop expanded/collapsed modes; iOS separate list/chat routes preserving drafts and scroll.

## Direct desktop approval follow-up

The first-party piSessionFactory now dispatches direct desktop_list/desktop_call through startJob with a key containing the original source message and native tool call ID. The call returns a durable receipt immediately; the model must wait for the correlated completion inbox and read job_result rather than treating a receipt as desktop state or a screenshot. Source identity is captured before dispatch and bound with AsyncLocalStorage throughout execution, so later B cannot replace A's source. Tool descriptions state this contract.

Authorization is the existing startJob gate; the executor's authorized flag is supplied only inside that already-authorized job. It does not waive the gate. Existing codemode nested calls keep their cell execution boundary and their own desktop authorization instead of spawning recursive jobs. The runtime rechecks cancellation before invoking the desktop executor; DesktopClient.call additionally checks again after its asynchronous bind and immediately before dispatching /call. Already-dispatched requests remain subject to the existing uncertainty/no-replay contract.

For both desktop_list and desktop_call, ten fake-transport/native-Pi regression cases (approve, deny, cancel, cancel-after-bind and restart) all consume independent message B while A's approval is pending. Before approval no bind or /call occurs. Approve plus duplicate approval executes once; denial and both cancellation cases execute zero times; shutdown/reopen keeps cancellation and rejects late approvals. No real desktop request, model network, security grant or credential is used. Combined desktop, runtime, request, background and compaction regression suite: 67 passed. TypeScript check passed.

Custom contract: use piSessionFactory, or return a startJob receipt from foreground SessionFactory.run instead of awaiting human approval/waitForJob inside it. Run policy callbacks inside the background job; they must return a decision without creating side effects. A standalone createDesktopExtension without a DesktopDispatch retains its synchronous compatibility contract and is not a nonblocking scheduler. Worker-local desktop waits remain within the isolated worker job and do not hold the foreground bot lane. Arbitrary third-party await chains cannot be controlled by this runtime. A crash never promises exactly-once external effects: uncertain dispatch is quarantined for reconciliation, not replayed.

## Navigation and pinned-conversation checkpoint

Desktop uses the existing Sidebar/Radix primitives for an expanded recent list (avatar, name, last message, selected background) and 76px avatar rail. Width persists locally; ⌘B/Ctrl+B toggles the two modes and the divider supports keyboard/pointer resize. The rejected visible mode button is removed. Radix HoverCard supplies a rail name/preview, and pending count badges remain on both ordinary and pinned rows. Search/new sit next to each other in one compact top toolbar; only Settings remains in the desktop footer, and phone Settings uses the avatar-like top-left control. The duplicate bottom plus and connection/status block are removed; runtime management stays in Settings. there is no invented marketplace or user account.

The top section is explicitly pinned conversations, not a main bot identity. Pin/unpin controls accept both bot and group rows; pinned items appear once above the unpinned list, with selected state and pending badges. No tile is forced when there are no pins. Pins persist in localStorage per runtime scope and are filtered against current visible conversations. They are client preferences, not server-wide pins or credentials.

Phone width (<768px) uses `#/conversations` (empty hash is equivalent) and `#/chat/bot/<id>` / `#/chat/group/<id>`. Selecting pushes a history entry; Back returns to the list; a direct link with no local history replaces itself with the list on Back. Encoded IDs are parsed safely; missing/current-runtime-inaccessible conversations return to the list. Desktop/iPad use available width. Both views stay mounted so list scroll survives route transitions; chat scroll snapshots are per runtime/conversation, and the existing scoped draft storage remains separate. Back blurs the composer. viewport-fit/safe-area padding, dynamic viewport height and visualViewport resize handling are implemented for keyboard layout.

Native macOS App QA used only disposable navigation fixture history and mock requests. Verified no pins, two pins, selected pin, unpin returning exactly one row, collapsed mode, and pins surviving client restart/reconnection. At 360 CSS px verified list-only -> chat-only hash routes, Back, isolated per-chat draft restoration, and unchanged long-chat scroll position before/after route return (saved before/after images). Four routing/pin/security helper tests, GUI lint, TypeScript check and GUI/native App builds passed. 21st review: four files, zero findings; catalog search was unavailable (`fetch failed`), so existing project primitives and supplied references were used. No new UI dependency was installed.

Limits: this is macOS WebView phone-width simulation, not an iOS simulator/device build. iOS keyboard, native back gesture, VoiceOver, native deep-link registration and mobile signing remain unverified. Scroll snapshots survive route transitions in the current renderer, not process termination. Pins and width persist locally; they do not sync across devices. A pending-request badge is not an unread-message feature. Secure input remains separate, and this milestone changes no runtime approval enforcement or original daemon.

Library screenshots confirmed: expanded `libfile_7c100699fd408191b081eec8d1bda339`; collapsed `libfile_3145085f4c28819195940d343e16bb84`; phone list `libfile_ae7c7d16b4708191b7a206d1daf962bf`; phone chat `libfile_21cb7b716930819198235ac488ad508a`.

Latest screenshot corrections: no explicit expand/collapse icon in either mode; no bottom duplicate new button, current-connection button or connected-status text; collapsed empty state omits verbose wrapping text. Phone list has a neutral settings/avatar glyph at top-left (no invented account identity), circular search/new at top-right, actual pinned tiles and full-width rows with last-message timestamps. Dark theme is retained. Connection failure notices remain at their relevant scope.

Native titlebar correction: macOS main window uses Tauri `titleBarStyle: Overlay` with hidden native title, retains system traffic lights, and places search/new into that actual 32px row rather than a content row below it. The fixed controls reserve 84px for traffic lights and remain pointer-interactive; a separate blank `data-tauri-drag-region` covers the rest. Only the main window receives `core:window:allow-start-dragging`; secure credential windows keep their existing native chrome and permissions. Search dialog and new-conversation menu were opened by native UI clicks; blank titlebar dragging was exercised without a tool error or unintended control activation (global window coordinates were not independently measured). Native phone-width simulation retains a 32px macOS chrome inset; actual iOS uses its existing safe-area navigation instead of this macOS detector. Sources: [Tauri config](https://v2.tauri.app/reference/config/#titlebarstyle), [window/drag-region documentation](https://v2.tauri.app/learn/window-customization/). Context7 DNS lookup was unavailable; installed config schema and official docs were used.

All four Library screenshots were replaced in place and confirmed at version 2 with the titlebar correction. Pixel fidelity measurement against the full new reference and investigation of the user's unspecified loading symptom are queued as a separate milestone. No exact-pixel claim is made by this navigation checkpoint.
