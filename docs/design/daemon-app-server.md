# pi-bot daemon：App Server 化详细设计

状态：提案 v2 · 2026-10-13 · 前置：`refactor/layers` 四层分层已完成（`src/pi` / `src/daemon` / `src/sdk` / `src/gui`）

参考：[Codex app-server README](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/README.md)

目录

1. 目标、非目标、不变量
2. 和 Codex 的对应与差异
3. 总体架构与模块清单
4. 领域模型与 ID
5. 存储：DDL、迁移、事件派生
6. 事件日志语义
7. 协议：线格式、传输、鉴权
8. 连接生命周期
9. daemon 进程生命周期
10. Thread 生命周期
11. Turn 生命周期（对应 `drain` 的具体钩子点）
12. Item 生命周期（对应 Pi 事件的映射）
13. Server Request
14. 方法目录
15. 通知目录
16. 错误模型与现有抛错的映射
17. 关键时序
18. SDK
19. GUI 与 CLI
20. 配置与默认值
21. 实施计划（逐步骤 + 测试用例）
22. 风险与待决问题

---

## 1. 目标、非目标、不变量

### 1.1 目标

| # | 目标 | 可度量的验收标准 |
|---|---|---|
| G1 | daemon 是唯一持有 runtime 和数据库的宿主，所有客户端走同一协议 | GUI 和 CLI 同时连接时看到同一状态；仓库里没有绕过协议直接读写 Store 的客户端代码 |
| G2 | 嵌入和独立运行使用同一套代码 | 进程内传输和 HTTP 传输跑同一组协议一致性测试，全部通过 |
| G3 | 推送替代轮询，并且可续传 | GUI 不再定时拉取；断线、daemon 重启后按 seq 续传，没有缺口 |
| G4 | 协议只在一处定义 | `src/sdk/protocol` 是唯一定义；TS 类型、运行时校验、JSON Schema 都从这里派生 |
| G5 | 所有生命周期可观测 | 每次状态迁移都有对应事件；性质测试 `reduce(snapshot, events) == snapshot'` 恒成立 |

### 1.2 非目标

远程多租户部署、跨机器分布式、thread fork、把 bot 的 assistant 内部文本暴露给用户。

### 1.3 必须保留的不变量（每个阶段的回归门槛）

| ID | 不变量 | 当前实现位置 |
|---|---|---|
| I1 | 幂等：inbox 按 `from + key` 去重，job/question/outbox 按 `botId + key` 去重；同 key 不同参数返回冲突 | `store.ts` 的唯一索引；`runtime.accept/sendMessage/askUser/startJob` |
| I2 | 不自动重放副作用；进程中断时执行中的记录变为 `uncertain` | `Store.recover()` |
| I3 | `uncertain` 只能通过带证据的人工核对来解决 | `runtime.reconcileInbox`、`server.ts` 的 `/api/reconcile` |
| I4 | 单写者：同一个数据库只能由一个存活进程持有 | `lock.ts` 的 `acquireLock` |
| I5 | 持久化或对外发出之前先脱敏 | `redactChannelText`、`redactTraceValue` |
| I6 | 模型不能伪造发送者 ID 或指定任意投递目的地 | `pi/session-factory.ts` 的 `own()`、route 继承 |
| I7 | 任务被替换或取消后，旧任务不能产生新动作 | `runtime.assertTaskCurrent` |
| I8 | 秘密值不进入消息、日志或协议 | `CredentialBroker` 的直连提交 |
| I9 | 只监听回环地址；校验 Host；拒绝跨源写请求 | `server.ts` |

## 2. 和 Codex 的对应与差异

| 维度 | Codex app-server | pi-bot 设计 | 原因 |
|---|---|---|---|
| Agent | 隐式单 agent | Bot 是一等公民，多 bot 可以互发消息、组群 | 产品本质 |
| Thread | 一段会话 | `(botId, scope)`；scope = `[channelId, conversationId, threadId]` | 已经对应 `isolateConversations` 和 Pi 的独立 session 文件 |
| Turn 触发 | 用户 `turn/start` | 8 种 envelope kind | 非抢占式 inbox 调度 |
| `turn/start` 的返回 | turn 已经开始 | **入队回执**，开始执行时另发 `turn/started` | 调度存在排队和优先级 |
| 对用户说话 | agent message 就是 assistant 文本 | **`send_message` 工具写入 outbox**；assistant 文本是内部过程 | 现有 system prompt 的约定 |
| 通知 | 内存态 | 持久化日志加全局 seq | 断线续传、重启不丢 |
| 审批 | 内存态 server request | 持久化 `requests` 表 | 关闭窗口不会丢失审批 |
| 传输 | stdio / ws / unix / 进程内 | 进程内 / stdio / HTTP+SSE | 不引入新依赖；SSE 原生支持 `Last-Event-ID` |
| 鉴权 | ws 支持 token 文件或签名 | 传输层：token 文件 + 浏览器 cookie 双提交 | 修复现有 token 泄露 |

## 3. 总体架构与模块清单

