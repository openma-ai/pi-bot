# Local Pi GUI

模型使用主页面、认证二级页及下拉菜单/断线提醒验收见 [2026-10-14 模型设置改进](pi-settings-ui-20261014.md)。
当前命名 Runtime 设置、SSH 原生部署与可选一体镜像见 [Runtime 连接指南](design/runtime-connections.md)。以下保留历史验收。
当前导航和报错验收：[2026-10-14 Sidebar / Cmd+K / 原生读图与恢复](gui-navigation-errors-20261014.md)。下文更早的测试数量为历史记录。

Current visual implementation follows the installed Grok Bot messenger: compact contacts, original animated SVG avatars, centered conversation identity, and an optional bot-owned details/computer pane. File paths are copyable without cutting message contents; reading earlier history does not force-scroll to new messages. See [REA analysis and GUI acceptance, 2026-10-14](grok-ui-analysis-20261014.md) for the 232 offline checks, separate real Pi GUI task, desktop takeover readback, and screenshots.

React + Radix Themes. Start with `npm run gui`, open http://127.0.0.1:4317. Model and authentication use native Pi settings/model catalog/auth storage. There are no custom model/auth environment overrides and no automatic DSH credential fallback. Use “Pi 登录与模型” in the GUI for native provider login and default model/thinking selection. Native settings are saved immediately and the factory switches when existing work is idle, without restarting or erasing history. Pi `/login` and `/model` remain available. Pi handles credential lookup and OAuth refresh; secrets never enter GUI state, chat or tool traces. Missing configuration keeps history readable and blocks task submission with a configuration message. See [Pi authentication and independent coding workers](pi-auth-workers.md).

GUI request protections remain: 16,384 output token maximum, zero provider retries, 10-minute request timeout, no aggregate request, input-token or dollar budget. Native model limits can lower the output cap.

Default runtime directory remains `work/gui/demo` solely to preserve existing interactive bot IDs and message records. Its old demonstration messages remain visibly labeled in their original text; new tasks use real Pi. `PI_BOT_DIR` selects another existing runtime directory. Never use a directory owned by another live process: the runtime's exclusive lock prevents this. Evaluation fixtures are not imported as production history. Native sessions and durable SQLite inbox/outbox/jobs are reused across restarts. Delivery means publication to this local GUI, not remote IM.

Normal GUI operation has no aggregate request cap, input reservation or one-hour expiry. Old gui-budget.json files are ignored and retained only as historical evidence. Per-request timeout and per-wake/worker anti-loop guards remain. The explicit smoke evaluator uses a finite request/time envelope and a fresh directory; it does not cap input tokens or dollars. The GUI shows native token usage without calculating dollar cost.

Supported GUI controls:
- Bot search/create/select; tasks enter the durable inbox and only `send_message` outbox results are displayed as bot responses. Internal reasoning and plain native assistant finals stay internal.
- Pi bash/codemode tools, existing jobs, readback of persisted job results, and answers to pending user questions. Tools execute in each bot's session directory.
- Bot-owned schedule create, pause, resume, cancel. Lists filter by the selected bot; the creation form holds an independent owner and reply scope. One-shot or elapsed interval; IANA timezone defaults to Asia/Shanghai, with Shanghai times shown in the UI. Calendar cron/RRULE/DST recurrence is not implemented.
- Bot-owned monitor create, dry-run, enable, pause, cancel. Read-only file metadata detector, with selected file restricted to this repository. Default `PI_BOT_WATCH_FILE` or README.md. Dry-run never commits the live cursor; silent checks do not call the model. A finite deadline is required. Cancel and pause invalidate late trigger effects while already-started tools continue.

Snapshot bootstrap plus durable SSE replay drives the GUI; there is no full-state polling. Native login progress alone uses bounded private form polling while open. All states, including cancelled/completed routines, remain inspectable. This does not install an always-on system daemon, wake a sleeping Mac, or prove background context compression. Credential entry uses a separate authenticated, CSRF-protected form channel, outside RPC, chat and durable events. The server remains loopback-only.

Validation: TypeScript, GUI build and 162 offline tests pass. Separate bounded real DeepSeek rounds validate mentions, shared group visibility, quiet non-actionable chat, isolated groups, schedules, monitors and bot-to-bot handoff with actual bash file execution. See [the current handoff and evidence](gui-openmatter-handoff-20261013.md). Sanitized runtime evidence stays under ignored `work/gui/`.

Group chat delivers messages to every member. @member and @全体成员 change attention rather than visibility. Public group history is separate from direct bot-to-bot messages. Private, group and thread Pi contexts are isolated; interrupted commitments resume without cancelling dispatched jobs.

Triggers use pinned upstream OpenMatter WorkEvent/DurableInbox/SQLite lease handoff, with provenance in `vendor/openmatter/`. Pi still owns execution. Schedules and monitors belong to the selected bot details; bots and groups share one recent-conversation list. Cmd+K searches visible records and functions. Real smoke disables background compression; it does not validate real compaction.

Coding delegation now uses pinned community pi-subagents 0.77.0 execution and child-session factories behind the durable host subagent tool. Parents retain message responsiveness; per-request timeout, anti-loop checks, permission checks and stale-task guards apply. 172 offline tests pass; no new real-API claim is made.

Linux 桌面、共享浏览器 profile、Computer 实时画面与人工接管，见 [运行及验收说明](linux-desktop-image.md)。

Current architecture, real API counts, diagnostics, container evidence and unverified boundaries: [2026-10-14 implementation handoff](design/app-server-implementation-20261014.md). Earlier test counts and smoke references above are historical, not the current acceptance total.

Background compaction is now enabled in normal GUI operation. It runs as a separate tool-free request with high thinking and at most 16,384 output tokens, a 10-minute timeout, single-flight scheduling and bounded retry. Complete native history and SDK diagnostics remain durable; only a verified stable prefix is adopted at a native boundary. Foreground requests never wait for summary completion. See [real concurrency acceptance](real-flood-compaction-20261014.md).
