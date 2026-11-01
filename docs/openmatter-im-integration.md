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
- 依赖 OpenMatter（已合并 #52/#53/#54；#55 校正为「新 Turn + 宿主扩展 `_meta`/steer」，去掉 OM busy-merge）。本地 `file:../OpenMatter-int`。
- backlog 合并（**宿主策略**）：30ms 批次窗口；协调者忙时由 `PiBotProjectHost` 自行调用 Pi `AgentDriver.steer`（OM 可选扩展；`_meta`/载荷含义由宿主定）。OpenMatter 协议仍是新 Event → 新 Turn，**不**做 busy-merge。Turn 已结束或 steer 被拒则用整批文本开启一个 Turn。人类消息仍逐条写入会话日志。
- 协调者原生功能：`ask_user` 是 `pi-bot.message.reply` 的扩展（`ask=true`，可选 `choices`），走同一套 OpenMatter 授权/新鲜度/投递/回执，回执含 `questionId` 绑定后续 answer；`send_to_bot`、`start_job` / `job_result`、`file_workspace` / `publish_file`、`schedule_create` 仍通过 `BotRuntime` 的既有 inbox/job/proactive 通道回流，不是 worker 委派。

端到端验证：`node --import tsx examples/openmatter-project-host-e2e.ts`（DeepSeek deepseek-flash）。

## 尚未迁移

- GUI 未展示 OpenMatter worker 线程；`replyDelta` 等流式事件尚未桥接回 pi-bot snapshot。
- 附件目前向协调者提供元数据与 `file_workspace` 路径；图片字节还没有作为 Pi image content 直接送入模型。
- 移除原生 lane 与 `reply-host.ts`（默认路径仍在使用，尚未证明 parity）。
- backlog 的 live steer 由 `PiBotProjectHost` 直接调用 Pi `AgentDriver.steer`（宿主解释可选扩展）。这是预期分层：OM 不开 busy-merge 协议；是否 mid-turn 注入由 pi-bot 决定。