```
客户端：GUI(React) · CLI · 编辑器/其他 agent
   │ HTTP+SSE      │ 进程内       │ stdio JSONL
┌──▼───────────────▼──────────────▼──────────────────────── src/sdk ──┐
│ client.ts（命名空间 API）· transports/* · state/（共享 reducer）    │
│ protocol/（typebox schema：类型 + 校验 + JSON Schema）              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ JSON-RPC 2.0
┌──────────────────────────────▼───────────────────────── src/daemon ─┐
│ transports/  in-process · stdio · http（鉴权、SSE、静态资源）       │
│ core/        daemon（生命周期）· connection（握手/订阅/背压）       │
│              router（schema 校验、分发、错误归一）                  │
│ handlers/    bot · group · thread · turn · routine · job · request ·│
│              task · daemon · events                                │
│ events/      event-log · derive（记录变更 → 事件）· turn-tracker    │
│ requests/    request-broker                                        │
│ runtime/     runtime · store · lock · proactive* · openmatter ·    │
│              credentials · channel-messages · group-mentions       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ BotHost / ProactivePort / CredentialPort
                               │ + 新增 EventSink / ApprovalPort
┌──────────────────────────────▼──────────────────────────── src/pi ──┐
│ session-factory：Pi 事件 → item 生命周期，上报 EventSink            │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.1 文件清单

**新增**

| 文件 | 职责 |
|---|---|
| `src/sdk/protocol/version.ts` | `PROTOCOL_VERSION`、capability 常量 |
| `src/sdk/protocol/errors.ts` | `ErrorReason` 枚举、`ErrorData` schema、JSON-RPC 错误码 |
| `src/sdk/protocol/models.ts` | Bot、Group、Thread、Turn、Item、Request、Job、Routine 的 schema |
| `src/sdk/protocol/methods/*.ts` | 每个 namespace 一个文件，定义 params/result schema |
| `src/sdk/protocol/notifications.ts` | 所有通知 schema，以及 `EventEnvelope` |
| `src/sdk/protocol/registry.ts` | `methods` 和 `notifications` 注册表（method 名 → schema） |
| `src/sdk/protocol/index.ts` | 导出 `Static<>` 类型和注册表 |
| `src/sdk/transports/{in-process,http-sse,stdio}.ts` | 客户端传输实现 |
| `src/sdk/state/reducer.ts` | `applyEvent(state, event)`，GUI、CLI、性质测试共用 |
| `src/daemon/core/daemon.ts` | `PiBotDaemon`：生命周期状态机，持有 runtime、event-log、broker |
| `src/daemon/core/connection.ts` | 连接状态、订阅、出站队列、server request 路由 |
| `src/daemon/core/router.ts` | 方法分发、params 校验、错误归一 |
| `src/daemon/core/errors.ts` | `PiBotError` 类、`toRpcError()` |
| `src/daemon/handlers/*.ts` | 每个 namespace 一个处理器 |
| `src/daemon/events/event-log.ts` | 追加、读取、订阅扇出、保留期压缩 |
| `src/daemon/events/derive.ts` | 把 `(table, before, after)` 映射成事件 |
| `src/daemon/events/turn-tracker.ts` | turns 表的写入，由 `drain` 钩子调用 |
| `src/daemon/requests/request-broker.ts` | requests 表、等待、解决、超时 |
| `src/daemon/transports/{in-process,stdio,http}.ts` | 服务端传输实现 |
| `src/daemon/migrations.ts` | `schema_version` 表和顺序迁移 |
| `src/daemon/main.ts` | `pi-bot daemon` 命令入口（参数解析、发现文件、信号处理） |

**修改**

| 文件 | 改动 |
|---|---|
| `src/pi/host.ts` | 新增 `EventSink`、`ApprovalPort` 端口；`BotHost` 增加可选的 `events` |
| `src/pi/session-factory.ts` | 订阅 Pi 的 `message_*` 和 `tool_execution_*` 事件并上报；审批改走 `ApprovalPort` |
| `src/daemon/runtime/store.ts` | `put` 通过 `derive` 在同一事务里写入事件；新增 `turns`、`requests`、`threads`、`events` 表 |
| `src/daemon/runtime/runtime.ts` | `drain` 和 `pump` 调用 TurnTracker；session 卸载；抛错换成 `PiBotError` |
| `src/daemon/runtime/proactive.ts` 等 | 抛错换成 `PiBotError` |
| `src/gui/main.jsx` | 改用 `useDaemon()`；新增待处理面板；错误按 reason 本地化 |
| `src/daemon/cli.ts` | 改为 SDK 客户端，使用 `transport: 'auto'` |

**删除**：`src/daemon/server.ts`（职责拆分到 `transports/http.ts`、`handlers/*`、`core/daemon.ts`）、`src/sdk/client.ts` 的现有 REST 实现（重写）。

### 3.2 分层规则（更新 `test/layers.test.ts`）

- daemon 可以值引用 `src/sdk/protocol/**`（schema、注册表、常量），不能引用 `src/sdk/client.ts`、`src/sdk/transports/**`、`src/sdk/state/**`。
- sdk 的 `protocol/**` 只能依赖 typebox 和 `src/pi/types.ts`（type-only）。
- pi 不知道事件和请求最终如何使用，只调用端口。

## 4. 领域模型与 ID

### 4.1 ID 规则

| 实体 | 格式 | 来源 |
|---|---|---|
| Bot | UUID（保持现状） | `Store.createBot` |
| Group | `group:<uuid>`（保持现状） | `runtime.createGroup` |
| Thread | `thr_<base64url(sha256(botId + "\0" + scope))[0..22]>` | 确定性派生，**无需迁移**；`scopeKey` 和现有 `sessionFiles` 的 key 一致 |
| Turn | `trn_<uuidv7>` | TurnTracker，在 admit 时生成 |
| Item | `itm_<uuidv7>`；锚定到已有记录的 item 用 `<kind>:<recordId>`（例如 `outbox:<id>`） | 锚定方式保证重放时 ID 稳定 |
| Request | `req_<uuidv7>` | RequestBroker |
| Event | `seq`（INTEGER，全局单调） | SQLite AUTOINCREMENT |

uuidv7 按时间有序，便于分页和排序（Node 24 需要自己实现，约 15 行，放在 `daemon/core/ids.ts`）。

### 4.2 核心模型（协议视图，typebox 定义的语义）

```ts
type Thread = {
  id: string; botId: string;
  scope: { channelId: string | null; conversationId: string | null; threadId: string | null };
  status: 'stored' | 'loaded' | 'archived';
  activeTurnId: string | null;
  lastActivityAt: number; createdAt: number;
};

type Turn = {
  id: string; threadId: string; botId: string;
  trigger: 'user' | 'answer' | 'bot' | 'job' | 'schedule' | 'monitor' | 'research' | 'memory';
  status: 'queued' | 'running' | 'completed' | 'yielded' | 'interrupted' | 'uncertain' | 'failed';
  primaryInputId: string;          // 主 envelope
  inputIds: string[];              // 主 envelope + pump 进来的 batch
  taskId: string;
  startedAt: number | null; endedAt: number | null;
  usage: { input: number; output: number; cacheRead: number; reasoning: number; totalTokens: number; costUsd: number } | null;
  error: { reason: ErrorReason; message: string } | null;
};

type Item =
  | { type: 'inputMessage';  id; turnId; threadId; envelopeId: string; source: 'user'|'answer'|'peer'|'trigger'|'job'; sender: string; text: string; status: 'completed' }
  | { type: 'agentMessage';  id; turnId; threadId; outboxId: string; text: string; delivery: 'pending'|'delivered'|'superseded'|'uncertain'; status: 'inProgress'|'completed' }
  | { type: 'peerMessage';   id; turnId; threadId; envelopeIds: string[]; to: string[]; target: 'direct'|'group'; text: string; status: 'completed' }
  | { type: 'toolCall';      id; turnId; threadId; toolCallId: string; tool: string; args: unknown; result?: unknown; isError?: boolean; status: 'inProgress'|'completed' }
  | { type: 'job';           id; turnId; threadId; jobId: string; tool: string; state: Job['state']; status: 'inProgress'|'completed' }
  | { type: 'request';       id; turnId; threadId; requestId: string; kind: RequestKind; status: 'inProgress'|'completed' }
  | { type: 'compaction';    id; turnId; threadId; tokensBefore: number; tokensAfter: number; status: 'completed' }
  | { type: 'internalNote';  id; turnId; threadId; text: string; status: 'inProgress'|'completed' }; // 仅在 capability debugInternal 下发出
```

字段命名统一用 camelCase；时间统一为 Unix 毫秒。

### 4.3 Item 锚定规则

一个 item 能锚定到持久化记录时，以记录为准，item 只是视图：

| Item | 锚定记录 | 终态来源 |
|---|---|---|
| inputMessage | `inbox` | envelope 被 admit 时即 completed |
| agentMessage | `outbox` | outbox 写入时 completed；`delivery` 字段跟随 outbox 状态 |
| peerMessage | `inbox`（对方收件） | `sendToBot` / `sendToGroup` 提交时 |
| job | `jobs` | job 从 running 转为终态 |
| request | `requests` | 请求被解决、过期或取消 |
| toolCall | 无（来自 Pi 事件） | `tool_execution_end` |
| compaction | 无（来自 context 扩展） | compaction 完成 |

## 5. 存储：DDL、迁移、事件派生

### 5.1 新增表

```sql
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS events(
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  method    TEXT    NOT NULL,
  bot_id    TEXT,
  thread_id TEXT,
  turn_id   TEXT,
  data      TEXT    NOT NULL          -- 已脱敏 JSON，即通知的 params
);
CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, seq);
CREATE INDEX IF NOT EXISTS events_bot    ON events(bot_id, seq);

-- 下面三张表沿用现有 (id TEXT PRIMARY KEY, data TEXT) 风格，复用 Store.get/list/put
-- turns:    data = Turn
-- requests: data = PendingRequest
-- threads:  data = { id, botId, scope, scopeKey, archived, lastActivityAt, createdAt }
CREATE INDEX IF NOT EXISTS turns_thread    ON turns(json_extract(data,'$.threadId'));
CREATE INDEX IF NOT EXISTS requests_state  ON requests(json_extract(data,'$.status'));
```

`Store.table()` 的白名单增加 `turns`、`requests`、`threads`。`events` 表不走通用的 `put`，由 `EventLog` 专门写入。

### 5.2 迁移

`migrations.ts` 维护一个有序数组 `[{version, up(db)}]`，daemon 启动时在 `recovering` 阶段、同一个事务里按版本顺序执行：

| version | 内容 |
|---|---|
| 1 | 建 `schema_version`；建 `events`、`turns`、`requests`、`threads` 及索引 |
| 2 | 回填 `threads`：扫描 `bots.sessionFiles` 和 inbox 的 route，生成 thread 记录 |
| 3 | 回填 `requests`：把 `questions` 表中 `pending` 的记录转成 `question` 请求（原表保留，作为锚定记录） |
| 4 | 写一条 `daemon/migrated{fromVersion, toVersion}` 事件作为 seq 起点 |

不回填历史事件。客户端首次连接时从快照开始，快照的 seq 就是当前最大 seq。

现有的 `channel_messages` 和 `channel_message_events` 保留不动，`ChannelMessageReader` 和 `messages:query` CLI 保持兼容。

### 5.3 事件派生：集中在 `Store.put`

现有代码有 29 处 `store.put`。不在每个调用点手动发事件，而是在 `Store.put(table, value)` 里统一处理：

```ts
put(table, value) {
  const write = () => {
    const before = this.get(table, value.id);       // 已有记录，或 undefined
    /* 原有写入逻辑（脱敏、upsert、频道投影） */
    for (const event of derive(table, before, after, this.context))
      this.events.append(event);                     // 同一个事务
  };
  this.db.isTransaction ? write() : this.transaction(write);
}
```

- `this.context` 是 AsyncLocalStorage 里的当前 `{threadId, turnId}`，由 TurnTracker 在 `drain` 中设置。
- `derive` 是纯函数，可以单独测试。

`derive` 的映射表：

| 表 | 状态变化 | 产生的事件 |
|---|---|---|
| `bots` | 新建 / 更新 | `bot/created` / `bot/updated` |
| `groups` | 新建 / 成员变化 | `group/created` / `group/updated` |
| `inbox` | 新建 `queued` | `turn/queued`（主输入，见第 11 节）或 `inbox/queued`（会被 pump 吸收的输入） |
| `inbox` | `queued → processing` | `item/started` + `item/completed`（inputMessage） |
| `inbox` | `→ uncertain` / `→ failed` | `task/reviewRequired` |
| `inbox` | `uncertain →`（核对完成） | `task/reconciled` |
| `outbox` | 新建 `pending` | `item/completed`（agentMessage，`delivery: 'pending'`） |
| `outbox` | `→ delivered` / `superseded` / `uncertain` | `item/updated`（agentMessage 的 delivery 变化） |
| `jobs` | 新建 `running` | `item/started`（job） |
| `jobs` | `running → 终态` | `item/completed`（job） |
| `questions` | 新建 / 已回答 | 交给 RequestBroker（见第 13 节），这里不重复派生 |
| `schedules` / `monitors` | 任意变化 | `routine/updated` |
| `fires` | 新建 | `routine/fired` |
| `proposals` / `memories` | 任意变化 | `proposal/updated` / `memory/updated` |
| `turns` | 新建 / 状态变化 | `turn/started` / `turn/completed` |
| `requests` | 新建 / 解决 | `request/created` / `request/resolved` |
| `threads` | 新建 / 加载 / 卸载 / 归档 | `thread/started` / `thread/loaded` / `thread/unloaded` / `thread/archived` |

事件里的数据是**协议视图**，不是原始记录：例如 job 不带 `args` 和 `result`，monitor 不带 `cursor` 和 `baseline`，和现有 `Store.state()` 的裁剪规则一致。投影函数放在 `events/derive.ts`，和协议 schema 对齐，并且有测试。

## 6. 事件日志语义

### 6.1 事件信封

```ts
type EventEnvelope = {
  seq: number;           // 持久化事件才有；delta 为 null
  at: number;
  method: string;        // 例如 'item/completed'
  params: unknown;       // 对应通知的 schema
};
```

### 6.2 保证

| 保证 | 说明 |
|---|---|
| 原子性 | 状态和事件在同一事务内提交，不会只有一边 |
| 全序 | seq 全局单调；同一事务产生的多条事件 seq 连续 |
| 快照一致 | `*/read` 和 `daemon/snapshot` 在一个读事务内取状态和 `max(seq)` |
| 无缺口续传 | `events/subscribe{after: n}` 先从表里回放 `seq > n` 的事件，再无缝切换到实时推送（切换期间加锁，不会漏掉中间提交的事件） |
| 至少一次 | 客户端用 seq 去重，因此在客户端看来是恰好一次 |
| delta 尽力而为 | `item/*/delta` 不落盘、没有 seq；丢失不影响终态 |

### 6.3 订阅过滤

`filter: { botIds?: string[]; threadIds?: string[]; methods?: string[] }`。过滤在服务端执行。为了让客户端保持连续性，被过滤掉的事件仍然推进水位线：每 N 条事件或每 5 秒发一次 `events/watermark{seq}`。

### 6.4 保留期

- 默认保留 7 天或 100 万条，以先达到者为准。由 daemon 的定时器执行 `DELETE ... WHERE seq < cutoff`。
- `cutoff` 不会越过当前活跃订阅里最小的已确认 seq；客户端用 `events/ack{seq}` 确认，最多保护 24 小时。
- 请求的 `after` 小于表中最小 seq 时，返回 `cursorExpired`，客户端应重新拉快照。

## 7. 协议：线格式、传输、鉴权

### 7.1 线格式

JSON-RPC 2.0，字段 `jsonrpc: "2.0"` 可以省略（和 Codex 一致）。

```jsonc
→ {"id":1,"method":"turn/start","params":{"botId":"…","text":"hi","key":"k1"}}
← {"id":1,"result":{"turn":{"id":"trn_…","status":"queued",…},"inputId":"…"}}
← {"method":"turn/started","params":{"turn":{…}},"seq":1042}
← {"id":"srv_7","method":"request/approval","params":{"request":{…}}}   // server → client 请求
→ {"id":"srv_7","result":{"decision":"approve"}}
```

通知在 JSON-RPC 之外额外带一个 `seq` 字段（delta 没有）。

### 7.2 传输

| 传输 | 适用 | 帧格式 | 鉴权 |
|---|---|---|---|
| 进程内 | CLI 嵌入、测试 | 直接传对象（仍然经过 schema 校验，保证和远程行为一致） | 不需要 |
| stdio | 编辑器、其他 agent 拉起子进程 | JSONL，一行一条消息；日志只写 stderr | 继承父进程 |
| HTTP | GUI、本机工具 | `POST /rpc`：请求体为单条或批量 JSON-RPC；`GET /events`：SSE | token 文件或 cookie |

**HTTP 细节**

- `POST /rpc` 必须带 `X-PiBot-Connection: <connectionId>`（由 `initialize` 返回）。也就是说 HTTP 是"短请求 + 一条长 SSE"的组合，两者通过 connectionId 关联。
- `GET /events?connection=<id>`：SSE 的每条消息写成 `id: <seq>`、`event: <method>`、`data: <json>`。浏览器重连时会自动带上 `Last-Event-ID`，服务端据此续传，**这是选 SSE 而不是 ws 的关键理由**。
- server→client 请求也通过 SSE 下发（`event: request`）；客户端用 `POST /rpc` 回复。
- 每 15 秒发一次心跳注释 `:keepalive`。
- `GET /readyz`：daemon 处于 ready 状态时返回 200，否则 503。`GET /healthz`：进程存活即返回 200。两者都拒绝带 `Origin` 头的请求。
- 静态资源：`GET /` 和 `/assets/*` 从 `dist/gui` 提供。

### 7.3 鉴权

| 客户端 | 方式 |
|---|---|
| 本机程序（CLI attach、脚本） | daemon 启动时生成 32 字节随机 token，写入 `<dataDir>/daemon.token`（权限 0600）；请求带 `Authorization: Bearer <token>` |
| 浏览器 GUI | 访问 `GET /` 时，daemon 设置 `pibot_session` cookie（HttpOnly、SameSite=Strict、Path=/），并在 HTML 的 `<meta name="pibot-csrf">` 里注入 CSRF 值；`POST /rpc` 必须同时带 cookie 和 `X-PiBot-CSRF` 头（双提交校验）。SSE 只需要 cookie |
| 所有 HTTP | 只绑定 127.0.0.1；`Host` 必须是 `127.0.0.1:<port>`；有 `Origin` 时必须同源（保留 I9） |

token 每次 daemon 启动重新生成。**`daemon/snapshot` 的结果里不再包含任何凭据**，修复当前 `GET /api/state` 泄露写 token 的问题。

## 8. 连接生命周期

```
          传输层鉴权通过
 open ───────────────────► awaitingInit
                              │ initialize（成功）
                              ▼
                           initializing ──► 收到 initialized 通知 ──► active
                              │                                      │
   其他任何请求 → notInitialized                慢消费者 / 客户端关闭 / daemon 停止
                                                                     ▼
                                                                  closed
```

### 8.1 initialize

```ts
// params
{ clientInfo: { name: string; title?: string; version: string };
  protocolVersion: string;                  // 客户端支持的版本
  capabilities?: {
    experimentalApi?: boolean;
    streamingReplies?: boolean;             // 接收 agentMessage 的流式 delta
    debugInternal?: boolean;                // 接收 internalNote（bot 内部文本），默认关闭
    serverRequests?: RequestKind[];         // 本客户端能处理的 server request 类型
    optOutNotifications?: string[];         // 精确匹配的通知名
  } }
// result
{ serverInfo: { name: 'pi-bot'; version: string };
  protocolVersion: string;                  // 服务端选定的版本
  capabilities: { transports: string[]; requestKinds: RequestKind[]; experimental: string[] };
  connectionId: string;
  daemon: { status: DaemonStatus; dataDir: string } }
```

- 版本协商：服务端支持一个版本区间，取双方都支持的最高版本；没有交集时返回 `invalidRequest`，并在 `data.supported` 里列出支持的版本。
- 重复调用 `initialize`：返回 `invalidRequest`，reason 为 `alreadyInitialized`。
- 只有在 `capabilities.serverRequests` 里声明过的请求类型，才会发给这个连接。

### 8.2 背压

| 方向 | 限制 | 超限行为 |
|---|---|---|
| 入站 | 每连接同时在处理的请求 ≤ 32 | 返回 `overloaded`（可重试） |
| 入站 | 单条消息 ≤ 1 MiB | 返回 `invalidParams` |
| 出站 | 每连接队列 ≤ 1000 条或 8 MiB | 先丢弃 delta；仍超限时关闭连接，原因 `lagged`。客户端按最后收到的 seq 续传即可补齐 |

## 9. daemon 进程生命周期

### 9.1 状态机

| 状态 | 进入条件 | 允许的请求 | 退出条件 |
|---|---|---|---|
| `starting` | 进程启动 | 无（连接被挂起） | 参数解析完成 |
| `recovering` | — | 无 | 拿到锁、执行迁移、`Store.recover()`、修复事件、启动 trigger 和 proactive |
| `ready` | 恢复成功 | 全部 | 收到 SIGINT/SIGTERM、`daemon/shutdown`，或最后一个嵌入方释放 |
| `draining` | 开始关闭 | 只读请求、`request/resolve`、`events/*`；**会产生新工作的请求返回 `shuttingDown`** | 活跃 turn 和 job 结束，或到达 `drainTimeoutMs` |
| `stopped` | drain 结束 | 无 | 关闭 runtime 和 trigger、释放锁、删除 `daemon.json`、退出 |

"会产生新工作的请求"包括：`turn/start`、`turn/steer`、`bot/create`、`group/create`、`routine/create`、`task/reconcile`（outcome=queued 的情况）。

drain 超时后，仍在执行的 turn 和 job 交给现有的 `Store.recover()` 语义处理：下次启动时变为 `uncertain`，**不重放（I2）**。

每次状态迁移都会广播 `daemon/statusChanged{from, to, at}`，并且写入事件日志。

### 9.2 发现与附着

daemon 进入 ready 后写 `<dataDir>/daemon.json`（权限 0600）：

```json
{ "pid": 12345, "protocolVersion": "2026-10-13",
  "http": "http://127.0.0.1:4317", "tokenFile": "<dataDir>/daemon.token",
  "startedAt": 1791872827446 }
```

客户端使用 `transport: 'auto'` 时的决策流程：

1. 读取 `daemon.json`。文件存在、pid 存活、`/readyz` 返回 200、协议版本兼容，就**附着**上去。
2. 文件存在但进程已经死亡，删除文件，进入第 3 步。
3. 尝试获取数据库锁。成功就**嵌入**一个 daemon（不监听端口，除非显式指定 `--listen`）；失败说明另有进程持有锁但没有暴露 HTTP，报错退出，并提示用 `pi-bot daemon` 启动。

嵌入模式下，进程退出时 daemon 走完整的 draining 流程。

### 9.3 命令行

```
pi-bot daemon [--listen http://127.0.0.1:4317 | --listen stdio | --listen off]
              [--data-dir work/gui/demo] [--static dist/gui]
pi-bot status            # 读取 daemon.json，调用 daemon/status
pi-bot stop              # 调用 daemon/shutdown
pi-bot chat [--bot ID]   # 交互式客户端，使用 auto 传输
```

`npm start` 等价于 `pi-bot chat`；`npm run daemon` 等价于 `pi-bot daemon --listen http://127.0.0.1:4317`。

## 10. Thread 生命周期

```
            第一条该 scope 的 envelope 被接受
  (不存在) ─────────────────────────────────► stored
                                               │ drain 需要 session
                                               ▼
              安全卸载（4 个条件 + 空闲超时） loaded ◄─┐
  stored ◄──────────────────────────────────────┘     │ 再次需要
     │                                                 │
     └──── thread/archive（仅当处于 stored）──► archived ─┘ thread/unarchive
```

### 10.1 安全卸载条件

以下 4 个条件必须同时满足，并且判断时持有该 bot 的 lane（和 `drain` 互斥）：

1. 该 thread 没有活跃 turn（`runtime.active` 中没有它）。
2. 没有 `messageId` 属于该 thread 的 `running` job。
3. 没有属于该 thread scope 的 `queued` 或 `processing` envelope。
4. 没有属于该 thread 的 pending request。

满足后再要求：`lastActivityAt` 距今超过 `idleUnloadMs`（默认 10 分钟），或者 loaded thread 数超过 `maxLoadedThreads`（默认 32，按 LRU 淘汰）。

卸载动作：从 `runtime.sessions` 中删除，调用 `session.close()`，更新 threads 表（产生 `thread/unloaded` 事件）。下次进入 `drain` 时，factory 会用现有的 `sessionFiles[scopeKey]` 恢复 Pi session，上下文完整。

### 10.2 归档

- 只能归档处于 stored 状态的 thread。
- 归档后，发往该 scope 的新 envelope 返回 `invalidRequest`（reason `threadArchived`），需要先 `thread/unarchive`。
- 归档不删除任何数据。

## 11. Turn 生命周期

### 11.1 状态机

```
queued ──admit──► running ──┬─ run 正常结束，全部输入已消费 ─────────────► completed
                            ├─ InferenceYieldError ──────────────────────► yielded
                            │     （未消费的输入回到 queued，并标记 deferredContinuation；
                            │       之后会作为新 turn 续跑）
                            ├─ taskControl=cancel 被处理 ─────────────────► interrupted
                            ├─ 主输入未被确认消费（consumed=false）─────────► uncertain
                            └─ 抛出其他错误且未 resolved ──────────────────► failed（输入 → uncertain）
```

`yielded` 是正常的调度结果，不是错误。GUI 显示为"已让出，稍后继续"。

### 11.2 对应 `drain` 的钩子点（`src/daemon/runtime/runtime.ts`）

| 钩子 | 位置 | TurnTracker 动作 |
|---|---|---|
| `accept` 写入主输入 | `accept()` 中 `store.put('inbox', e)` | 派生 `turn/queued`：此时还不知道它会成为主输入还是被 pump 吸收，所以只记录"有输入排队" |
| admit 主输入 | `drain()` 中 `state: 'processing'` 之后 | `begin(e)`：生成 turnId，写 turns(`running`)，设置 AsyncLocalStorage 上下文 `{threadId, turnId}` |
| pump 吸收输入 | `pump()` 中 `active.batch.push(item)` | `addInput(turnId, item)`：追加到 `inputIds` |
| run 正常结束 | `await run` 之后、batch 状态写回之后 | `end(turnId, 'completed' 或 'uncertain')`：依据主输入最终的 inbox 状态 |
| 让出 | `catch` 中 `InferenceYieldError` 分支 | `end(turnId, 'yielded')` |
| 其他错误 | `catch` 的其余分支 | `end(turnId, resolved ? 'completed' : 'failed', error)` |
| 取消 | 检测到主输入的 `taskControl === 'cancel'` 已被处理 | `end(turnId, 'interrupted')` |

usage 统计：TurnTracker 在 `end` 时汇总本 turn 期间 Pi `message_end` 事件里 assistant message 的 usage（经 EventSink 上报），替代现在 `server.ts` 里扫描 JSONL 文件的 `modelUsage()`。

### 11.3 和协议方法的关系

| 方法 | 实现 | 返回 |
|---|---|---|
| `turn/start{botId, text, key, groupId?, threadId?}` | `runtime.accept` 或 `acceptGroupUser`（幂等） | `{inputId, threadId, status: 'queued'}`。**不承诺已经开始** |
| `turn/steer{threadId, text, key}` | `accept` 并设置 `taskControl: 'replace'`，复用当前 turn 的 taskId | 同上 |
| `turn/interrupt{threadId, key}` | `accept` 并设置 `taskControl: 'cancel'`；如果该 bot 正在推理且开启了 `preemptInference`，同时触发 `yieldForUser` | `{inputId}` |
| `turn/list{threadId, cursor, limit}` | 读 turns 表 | 分页 |

## 12. Item 生命周期

### 12.1 Pi 事件到 item 的映射（在 `pi/session-factory.ts` 中实现，通过 EventSink 上报）

| Pi 事件 | 条件 | 上报给 EventSink |
|---|---|---|
| `tool_execution_start` | 工具名不是 `send_message` | `toolStarted{toolCallId, tool, args（脱敏）}` |
| `tool_execution_update` | 同上 | `toolDelta{toolCallId, partial}`（仅限文本，截断到 4 KiB） |
| `tool_execution_end` | 同上 | `toolCompleted{toolCallId, result（脱敏、截断）, isError}` |
| `message_update` | `assistantMessageEvent` 是 `send_message` 工具调用参数的增量 | `replyDelta{toolCallId, textDelta}`（只发给声明了 `streamingReplies` 的连接） |
| `message_update` | assistant 文本增量 | `internalDelta`（只发给声明了 `debugInternal` 的连接） |
| `message_end` | assistant 消息 | `usage{...}`（交给 TurnTracker 汇总） |
| context 扩展完成 compaction | — | `compaction{tokensBefore, tokensAfter}` |

`send_message` 不产生 toolCall item：它的终态就是 outbox 写入，由 `derive` 产生 agentMessage 的 `item/completed`。流式阶段的 item ID 用 `toolCallId` 关联，完成时 item 会带上 `outboxId`，客户端用 toolCallId 把流式预览和最终消息合并。

reasoning 和 thinking 内容在 EventSink 入口处就丢弃（复用 `redactTraceValue` 的规则），永远不会出 daemon。

### 12.2 EventSink 端口（新增到 `src/pi/host.ts`）

```ts
export type PluginEvent =
  | { type: 'toolStarted'; toolCallId: string; tool: string; args: unknown }
  | { type: 'toolDelta'; toolCallId: string; partial: string }
  | { type: 'toolCompleted'; toolCallId: string; result: unknown; isError: boolean }
  | { type: 'replyDelta'; toolCallId: string; textDelta: string }
  | { type: 'internalDelta'; textDelta: string }
  | { type: 'usage'; input: number; output: number; cacheRead: number; reasoning: number; totalTokens: number; costUsd: number }
  | { type: 'compaction'; tokensBefore: number; tokensAfter: number };

export interface EventSink {
  emit(botId: string, event: PluginEvent): void;   // 同步、不抛错、不阻塞
}
// BotHost 新增：readonly events?: EventSink;
```

daemon 的实现从 AsyncLocalStorage 取当前 `{threadId, turnId}`，在这里完成关联、脱敏，并区分持久化（`toolCompleted`、`compaction` 写入事件日志）和非持久化（所有 delta 只扇出）。

## 13. Server Request

### 13.1 类型

| kind | 来源（现状） | params | 响应 | 超时默认 |
|---|---|---|---|---|
| `approval` | `runtime.options.permission` 同步回调（共 3 处：`runtime.startJob`，以及 session-factory 中的 codemode 执行和 coding worker 各 1 处） | `{botId, taskId, tool, args（脱敏）, reason?}` | `{decision: 'approve' \| 'deny', note?}` | 10 分钟，超时视为拒绝 |
| `question` | `ask_user` → questions 表 + outbox 消息 | `{botId, taskId, questionId, text}` | `{text}` | 不超时 |
| `credential` | `request_credential` → outbox 里的一条 JSON | `{botId, taskId, tool, label, formUrl, expiresAt}` | `{submitted: true}`（**秘密值经 `formUrl` 直连 CredentialBroker 提交，不经过协议**） | 跟随表单的 `expiresAt` |

### 13.2 状态机与存储

```ts
type PendingRequest = {
  id: string; kind: RequestKind; botId: string; threadId: string; turnId: string | null;
  params: unknown;
  status: 'pending' | 'resolved' | 'expired' | 'cancelled';
  response?: unknown; resolvedBy?: string /* connectionId 或 'timeout' 或 'host' */;
  createdAt: number; expiresAt: number | null; resolvedAt?: number;
};
```

规则：

- 创建时写入 requests 表（产生 `request/created`），并向所有声明支持该 kind、且订阅了这个 thread 的连接发送 server→client 请求。
- 客户端可以直接回复这个 JSON-RPC 请求，也可以调用 `request/resolve{requestId, response}`，两种方式等价。
- **首个提交者生效**：已解决的请求再次提交相同内容时返回原结果；内容不同时返回 `conflict`。
- 解决后广播 `request/resolved`，其他连接撤下界面上的提示。
- 关联的任务被替换或取消时（I7），请求变为 `cancelled`。
- 重启后 pending 请求依然有效：`approval` 背后的 job 已经被 `Store.recover()` 标记为 `uncertain`，所以这类请求在恢复阶段统一转为 `cancelled`（原因 `daemonRestarted`）；`question` 和 `credential` 保持 pending。

### 13.3 和现有代码的衔接

- `ApprovalPort.request(params): Promise<boolean>` 新增到 `src/pi/host.ts`。daemon 的实现是 `RequestBroker.awaitApproval`。
- `runtime.options.permission` 保留，作为嵌入场景的覆盖入口；两者都配置时，先执行 `permission` 回调，返回 true 后再走 broker。
- `askUser` 保持现有的写入逻辑（questions 表和 outbox），额外创建一条 question 请求；`answer()` 解决对应请求。`answer` 原有的 HTTP 入口被 `request/resolve` 取代。
- job 在等待审批期间保持 `running`，item 显示为"等待审批"（item 携带 `requestId`）。

## 14. 方法目录

记号：🔒 表示会产生新工作，draining 状态下被拒绝；🔁 表示需要幂等键。

### 14.1 daemon / events

| 方法 | params | result | 说明 |
|---|---|---|---|
| `initialize` | 见 8.1 | 见 8.1 | 每个连接只能调用一次 |
| `daemon/status` | `{}` | `{status, startedAt, protocolVersion, loadedThreads, activeTurns, runningJobs, pendingRequests, model: {id, setupRequired, message?}, budget?}` | |
| `daemon/snapshot` | `{botIds?}` | `{seq, bots, groups, threads, activeTurns, pendingRequests, routines, jobs, budget, usage}` | 一个读事务内完成；**不再包含 token** |
| `daemon/shutdown` | `{drainTimeoutMs?}` | `{}` | 只允许 stdio、进程内传输和带 Bearer token 的 HTTP 调用 |
| `events/subscribe` | `{after: number, filter?}` | `{subscriptionId, replayedThrough: number}` | 回放 `after` 之后的事件，然后切换到实时推送 |
| `events/unsubscribe` | `{subscriptionId}` | `{}` | |
| `events/ack` | `{seq}` | `{}` | 保护保留期，见 6.4 |

### 14.2 bot / group

| 方法 | params | result | 错误 |
|---|---|---|---|
| `bot/list` | `{}` | `{bots: Bot[]}` | |
| `bot/read` | `{botId}` | `{bot, threads: Thread[], state: BotState}` | notFound |
| `bot/create` 🔒 | `{name, description?, channelId?}` | `{bot}` | invalidParams、capacity |
| `bot/update` | `{botId, name?, description?}` | `{bot}` | notFound、invalidParams |
| `group/list` | `{}` | `{groups}` | |
| `group/create` 🔒 | `{name, memberIds}` | `{group}` | invalidParams、capacity |
| `group/update` | `{groupId, name?, addMemberIds?, removeMemberIds?}` | `{group}` | notFound、invalidParams |

### 14.3 thread / turn

| 方法 | params | result | 错误 |
|---|---|---|---|
| `thread/list` | `{botId?, status?, cursor?, limit≤100}` | `{threads, nextCursor}` | |
| `thread/read` | `{threadId, cursor?, limit≤200}` | `{thread, turns: Turn[], items: Item[], seq, nextCursor}` | notFound；不加载 session |
| `thread/archive` / `thread/unarchive` | `{threadId}` | `{thread}` | notFound、invalidRequest(threadLoaded) |
| `thread/unload` | `{threadId}` | `{unloaded: boolean, blockedBy?: string[]}` | 不满足条件时返回 false 和原因 |
| `turn/start` 🔒🔁 | `{botId, text≤64000, key, groupId?, threadId?}` | `{inputId, threadId, status: 'queued'}` | notFound、conflict、capacity、budgetExhausted、setupRequired、threadArchived |
| `turn/steer` 🔒🔁 | `{threadId, text, key}` | 同上 | notFound、conflict |
| `turn/interrupt` 🔁 | `{threadId, key}` | `{inputId}` | notFound |
| `turn/list` | `{threadId, cursor?, limit}` | `{turns, nextCursor}` | |

### 14.4 routine / job / request / task

| 方法 | params | result | 错误 |
|---|---|---|---|
| `routine/list` | `{botId?, kind?}` | `{routines: Routine[]}` | |
| `routine/create` 🔒 | `{kind: 'schedule', botId, prompt, at, timezone, intervalMs?, groupId?}` 或 `{kind: 'monitor', botId, prompt, filePath?, intervalMs, deadline, groupId?}` | `{routine}` | invalidParams、forbidden（文件在仓库外） |
| `routine/pause` / `resume` / `cancel` / `enable` | `{routineId}` | `{routine}` | notFound、invalidRequest |
| `routine/dryRun` | `{routineId}` | `{decision, error?}` | notFound |
| `job/list` | `{botId?, threadId?, state?}` | `{jobs}` | |
| `job/read` | `{jobId, offset?, limit≤8000}` | `JobResultPage` | notFound |
| `request/list` | `{status?: 'pending', threadId?}` | `{requests}` | |
| `request/resolve` | `{requestId, response}` | `{request}` | notFound、conflict、invalidParams |
| `task/reconcile` | `{inputId}` | `{outcome: 'processed' \| 'queued'}` | notFound、reviewRequired（已有执行痕迹，需要人工核查） |

`routine/*` 的 `routineId` 编码为 `schedule:<id>` 或 `monitor:<id>`，服务端据此分派到 `ProactiveService` 的对应方法，取代现在 `/api/routine/action` 里 `kind + action` 的组合。

## 15. 通知目录

| 通知 | 持久化 | params |
|---|---|---|
| `daemon/statusChanged` | 是 | `{from, to, at}` |
| `events/watermark` | 否 | `{seq}` |
| `bot/created`、`bot/updated` | 是 | `{bot}` |
| `group/created`、`group/updated` | 是 | `{group}` |
| `thread/started`、`loaded`、`unloaded`、`archived` | 是 | `{thread}` |
| `turn/queued` | 是 | `{inputId, threadId, trigger}` |
| `turn/started` | 是 | `{turn}` |
| `turn/completed` | 是 | `{turn}`（含终态、usage、error） |
| `item/started` | 是 | `{item}` |
| `item/updated` | 是 | `{item}`（仅限 agentMessage 的投递状态、job 的状态变化） |
| `item/completed` | 是 | `{item}` |
| `item/agentMessage/delta` | 否 | `{threadId, turnId, itemId, toolCallId, textDelta}` |
| `item/toolCall/delta` | 否 | `{threadId, turnId, itemId, partial}` |
| `item/internal/delta` | 否 | `{threadId, turnId, textDelta}`（仅限 debugInternal） |
| `request/created`、`request/resolved` | 是 | `{request}` |
| `routine/updated`、`routine/fired` | 是 | `{routine}` / `{routineId, fireId, inputId}` |
| `job/updated` | 是 | `{job}`（不含 args 和 result） |
| `task/reviewRequired`、`task/reconciled` | 是 | `{inputId, threadId, error?}` / `{inputId, outcome, evidence}` |

## 16. 错误模型与现有抛错的映射

### 16.1 结构

```ts
// JSON-RPC error
{ code: number, message: string, data: { reason: ErrorReason; retryable: boolean; details?: object } }

class PiBotError extends Error {
  constructor(readonly reason: ErrorReason, message: string, readonly details?: object) { super(message); }
}
```

| JSON-RPC code | 用于 |
|---|---|
| -32700 | JSON 解析失败 |
| -32600 | invalidRequest、notInitialized、alreadyInitialized、shuttingDown、threadArchived |
| -32601 | 方法不存在 |
| -32602 | invalidParams（schema 校验失败时附带字段路径） |
| -32001 | overloaded、capacity、budgetExhausted（`retryable` 视具体情况而定） |
| -32002 | notFound、conflict、forbidden、reviewRequired、setupRequired、taskCancelled、cursorExpired |
| -32603 | internal（不暴露堆栈） |

### 16.2 ErrorReason 及现有抛错的映射

daemon 目录下共 87 处抛错（runtime 36、proactive 31、server 16、store 4）。按 reason 分组：

| reason | retryable | 现有 message（节选） |
|---|---|---|
| `invalidParams` | 否 | Idempotency key required、Input exceeds 64000 characters、Message too large、Question exceeds 4000 characters、Invalid trigger definition、Invalid timezone、Invalid schedule time、Invalid monitor bounds、Invalid bot profile、Invalid group、Invalid cursor、Invalid page limit、Invalid evidence refs、Memory key required、Invalid credential label、请选择 bot 并输入 1–20000 字的消息、请输入 bot 名称、请选择未来时间、群名及至少两名有效成员必填、被 @ 的 bot 名称不唯一、找不到被 @ 的群成员、Invalid routine kind、Invalid schedule action、Invalid monitor action |
| `notFound` | 否 | Unknown recipient、Unknown group、Unknown job、Unknown question、Unknown routine、Unknown original source、Missing native inbox |
| `conflict` | 否 | Idempotency key conflict（8 处）、Question already answered、Memory snapshot changed、Evidence changed or withdrawn、Evidence changed during review、Applied proposal was superseded |
| `forbidden` | 否 | Recipient channel mismatch、Bot 不属于该群、Trigger owner mismatch、Proposal owner mismatch、Only host user input can control a task、Group delivery requires an inherited channel、监控文件须位于当前仓库、Detector not host-allowlisted、Background worker not host-allowlisted、Channel query outside scope、Permission denied |
| `capacity` | 是 | Inbox capacity reached、Bot capacity reached、Group capacity reached、Pending question capacity reached、Concurrent job budget reached、Credential capacity reached |
| `budgetExhausted` | 否 | Message hop budget exceeded、Task message budget exceeded、Task outbox budget exceeded、Task job budget exceeded、GUI bounded model budget exhausted、本轮请求或时间额度已用完、Evidence exceeds work budget |
| `taskCancelled` | 否 | Task superseded or cancelled; no new action permitted、Trigger cancelled; no new action permitted |
| `invalidRequest` | 否 | Schedule completed or cancelled、Monitor expired or cancelled、Successful dry-run required before enable、Only memory proposals can apply、Applied memory cannot be cancelled、Inbox must be uncertain、Task does not need review、Independent approval required |
| `reviewRequired` | 否 | 已有执行痕迹，需单独核查；不会自动重放、Resolution requires evidence、Host review note required、Evidence must be delivered correlated output、Evidence must be own admitted host input |
| `setupRequired` | 否 | Pi 配置不可用，请在 Pi 中完成 /login 和 /model |
| `shuttingDown` | 是 | Runtime closing |
| `internal` | 否 | Invalid table、Invalid field、Invalid runtime lock、Could not acquire runtime lock、Invalid persisted GUI budget、Background model response …（4 条）、Invalid OpenMatter work event、Invalid proactive timeout、Invalid trigger batch cap |
| `overloaded` | 是 | （新增：入站背压） |
| `notInitialized`、`alreadyInitialized`、`cursorExpired`、`threadArchived` | 视情况 | （新增：协议层） |

迁移规则：

- message 统一改为英文。中文文案移到 GUI，按 reason 加上 `details` 渲染（例如 `capacity` 配合 `details.resource = 'inbox'`）。
- 只在 CLI 内部使用的错误（`messages:query` 的用法提示、hidden-entry 的 TTY 检查）不走协议，保持原样。
- **在 pi 层工具里抛出、最终返回给模型的错误不改**：它们是模型可见的工具结果，不是 API 错误。

## 17. 关键时序

### 17.1 用户私聊消息（成功路径）

```
GUI            HTTP/Router        Runtime/Store/EventLog            Pi session
 │ turn/start ──►│ 校验 schema       │                                  │
 │               │ accept() ────────►│ inbox(queued) + turn/queued #101 │
 │◄── {queued} ──│                   │ wake → drain                     │
 │◄─ SSE #101 ───┤                   │ processing → item/completed(in) #102
 │               │                   │ TurnTracker.begin → turn/started #103
 │               │                   │ session.run(e) ─────────────────►│
 │◄─ delta(agentMessage) …（不落盘）─────────────────── send_message 参数流
 │               │                   │◄─ sendMessage() ─────────────────│
 │◄─ SSE #104 ───┤                   │ outbox(pending) → item/completed(agentMessage) #104
 │               │                   │ deliver(): 写入事件日志即视为送达本地频道
 │◄─ SSE #105 ───┤                   │ outbox(delivered) → item/updated #105
 │               │                   │ run 结束 → turn/completed #106
```

本地频道的"送达"定义为 outbox 记录已经提交、对应事件已经进入事件日志：日志是持久的，任何客户端最终都能收到。外部频道（例如 IM 桥）作为投递适配器订阅事件，自行调用 `deliver`；这部分不在本期范围内。

### 17.2 断线续传

```
GUI 收到 #230 后断网 ……  daemon 继续产生 #231..#260
GUI 重连：EventSource 自动带 Last-Event-ID: 230
daemon：#231 ≥ 表中最小 seq → 回放 #231..#260 → 切换到实时推送
（如果 #231 已经被压缩掉 → 发送 cursorExpired → GUI 调用 daemon/snapshot 后，从新 seq 重新订阅）
```

### 17.3 工具审批

```
Pi 调用 start_job(tool=X) → runtime.startJob → job(running) → item/started(job)
→ ApprovalPort.request → RequestBroker 写 requests(pending) → request/created
→ 向声明支持 approval 的连接发送 server→client 请求
GUI 弹出审批 → 用户批准 → 回复 {decision:'approve'}
→ broker 写 resolved → request/resolved → awaitApproval 返回 true → execute()
→ job(completed) → item/completed(job) → 产生 job 类型的 envelope → 新的 turn
```

### 17.4 优雅关闭

```
SIGTERM → daemon: ready → draining（statusChanged）
  新的 turn/start → shuttingDown；request/resolve 正常处理
  等待 runtime.idle() 和 deliver，最长 drainTimeoutMs
→ stopped：关闭 proactive、runtime、trigger，释放锁，删除 daemon.json
  超时仍未结束的 turn/job：留给下次启动时由 recover() 标记为 uncertain（I2）
```

### 17.5 崩溃恢复

```
kill -9 → 重启 → recovering：
  acquireLock 清理已死亡进程的锁 → 执行迁移 → Store.recover()（processing→uncertain 等，同时派生事件）
  → turns 表中处于 running 的记录 → uncertain（turn/completed，error.reason = 'internal'，details.cause = 'daemonRestarted'）
  → approval 类请求 → cancelled
→ ready。客户端重连后按 seq 续传，看到这些修正事件
```

## 18. SDK

### 18.1 API 形态

```ts
const client = await PiBotClient.connect({
  transport: 'auto',                                  // 或 { http: url, token } / { stdio: command } / { inProcess: daemon }
  clientInfo: { name: 'pi-bot-gui', version },
  capabilities: { streamingReplies: true, serverRequests: ['approval', 'question', 'credential'] },
});

const snap = await client.daemon.snapshot();
const store = createDaemonStore(snap);                 // 共享 reducer
client.events.subscribe({ after: snap.seq }, e => store.apply(e));

await client.turn.start({ botId, text, key: crypto.randomUUID() });

client.onRequest('approval', async req => ({ decision: await confirm(req) ? 'approve' : 'deny' }));
client.on('disconnected', ...);                        // 自动重连，并从 store.seq 续传
```

- 命名空间 API（`client.turn.start` 等）由 `registry.ts` 在类型层面推导：params 和 result 类型直接来自 schema，不需要手写。
- 客户端在发送前也会用同一份 schema 校验 params（可以关闭），这样错误能在本地就被发现。
- `PiBotApiError` 带上 `reason`、`retryable`、`details`；`overloaded` 和 `capacity` 默认最多重试 3 次（指数退避加抖动）。

### 18.2 共享 reducer

```ts
type DaemonState = {
  seq: number;
  bots: Record<string, Bot>; groups: Record<string, Group>; threads: Record<string, Thread>;
  turns: Record<string, Turn>; items: Record<string, Item>;          // 按 thread 建索引
  requests: Record<string, PendingRequest>; routines: Record<string, Routine>; jobs: Record<string, JobSummary>;
  streaming: Record<string /* toolCallId */, string>;                // delta 的临时拼接，不参与等价比较
};
function applyEvent(state: DaemonState, e: EventEnvelope): DaemonState;   // 纯函数
```

- 遇到 `e.seq <= state.seq` 的事件直接忽略（去重）。
- 遇到不认识的 method，只推进 seq（向前兼容）。

## 19. GUI 与 CLI

### 19.1 GUI

| 现状 | 改造后 |
|---|---|
| 每秒 `GET /api/state` 拉全量 | `useDaemon()`：一次快照，然后通过 SSE 订阅；状态来自共享 reducer |
| 消息列表来自 `messages` 投影 | 来自 thread 的 items（inputMessage、agentMessage、peerMessage）；群聊视图仍然使用 `group_messages` 投影 |
| 回复整段出现 | agentMessage 流式显示，完成后按 toolCallId 替换为最终文本 |
| 提问、审批、凭据分散在不同位置 | 新增"待处理"面板，统一展示 pending requests |
| 错误显示服务端返回的中文字符串 | 按 reason 映射到中文文案 |
| 运行状态只有"待处理 N" | 显示 thread 状态（已加载/已存储）、当前 turn 状态（排队/运行/已让出）、daemon 状态（ready/draining） |

### 19.2 CLI

`pi-bot chat` 的流程：

1. 用 `transport: 'auto'` 连接。
2. 订阅当前 bot 的事件。
3. 输入一行就调用一次 `turn/start`。
4. 把 agentMessage 打印出来（终端支持时显示流式 delta）。
5. 收到 question 请求时在终端提问；收到 approval 请求时询问 y/n。

替代现在 `cli.ts` 里直接操作 runtime 的实现。

## 20. 配置与默认值

| 配置 | 默认值 | 环境变量 / 参数 |
|---|---|---|
| 数据目录 | `work/gui/demo` | `PI_BOT_DIR` / `--data-dir` |
| HTTP 监听 | `http://127.0.0.1:4317` | `PI_BOT_GUI_PORT` / `--listen` |
| 静态资源目录 | `dist/gui` | `PI_BOT_STATIC_DIR` / `--static` |
| drain 超时 | 30 秒 | `--drain-timeout` |
| 空闲卸载 | 10 分钟 | `idleUnloadMs` |
| 最多加载 thread 数 | 32 | `maxLoadedThreads` |
| 事件保留 | 7 天或 100 万条 | `eventRetention` |
| 入站并发 | 32 / 连接 | — |
| 出站队列 | 1000 条或 8 MiB / 连接 | — |
| 审批超时 | 10 分钟（超时拒绝） | `approvalTimeoutMs` |
| SSE 心跳 | 15 秒 | — |

