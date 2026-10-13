# Pi Bot app-server protocol

Generated from src/sdk/protocol. Version: 2026-10-13. Regenerate with npm run protocol:schema.

JSON-RPC 2.0 over in-process, HTTP + SSE, or stdio JSONL. Initialize, acknowledge with initialized, read a snapshot, then subscribe after its seq. Secrets and reasoning text never enter events.

| Method | Schema |
|---|---|
| `initialize` | [params / result](../dist/protocol/schema.json) |
| `daemon/status` | [params / result](../dist/protocol/schema.json) |
| `daemon/snapshot` | [params / result](../dist/protocol/schema.json) |
| `daemon/shutdown` | [params / result](../dist/protocol/schema.json) |
| `events/subscribe` | [params / result](../dist/protocol/schema.json) |
| `events/unsubscribe` | [params / result](../dist/protocol/schema.json) |
| `events/ack` | [params / result](../dist/protocol/schema.json) |
| `bot/list` | [params / result](../dist/protocol/schema.json) |
| `bot/read` | [params / result](../dist/protocol/schema.json) |
| `bot/create` | [params / result](../dist/protocol/schema.json) |
| `bot/update` | [params / result](../dist/protocol/schema.json) |
| `group/list` | [params / result](../dist/protocol/schema.json) |
| `group/create` | [params / result](../dist/protocol/schema.json) |
| `group/update` | [params / result](../dist/protocol/schema.json) |
| `thread/list` | [params / result](../dist/protocol/schema.json) |
| `thread/read` | [params / result](../dist/protocol/schema.json) |
| `thread/archive` | [params / result](../dist/protocol/schema.json) |
| `thread/unarchive` | [params / result](../dist/protocol/schema.json) |
| `thread/unload` | [params / result](../dist/protocol/schema.json) |
| `turn/start` | [params / result](../dist/protocol/schema.json) |
| `turn/steer` | [params / result](../dist/protocol/schema.json) |
| `turn/interrupt` | [params / result](../dist/protocol/schema.json) |
| `turn/list` | [params / result](../dist/protocol/schema.json) |
| `routine/list` | [params / result](../dist/protocol/schema.json) |
| `routine/create` | [params / result](../dist/protocol/schema.json) |
| `routine/pause` | [params / result](../dist/protocol/schema.json) |
| `routine/resume` | [params / result](../dist/protocol/schema.json) |
| `routine/cancel` | [params / result](../dist/protocol/schema.json) |
| `routine/enable` | [params / result](../dist/protocol/schema.json) |
| `routine/dryRun` | [params / result](../dist/protocol/schema.json) |
| `job/list` | [params / result](../dist/protocol/schema.json) |
| `job/read` | [params / result](../dist/protocol/schema.json) |
| `request/list` | [params / result](../dist/protocol/schema.json) |
| `request/resolve` | [params / result](../dist/protocol/schema.json) |
| `task/reconcile` | [params / result](../dist/protocol/schema.json) |
| `desktop/bind` | [params / result](../dist/protocol/schema.json) |
| `desktop/control` | [params / result](../dist/protocol/schema.json) |

Notifications: `daemon/configurationChanged`, `daemon/budgetUpdated`, `daemon/migrated`, `group/messageUpdated`, `daemon/statusChanged`, `events/watermark`, `bot/created`, `bot/updated`, `group/created`, `group/updated`, `turn/queued`, `turn/started`, `turn/completed`, `item/started`, `item/updated`, `item/completed`, `request/created`, `request/resolved`, `routine/updated`, `routine/fired`, `job/updated`, `task/reviewRequired`, `task/reconciled`, `proposal/updated`, `memory/updated`, `item/agentMessage/delta`, `item/toolCall/delta`, `item/internal/delta`, `thread/started`, `thread/loaded`, `thread/unloaded`, `thread/archived`.
