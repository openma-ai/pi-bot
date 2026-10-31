# pi-bot 聊天壳作为 OpenMatter 集成（IM → OpenMatter → pi-bot）

目标架构：pi-bot 自己的聊天壳（daemon/GUI/SDK 会话、群组、线程、bot-to-bot）是一个
“模拟 IM”，与 Slack/飞书一样作为 OpenMatter integration 接入。OpenMatter 负责 inbox、
dispatch 与 reply（授权、过期检查、投递、回执）。

## 本阶段（PR A + PR B）

- `src/daemon/openmatter/pi-bot-integration.ts`：`WorkIntegration`（id `pi-bot`，authority `local`）。
  - 事件绑定：`workEventForEnvelope` 把 Envelope 转成 WorkEvent（`pi.<kind>`）。
    会话按接收 bot 划分：`conversationId = [to, channelId, conversationId]`，`threadId = route.threadId || "main"`，
    与 pi-bot 现有的 conversation revision（每个 bot 的 inbox）一致。
  - `observe`：`user`/`answer` 为 human 发送者，bot/job/schedule/monitor 等为 app 发送者。
  - `message.reply` 声明为工具（同 `packages/feishu` 的 `FEISHU_TOOLS`），`freshness: "best-effort"`。
    Agent 只提供 `{ text, key }`；`bindToolInput` 从触发事件绑定 `sourceMessageId`、会话与线程，拒绝其他字段。
  - `deliver`：通过宿主端口写入 outbox，之后由原有投递循环写 channel_messages / GUI，回执为 `{ outboxId, botId, key, replyTo, state }`。
- `src/daemon/openmatter/reply-host.ts`：在 pi-bot 的 SQLite 上执行 OpenMatter operation call：
  会话日志（`om_conversation_entries`，每会话 revision 从 1 递增，按 event id 幂等）、
  调用记录（`om_operation_calls`，按 turn/call id 幂等，先写 pending）、授权（allow）、输入绑定、
  新鲜度检查（`DEFAULT_FRESHNESS`：同线程、仅 human 消息）与记录在同一事务内、投递与回执。
  逐步对应 `@openma/matter` 的 `callOperation`（docs/TURN_TOOLS.md）；该函数在 0.2.7 未导出，导出后应改为直接委托。
- 回复路由（PR B）：`send_message` 改为调用 `BotRuntime.replyThroughOpenMatter`：
  - `source_message_id` → 触发事件（回复目标，由宿主绑定）。
  - ReadEvidence 记录的“模型已看到的最新会话输入” → Turn 的 seen revision。
  - 冲突返回 OpenMatter 的 `{ status: "conflict", effect: "not-applied", conflict: { messages }, seenRevision }`，
    新消息已展示给模型，因此 seen revision 前移；模型可用新 key 重新回复。
  - 同 key 不同内容仍返回 `Idempotency key conflict`；任务被取代（`assertTaskCurrent`）仍在调用前抛错。

## 不在本阶段

- dispatch 迁移到 project-host、subagent 改造。
- 用 OpenMatter 的 agent-turn runtime 运行 pi-bot Turn（届时 reply-host 由内核替代）。