现有的环境变量（`PI_BOT_WATCH_FILE`、`PI_BOT_PROACTIVE`、`PI_BOT_BACKGROUND_TOOLS`、`PI_BOT_BACKGROUND_WORK`、`PI_BOT_NEW_ROUND`）全部保留，语义不变。

## 21. 实施计划

总原则：

- 每个阶段一个 PR，可以单独合并和回滚。
- 门槛：`npm run check` 通过；`npm test` 除已知的 7 个 Python oracle 测试外全部通过；`test/layers.test.ts` 通过。
- 先补测试、再改实现。I1–I9 的回归测试在 P0 第一步就写好，之后每个阶段都要通过。

### P0 协议地基

| 步骤 | 内容 |
|---|---|
| P0.1 | 不变量回归测试 `test/invariants.test.ts`：I1–I9 各至少一个用例，在当前代码上全部通过 |
| P0.2 | `src/sdk/protocol/*`：version、errors、models、methods（第 14 节全部方法）、notifications、registry |
| P0.3 | `daemon/core/errors.ts` 的 `PiBotError`；按第 16.2 节逐个替换 87 处抛错；测试中按 message 断言的地方改为按 reason 断言 |
| P0.4 | `core/router.ts` 和 `core/connection.ts`（先只做 initialize、请求分发、错误归一；暂不做订阅） |
| P0.5 | `handlers/*`：把 `server.ts` 的 10 个路由改写为第 14 节的方法（bot、group、turn/start、routine、job、request/resolve（先只支持 question）、task/reconcile、daemon/snapshot、daemon/status） |
| P0.6 | 进程内传输（server 端和 client 端）；新的 `PiBotClient`（命名空间 API） |
| P0.7 | `transports/http.ts` 只实现 `POST /rpc`（暂不做 SSE）；GUI 改用新 client，暂时用 `daemon/snapshot` 每秒轮询（在 P1 去掉） |
| P0.8 | 删除 `server.ts` 和旧的 REST 客户端；`daemon-server.test.ts` 改写为 `protocol.test.ts`，走进程内传输 |

