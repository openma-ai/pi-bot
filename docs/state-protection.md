# Agent 状态保护：Read → Decide → Conditional Commit

实现 [#6](https://github.com/openma-ai/pi-bot/issues/6) 的第一部分。改状态工具通过
`@openma/matter/store` 的 `makeMutationStore` 提交：前置条件比较、业务写入和操作回执在 pi-bot
自己的 SQLite 事务（`BEGIN IMMEDIATE`，嵌套时用 SAVEPOINT）内一次完成。条件不成立时不写业务状态，
工具向正在作决定的 Agent 返回结构化冲突：

```json
{ "status": "conflict", "operationId": "message:reply-1", "effect": "not-applied",
  "conflicts": [{ "resourceId": "conversation:[…]", "expectedRevision": "…", "actualRevision": "…" }],
  "reread": "…" }
```

## 代码位置

- `src/pi/state-protection.ts`：资源标识、`CommitResult`、`ReadEvidence`。
- `src/daemon/runtime/state-guard.ts`：基于现有表的 `MutationBackend`（无影子副本）与 `StateGuard`。
- 回执表 `mutation_receipts(authority, operation_id)`；authority 为 `bot:<botId>`，跨 bot 的条件被拒绝。

## 已读证据

宿主隐藏版本参数，用会话执行上下文绑定 observation，不向模型暴露 token：

- 每次构建模型请求（Pi `context` 事件）时，记录上下文中可见的 user/answer 输入，按会话路由
  （channel、conversation、thread）取最新一条作为该会话的已读版本，并冻结为本次请求的证据。
- 读工具（`schedule_list`、`monitor_list`、`*_create`、写入成功的返回）返回的 revision 只在
  **下一次** 模型请求后才算已读。
- `tool_call` 时把工具调用绑定到冻结的证据；codemode 内嵌调用继承父调用的证据。
- 从不在提交时读取最新版本充当 expectedRevision。没有已读证据时 expected 为 `null`，会冲突。

## 保护矩阵

| 工具 | 状态依赖（条件） | 提交边界 | 保证 | 状态 |
| --- | --- | --- | --- | --- |
| `send_message` | 目标会话最新 user/answer 输入 id；`outbox:<key>` 尚不存在 | 本地 outbox 追加 | atomic（本地会话） | 已转换 |
| `schedule_cancel` | 该 schedule 的业务 revision | schedules 行 + 失效 fire，同一事务 | atomic | 已转换 |
| `monitor_enable` / `monitor_cancel` | 该 monitor 的业务 revision | monitors 行（cancel 含失效 fire） | atomic | 已转换 |
| `ask_user` | 未绑定会话（问题与消息投影仍按 key 去重） | questions + outbox | 仅幂等 | 待做 |
| `send_to_bot` / `send_to_group` | 未绑定 | peer inbox | 仅幂等 | 待做 |
| `schedule_create` / `monitor_create` / `background_work` | key 唯一（原有去重） | 新行 | 幂等，未走回执 | 待做 |
| `monitor_dry_run` | 写 `dryRunVerified`，不推进 revision | monitors 行 | 原有 revision 比较 | 待做 |
| `memory_apply` | 原有 `snapshotVersion` + evidence hash 比较 | memories | 自有 CAS，未走回执 | 待统一 |
| `background_cancel`、`create_bot`、`request_credential` | 未绑定 | — | — | 待做 |
| `start_job`、`subagent`、codemode、bash/文件、`desktop_call` | 外部或本机副作用 | 宿主外 | unsupported | 需各自绑定（文件 hash 等） |

pi-bot 当前没有任务领取/更新或 goal 工具；#6 中这两类在 pi-bot 中暂无可转换的代码。

### 依赖说明

- 会话版本只看 user/answer 输入：peer 消息、job 回执、schedule/monitor 触发是独立输入，照常排队，
  不使用户回复冲突。Bot 自己的追加不推进会话版本，同一次决定中的多条回复可依次提交。
- Schedule 触发只推进 `nextFire` 等记账字段，不改变 revision；暂停、恢复、取消、启用会推进 revision。
- 宿主调用这些方法（如 tick 中因来源失效取消）时，在同一事务内读取当前 revision 再提交。
  GUI 的暂停/恢复仍直接写入，但会推进 revision，Agent 的后续提交能检测到。

## 提交与恢复

- operation identity：`send_message` 为 `message:<key>`，trigger 工具为 `tool:<toolCallId>`。
  同 key 重放返回原结果（重启后仍然有效），不会因自己推进了 revision 误报冲突；同 key 不同内容报
  `Idempotency key conflict`。冲突也保存回执；Agent 重新决定须使用新的 key。没有自动 rebase/retry。
- outbox 追加就是本地会话的提交边界，入 outbox 即 committed（`state: pending` 表示尚未投递）。
  之后的 `deliver()` 只是传输：sink 失败时保留现有 `uncertain` 状态待对账，不会报告为 conflict。
- 外部 IM 发送没有远端 CAS；本地条件不代表远端保证。
