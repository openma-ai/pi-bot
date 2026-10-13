# pi-bot v0.2

从空仓库实现的 **Pi 原生、多 bot、持久 inbox/outbox runtime**。不是另造一套 agent SDK，也不是把主 agent 换成永远等待的后台任务。

核心依赖固定到 `@earendil-works/pi-coding-agent@1.1.0`。模型、工具 schema、extension hooks、工具权限链与会话文件复用 Pi。Node.js 24+（内置 SQLite），不需要外部数据库。

## 本地 GUI

`npm run gui` 后访问 http://127.0.0.1:4317/。React + Radix Themes，连接真实 Pi、现有 bot 与消息记录，支持群聊 @ / @全体、bot 间协作和 schedule / monitor 管理。触发交接复用固定源码的 OpenMatter DurableInbox；Pi 仍负责工具和模型执行。参见 [GUI 使用说明](docs/gui.md) 和 [当前交接、验收与边界](docs/gui-openmatter-handoff-20261013.md)。

## 快速验证（无需 API key）

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run demo
```

Demo 使用真实 Pi SDK + faux provider，并实际执行安全延迟工具：先拿 job receipt，继续回复、提出异步问题，接收后台完成事件，再接收关联答案。不会调用外部服务、shell 或真实模型。

## 真实模型 CLI

```sh
# 先在 Pi 中 /login 完成认证，并用 /model 选择默认模型
npm start
```

GUI 与 CLI 读取 Pi 原生 settings.json、models.json、auth.json；凭据解析与 OAuth 刷新由 Pi SDK 负责。不再使用 PI_BOT_PROVIDER / PI_BOT_MODEL，也不自动读取 DSH key。每个 bot 提供基于社区 pi-subagents 0.77.0 的异步 subagent extension，可把重活派给独立的原生 Pi coding session，通过持久 jobs 回传结果。子会话提供 Pi coding tools（包括 shell/文件），不加载第三方扩展、不递归派发，也不能直接回复用户。详见 [Pi 认证与重活派发](docs/pi-auth-workers.md)。

默认状态目录 `.pi-bot/`，用 `PI_BOT_DIR` 更改。每行普通文本发给 main bot；无需等待模型完成即可继续输入：

- `/bots`：列出 bot
- `/new 名称`：创建独立 bot
- `/to BOT_ID 内容`：发给指定 bot
- `/answer QUESTION_ID 内容`：回答异步问题
- `/reconcile INBOX_ID DELIVERED_OUTBOX_ID`：用已确认的同源投递证据收敛 uncertain inbox
- `/state`：查看 main bot 的待处理状态
- `/quit`：等待现有运行与 job 完成后退出

CLI 的 outbox sink 仅输出本地 stdout；`delivered` 只表示该 sink 成功返回，不表示用户已经读到、更不表示任何 Slack/邮件服务投递成功。真实远端 adapter 需单独实现并获得授权。

## 两条硬约束

### 1. 用户抢占采样，工具和后台工作保留

每个 bot 只有一条模型执行 lane，不同 bot 可并行。新消息先提交 SQLite。host user/answer 默认 preempt：只取消当前 provider 请求，丢弃过时采样，保留已启动工具、job/cell 和后台摘要。普通 peer queue 到整 run 结束；direct priority=true 只在非 user lane 使用 steer，在下一次 LLM call 前插入，不取消当前 call。user lane 保护，group 广播忽略 priority；继承群上下文的 direct 仍是 direct。`preemptInference: false` 可关闭用户推理抢占。忽略取消信号的 provider 必须结束后才能继续，保持单 bot 单前台请求。

准入消息归入 active wake batch；仅有 ledger 中的 ID 不算真实输入消费。成功 native final 步骤保存检查点，后续请求失败不撤销它；未决消息仍为 uncertain。`processed` 不证明用户任务完成，实际工具效果与 send_message 另行验收。多任务路由工具必须明确 source_message_id；宿主验证自身来源及继承分支，不能把最近闲聊作为旧任务来源。

### 2. 前台绝不等待摘要，包括 overflow

- Settings 与 session API 双重关闭原生 auto compaction，禁用 threshold 和 overflow compact/retry。
- 到达软阈值后，默认用同一 ModelRuntime/model 发起独立、无工具的后台摘要请求。前台从不 await 它，也不因新输入 abort。
- 摘要未就绪、失败或超时期间，继续使用完整的当前 Pi 原生上下文；不按请求裁剪历史，不替换大工具结果、不建立第二份投影会话。
- 摘要只覆盖不可变的稳定旧前缀；保留最近完整消息和工具配对。只有到 turn_end/agent_before_settle 边界，且 session、epoch、entry ID 和前缀指纹仍匹配时，才返回 Pi 原生 compaction entry。等待期间追加的所有 tail 消息原样保留。
- 原生 compaction 写入 Pi JSONL 并重建上下文；重启直接恢复，原始历史仍能通过 context_history 分页读取。大工具结果仍由 job_result 分页读取。
- 每次请求仅追加小型权威 jobs/questions/inbox ledger；system/tool schema、ledger 和输出保留量计入硬预算。若摘要应用前完整上下文已经超限，该 wake 明确失败并保留历史，绝不等待摘要或偷偷裁剪。
- 默认输入预算为 model.contextWindow - 4096（无 model 时回退 32000 - 4096），可用 maxContextTokens 设置更小上限；软阈值为这个保守估算预算的 60%，并非 provider 实际 token 占用率。context 可配置 maxContextTokens/outputReserveTokens/thresholdTokens/recentMessages，或注入 summarize。计数为保守 UTF-8/JSON 估算，不是 provider tokenizer；图片需专用预算支持。
- 每个 bot 仅一个后台摘要任务；默认 30 秒超时、失败后至少 30 秒冷却，同一前缀最多 3 次尝试。忽略 abort 的适配器未结束前不会启动更多摘要。晚于 idle 才完成的摘要在下一个原生边界采用，不另开前台模型请求。

手动 compact 不对外暴露；extension 的 `session_before_compact` 防止默认摘要，但原生 `session.compact()` 在该 hook 前已经会 abort。因此第三方代码直接调用该 API 的行为不在本 runtime 的保证内。

## 原生工具

| 工具 | 语义 |
|---|---|
| `create_bot` / `list_bots` | 持久身份、独立 inbox、独立 Pi session |
| `send_to_bot` | 提交对方 inbox，立即返回 message ID；不等待对方 |
| `send_message` | 提交用户 outbox；和 bot 间消息严格分开 |
| `ask_user` | 立即返回 question ID；回答经 host `answer()` 成为新事件 |
| `start_job` | allowlist 内工具经 Pi `ctx.executeTool` 原生链后台执行 |
| `job_result` | 指定 job 的有界分页，只能读取本 bot 的结果 |
| `runtime_state` | 权威 pending/uncertain 状态与总数 |
| `context_history` | 本 bot 的持久历史分页 |

job receipt、执行完成、inbox processing、外部投递是不同状态。没有任何 exactly-once 承诺。模型工具不能伪造 sender ID 或指定任意用户消息目的地。bot/job 文本始终是非用户授权的数据。`ask_user` 不是工具权限批准机制。

## 结构与扩展

- `src/store.ts`：SQLite WAL + FULL sync；bot、inbox、job、question、outbox
- `src/runtime.ts`：调度、关联 ID、幂等键、预算、恢复、sink
- `src/pi.ts`：Pi 会话、native tools、extension permission chain
- `src/context.ts`：阈值触发的后台摘要与 Pi 原生 compaction
- `src/cli.ts`：持久交互 host
- `src/demo.ts`、`test/`：无需 key 的真实 SDK 验证

`piSessionFactory({ modelRuntime, model, dir, tools, allowTools, extensions, context })` 是扩展入口。传入可信 Pi `ToolDefinition`/`ExtensionFactory`，不绕开其 `tool_call` 拒绝 hooks。普通耗时工具对模型隐藏；唯一入口是 `start_job`。`BotRuntime` 的 host `permission` callback 可额外做授权判断。底层 tool 会收到 Pi 原生 parent tool-call 关联。

第三方 extensions 是可信进程代码，不是安全沙箱；它们可以自己网络调用、abort、修改 session。不要把不可信插件放进 allowlist，不要把模型给出的“用户同意了”当 host 授权。

## 持久化与恢复边界

- bot ID 与 Pi session ID 分离，重启复用会话文件
- inbox 提交后才回 receipt；同 sender + key 幂等，参数冲突拒绝
- job/question/outbox 使用 bot + key 幂等
- 启动恢复 queued inbox；已检查点完成的 processing inbox 保留 processed，其余 processing inbox、running job、sending outbox 改为 uncertain，不盲目重放副作用
- job generation/owner 防止晚到执行覆盖新状态；消息及状态变更与 inbox/outbox 同事务写入只读 GUI 投影
- SQLite 和 Pi JSONL 没有跨文件原子事务；断电时 transcript 与收据可能只提交了一边，uncertain 表示需人工核对
- 每个数据库只允许一个本机 host：PID 文件锁拒绝活进程，清理明确死亡 PID；不是跨机器/NFS 锁
- 历史/结果保留在磁盘；没有自动删除或压缩归档策略，生产使用应添加保留策略与磁盘配额。原生 compaction 缩小活跃模型上下文，不逐请求裁剪；Pi session 仍保留并加载完整会话归档，因此不承诺无限长运行的总内存恒定

默认限制：16 bots、8 并发 jobs、每个任务最多 32 jobs/32 bot 消息计数门槛、8 跳、64 outbox 消息、每 bot 100 queued 消息、16 pending questions、每个 wake 16 次模型请求。请求预算或 context 超限会明确终止该 wake 并标记 uncertain；它们不是由新输入触发的 preempt。长期挂起的可信工具不会堵住用户模型 lane，但优雅 shutdown 会等待它；强制结束后其结果不确定，重启不会重跑。

上下文预算是保守 UTF-8 字节估算，不是 provider 精确 tokenizer。真实 provider 仍可能拒绝请求；此时记录错误并停止，绝不同步摘要重试。已存储的异步 job 大结果仍通过 job_result 分页读取；不会逐请求替换已有原生历史，也不保证任意大的历史都能在后台摘要就绪前装入模型窗口。

## 尚未声称完成

这是可运行的本地 headless baseline，不是生产级 SaaS：当前没有 job cancellation API，也没有真实 Slack/邮件 adapter、分布式租约、自动安全重放、人类审批 UI、磁盘保留/配额管理或插件隔离。native `final` 文本保存在 Pi session；用户可见发送必须显式用 `send_message`，避免把模型内部工作文本当作已投递消息。

## 本机行为评估与隐藏凭据输入

`npm run evaluate -- --dry-run` 显示三个场景和受限真实模型计划，不调用 API。
`npm run evaluate -- --report docs/scripted-evaluation-result.json` 运行定时交错消息、
真实隔离模拟频道、工具结果与路由判定；provider 决策为明确标注的脚本。
`npm run credential-entry` 提供本地 TTY 隐藏输入并立即删除，不发起模型请求。
历史初始计划见 [行为评估](docs/behavior-evaluation.md)；实际真实 API 结果、现行有界 CLI 及限制见
[后续评估](docs/behavior-followup-20261013.md)。凭据走明确配置的本机入口，不进入模型或报告；
[凭据入口](docs/credential-form.md) 说明通用 broker 边界。

## 定时、监控、后台工作与 GUI 查询

`PI_BOT_PROACTIVE=1 npm start` 启用持久 runonce/interval schedule 和监控工具。
`PI_BOT_WATCH_FILE` 可注册只读文件元数据 detector；dry-run 成功后才能 enable。
`PI_BOT_BACKGROUND_WORK=1` 另行启用本地证据研究/记忆候选及独立模型审核，默认不启用。
定时 fire 去重、misfire/overlap、取消晚到结果和版本校验均由宿主保存；不是 cloud cron 或联网研究服务。

`npm run benchmark:proactive -- --output NEW_DIRECTORY` 校准四 bot、两群混合负载；
使用原生 Pi 路径和实际工具/文件，模型决策为脚本，不能当真实 API 速度。
`npm --silent run messages:query -- --db DATABASE --channel CHANNEL` 输出只读分页 JSON；
`--changes --after CURSOR` 查询消息状态增量。也提供 `ChannelMessageReader` 给 Node/Electron GUI。
默认不监听网络端口。详细 API、策略、测试与 Pi Durable/1.2 兼容性评估见
[proactive runtime](docs/proactive-runtime.md)。