P0 测试用例：

- `initialize` 之前的任何请求返回 notInitialized；重复 initialize 返回 alreadyInitialized；版本不兼容时返回支持的版本列表。
- 每个方法：非法 params 返回 invalidParams，并带字段路径。
- 幂等：`turn/start` 用相同 key 调两次，返回同一个 inputId；相同 key 不同文本返回 conflict。
- 错误映射：capacity、notFound、forbidden、taskCancelled 各一个端到端用例。
- `daemon/snapshot` 的结果里不包含 token（回归 I9 的修复）。
- schema 快照：导出的 JSON Schema 和 `test/fixtures/protocol-schema.json` 一致。

### P1 事件日志与实时推送

| 步骤 | 内容 |
|---|---|
| P1.1 | `migrations.ts`（version 1、4）；events 表 |
| P1.2 | `events/derive.ts`（纯函数，按第 5.3 节的映射表实现）及单元测试 |
| P1.3 | `Store.put` 接入 derive，同事务写入；`EventLog.append` 和读取 |
| P1.4 | `turns` 表和 `TurnTracker`；在 `drain` 和 `pump` 中加入第 11.2 节的钩子；AsyncLocalStorage 上下文 |
| P1.5 | `threads` 表（迁移 version 2）；派生 thread 事件 |
| P1.6 | 订阅：回放加实时切换、过滤、watermark、ack、保留期压缩 |
| P1.7 | HTTP 的 SSE（`Last-Event-ID`、心跳）；SDK 的 HttpSseTransport 和自动重连 |
| P1.8 | `sdk/state/reducer.ts`；GUI 的 `useDaemon()`，去掉轮询 |

