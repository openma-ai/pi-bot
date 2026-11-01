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

## project-host（`PI_BOT_PROJECT_HOST=1`）

IM → OpenMatter → pi-bot。开启后 `BotRuntime` 不再唤醒原生 lane，接收的 Envelope 提交给 OpenMatter；未开启时行为不变。

- `src/pi/agent-driver.ts`：Pi 实现 `AgentDriver`。`turn` → Pi prompt；`steer` → Pi steer，Turn 运行中 `accepted`，结束后 `rejected`（由 runtime 开启下一个 Turn）。OpenMatter 不依赖 Pi SDK。
- `src/daemon/openmatter/project-host.ts`：`PiBotProjectHost` 封装 `ProjectWorkService`。
  - 一个 bot 的一个 IM 线程 = 一个 Project，默认 `workspace: "none"`。
  - 协调者工具 `delegate_worker` / `steer_worker` / `cancel_worker` / `complete_project` 绑定所在 Project；Thread = worker id。worker 不能直接回复用户。
  - 回复是内核 operation call（`pi-bot.message.reply`），授权、目标绑定、新鲜度、投递、回执都在 OpenMatter 内。
  - 所有 project 事件写入会话日志，委派后的 Turn 也有 trigger revision 可查；只有 human 消息计入新鲜度。
- 依赖 OpenMatter 本地分支 `local/om-integration-pibot-host`（PR #52、#53，外加 project-host 的 `integrations` / `grants` / `observe` / `eventLeaseMs` / `origin`）。

端到端验证：`node --import tsx examples/openmatter-project-host-e2e.ts`（DeepSeek deepseek-flash）。

## 尚未迁移

- 协调者模式下没有 `ask_user`、作业、proactive、`send_to_bot`、文件/图片附件；`PI_BOT_PROJECT_HOST` 因此默认关闭。
- 移除原生 lane 与 `reply-host.ts`（默认路径仍在使用）。
- GUI 未展示 worker 线程，流式事件（`replyDelta` 等）未从 driver 转发。
