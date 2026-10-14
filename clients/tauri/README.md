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