P1 测试用例：

- **性质测试**：随机生成 200 组操作序列（创建 bot、发消息、job 完成、让出、取消、核对……），对每一组断言 `reduce(snapshot₀, events) == snapshotₙ`（忽略 `streaming` 字段）。
- 事务回滚时不留下事件；同一事务产生的事件 seq 连续。
- 订阅从回放切换到实时的过程中，并发提交的事件不丢失也不重复。
- 断线续传：断开、继续产生事件、重连、seq 连续。
- 重启续传：关闭 daemon 再打开，从旧 seq 续传，事件连续。
- cursorExpired：压缩之后用过期 seq 订阅，客户端回退到快照。
- turn 终态：completed、yielded、interrupted、uncertain、failed 各一个用例，和现有 runtime 测试场景对齐。
- usage：turn 的 usage 汇总等于 Pi assistant message 的 usage 之和。

### P2 生命周期

| 步骤 | 内容 |
|---|---|
| P2.1 | `core/daemon.ts` 状态机；把 `close()` 的逻辑收进 draining |
| P2.2 | `/readyz` 和 `/healthz`；`daemon/shutdown` |
| P2.3 | token 文件和 cookie/CSRF 双提交鉴权；Host 和 Origin 校验 |
| P2.4 | 入站并发限制、出站队列和 lagged 处理 |
| P2.5 | stdio 传输（服务端和客户端） |
| P2.6 | `daemon.json` 发现机制和 `transport: 'auto'`；`src/daemon/main.ts` 和 `pi-bot` 命令；CLI 改为 SDK 客户端 |

