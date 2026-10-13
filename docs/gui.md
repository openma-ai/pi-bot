# Local Pi GUI

React + Radix Themes. Start with `npm run gui`, open http://127.0.0.1:4317. There is no demo fallback: startup requires an available real DeepSeek credential. The existing explicitly authorized host-only DSH credential reader loads the key into Pi memory, never into the UI or a file. `DEEPSEEK_API_KEY` may override that source. Uses official `deepseek-v4-flash`, thinking high, 16,384 output token cap including reasoning, zero provider retries, 10-minute request timeout.

Default runtime directory remains `work/gui/demo` solely to preserve existing interactive bot IDs and message records. Its old demonstration messages remain visibly labeled in their original text; new tasks use real Pi. `PI_BOT_DIR` selects another existing runtime directory. Never use a directory owned by another live process: the runtime's exclusive lock prevents this. Evaluation fixtures are not imported as production history. Native sessions and durable SQLite inbox/outbox/jobs are reused across restarts. Delivery means publication to this local GUI, not remote IM.

The host loads at most 32 requests, reserves at most 384,000 input tokens conservatively, and allows 60 minutes per round. Reservations and expiry persist in `gui-budget.json` across restarts. To explicitly start another bounded round after inspecting prior results, restart with `PI_BOT_NEW_ROUND=1 npm run gui`. There is no automatic budget reset. Sidebar details show requests and persisted native usage; displayed dollar cost uses provider configuration pricing and is an estimate, not a billing receipt.

Supported GUI controls:
- Bot search/create/select; tasks enter the durable inbox and only `send_message` outbox results are displayed as bot responses. Internal reasoning and plain native assistant finals stay internal.
- Pi bash/codemode tools, existing jobs, readback of persisted job results, and answers to pending user questions. Tools execute in each bot's session directory.
- Schedule create, pause, resume, cancel. One-shot or elapsed interval; IANA timezone defaults to Asia/Shanghai, with Shanghai times shown in the UI. Calendar cron/RRULE/DST recurrence is not implemented.
- Monitor create, dry-run, enable, pause, cancel. Read-only file metadata detector, with selected file restricted to this repository. Default `PI_BOT_WATCH_FILE` or README.md. Dry-run never commits the live cursor; silent checks do not call the model. A finite deadline is required. Cancel and pause invalidate late trigger effects while already-started tools continue.

Polling runs locally once per second. All states, including cancelled/completed routines, remain inspectable. This does not install an always-on system daemon, wake a sleeping Mac, or prove background context compression. No browser credential entry, public listener, push, merge, or deployment is involved.

Validation: TypeScript, GUI build and 162 offline tests pass. Separate bounded real DeepSeek rounds validate mentions, shared group visibility, quiet non-actionable chat, isolated groups, schedules, monitors and bot-to-bot handoff with actual bash file execution. See [the current handoff and evidence](gui-openmatter-handoff-20261013.md). Sanitized runtime evidence stays under ignored `work/gui/`.

Group chat delivers messages to every member. @member and @全体成员 change attention rather than visibility. Public group history is separate from direct bot-to-bot messages. Private, group and thread Pi contexts are isolated; interrupted commitments resume without cancelling dispatched jobs.

Triggers use pinned upstream OpenMatter WorkEvent/DurableInbox/SQLite lease handoff, with provenance in `vendor/openmatter/`. Pi still owns execution. Dedicated left-sidebar pages manage schedules, monitors and bot conversations. Real smoke disables background compression; it does not validate real compaction.