P2 测试用例：

- draining 期间：`turn/start` 返回 shuttingDown，`request/resolve` 和读请求成功。
- drain 超时后重启，未完成的 turn 变为 uncertain，不重放。
- 慢消费者：被关闭（lagged），重连后按 seq 补齐。
- 鉴权：没有 token 返回 401；跨源请求返回 403；cookie 没有配合 CSRF 头返回 403。
- stdio：拉起子进程、完成握手、发起一个 turn、收到 completed。
- auto：有 daemon 时附着；`daemon.json` 指向的进程已死亡时清理文件并嵌入；锁被占用但没有 HTTP 时报错。

### P3 Server Request

| 步骤 | 内容 |
|---|---|
| P3.1 | requests 表、`RequestBroker`（创建、发送、解决、超时、取消）；迁移 version 3 |
| P3.2 | `ApprovalPort`；接入上述 3 处权限检查 |
| P3.3 | question：`askUser` 和 `answer` 与 broker 衔接 |
| P3.4 | credential：`request_credential` 与 broker 衔接，提供 `formUrl` |
| P3.5 | GUI 待处理面板；CLI 的终端交互 |

P3 测试用例：

- 首个提交者生效；相同内容重复提交返回原结果；不同内容返回 conflict。
- 两个连接同时在线：A 解决请求后，B 收到 `request/resolved`。
- 重启后 question 和 credential 仍然 pending，approval 变为 cancelled。
- 审批超时被拒绝，对应 job 变为 failed（Permission denied）。
- 任务被取消后，关联请求变为 cancelled（I7）。
- 凭据的秘密值不会出现在任何事件、日志或协议消息里（I8，对整个事件表做全文扫描断言）。

### P4 Thread 管理与流式输出

| 步骤 | 内容 |
|---|---|
| P4.1 | `EventSink` 端口；session-factory 中第 12.1 节的映射 |
| P4.2 | toolCall 和 compaction item；所有 delta 的扇出；capability 过滤 |
| P4.3 | `thread/list`、`read`、`archive`、`unarchive`、`unload` |
| P4.4 | 安全卸载（4 个条件）和 LRU；空闲定时器 |
| P4.5 | GUI 流式显示回复；thread 状态显示 |

P4 测试用例：

- 卸载的 4 个条件各自有一个"阻止卸载"的用例，外加一个"全部满足、成功卸载"的用例。
- 卸载后再次触发：Pi session 从文件恢复，上下文和卸载前一致（比较 Pi 的消息列表）。
- LRU：加载第 33 个 thread 时，最久未活动且满足条件的 thread 被卸载。
- delta 被丢弃（模拟慢连接）不影响 agentMessage 终态。
- 没有声明 debugInternal 的连接收不到 internal delta；reasoning 内容永远不会出现在事件表中。

### P5 收尾

- `npm run protocol:schema` 导出 JSON Schema 到 `dist/protocol/`。
- `docs/protocol.md`：根据 registry 自动生成方法和通知的表格（脚本），避免文档和实现不一致。
- 更新 README 和 `docs/gui.md`。

## 22. 风险与待决问题

### 22.1 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| `Store.put` 中多一次 `get`（取 before）加一次事件写入 | 写入变慢 | WAL 下都是微秒级；P1.3 完成后做基准测试，以现有 181 个测试的耗时为对照，退化超过 15% 时优化（例如调用方直接传入 before） |
| derive 的映射遗漏某种状态变化 | 客户端状态和服务端不一致 | 性质测试兜底：任何遗漏都会让 reduce 等价断言失败 |
| TurnTracker 钩子和 `drain` 的异常路径交织 | turn 状态卡在 running | `drain` 中用 try/finally 保证每次 `begin` 都有 `end`；崩溃时由恢复阶段修正 |
| 安全卸载和并发 wake 竞争 | 违反"只消费一次" | 卸载判断和卸载动作都在 bot 的 lane 内执行，与 `drain` 串行 |
| 87 处抛错替换带来行为差异 | 测试和 GUI 出现回归 | 只替换错误类型，不改抛错的条件；替换脚本输出逐条对照表，供 review |
| 一次性删除 REST 接口 | 外部脚本失效 | 仓库里只有 GUI 和测试是消费方（`scripts/gui-acceptance-snapshot.mjs` 直接读数据库，不受影响） |

### 22.2 待决问题（需要你拍板）

1. **协议版本号格式**：日期（`2026-10-13`，和 MCP 一致）还是 semver。建议用日期。
2. **CLI 是否保留"纯进程内、不起 HTTP"的嵌入模式作为默认**：建议保留，只有显式传 `--listen` 时才监听端口。
3. **事件保留期**：7 天或 100 万条是否合适。
4. **审批超时的默认行为**：拒绝（安全）还是保持 pending（不会打断任务）。建议拒绝。
5. **外部频道投递适配器（IM 桥）**：放进本期还是之后单独做。建议之后做，本期只需保证事件日志足以支撑它。
