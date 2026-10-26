# Pibo

<img src="assets/brand/pibo-approved-source.png" alt="Pibo 珊瑚色 π 标志" width="112" />

Pibo 是基于 Pi 的多 bot 聊天客户端与持久 runtime。每个 bot 有独立身份、inbox 和 Pi session；聊天界面连接 runtime，模型和工具在 runtime 所在电脑上运行。Node.js 24+ 内置 SQLite，无需外部数据库。当前核心依赖固定为 `@earendil-works/pi-coding-agent@1.2.0`。

## 开始使用

从仓库根目录运行，先安装 Node.js 24+：

```sh
npm ci --ignore-scripts
npm run gui
```

打开 http://127.0.0.1:4317/。浏览器开发入口使用本机 runtime；客户端会复用兼容的现有 daemon，或启动所选本地工作区的 daemon。默认 runtime 数据目录为 `work/gui/demo/`，可用 `PI_BOT_DIR` 指定其他目录。真实模型需要通过「Pi 登录与模型」或 Pi 的 `/login`、`/model` 配置认证和模型；模型调用可能产生供应商费用。

只运行 runtime 或 CLI：

```sh
npm run daemon
npm start
```

不要让 client 与 daemon 同时占用默认的 4317 端口；分别运行时可用 `npm run client -- --port 4318` 为客户端选择其他端口。一个数据目录只允许一个本机 runtime owner。

## 客户端与连接

| 客户端 | 当前能力与边界 |
| --- | --- |
| macOS Apple Silicon | Tauri 客户端；本机工作区、Tailscale 或 HTTPS 远程 runtime；提供独立 Preview 打包流程 |
| iOS | Tauri 客户端；仅连接远程 runtime，手机不运行本地 agent；安装需 Apple 签名和分发流程 |
| Android arm64 | 已有 debug 构建与模拟器验证；仅远程 runtime，服务会话凭据仅保留在当前进程内存 |
| 浏览器 / Electron 开发入口 | 本机 runtime；不支持原生客户端的远程直连配置 |
| Windows / Linux / Intel Mac | 尚未完成安装包构建验证 |

原生远程客户端可选择 Tailscale 节点，或输入已有 HTTPS 服务地址，再用 **runtime 服务密码** 登录。Tailscale 网络授权与服务登录是两个步骤；网络可达并不代表服务已授权。内嵌 Tailscale 使用应用自己的节点与 SDK 连接，不接管系统 VPN。HTTPS 验证证书，普通远程 HTTP 被拒绝。

服务密码由 runtime 所有者在服务端本地终端初始化；客户端不再提供 SSH 连接或配对码入口。Apple 客户端将登录后的服务会话保存到与目标绑定的、设备专用 Keychain，密码本身不保存。重开客户端会按已保存连接意图尝试恢复；离线可重试，过期或撤销的会话需要重新登录，显式断开会停止自动恢复。部署远程 runtime、网络监听和 HTTPS 代理需要服务所有者自行配置，启动 GUI 不会配置这些服务。

详见 [服务密码与直连](docs/clients/DIRECT-PASSWORD.md)、[Tailscale 连接](docs/clients/TAILNET-DIRECT.md)。

原生客户端开发与 Preview 打包另需 Rust、Xcode 命令行工具和对应平台 SDK：

```sh
npm --prefix clients/tauri ci
npm --prefix clients/tauri run build:gui
npm --prefix clients/tauri run package:preview
```

Preview 与正式应用的数据隔离；正式签名、公证、TestFlight 分发需要已有平台配置。此处不承诺某个内测版本已可安装，也不把浏览器或模拟器验证等同于真机端到端验证。详见 [Tauri 客户端](clients/tauri/README.md)、[桌面打包](docs/clients/DESKTOP-RELEASE.md)、[iOS 分发准备](docs/clients/IOS-TESTFLIGHT-PREPARATION.md)、[Android 测试包](docs/clients/ANDROID-TEST-BUILD.md)。部分交接文档保留历史阶段记录，当前连接方式以服务密码直连说明为准。

## 聊天与工具

- 创建 bot、单聊与群聊，使用 @ / @全体协作；按 runtime 保存置顶会话。手机采用列表和聊天分页，返回时保留当前渲染器中的草稿与滚动位置。
- 支持多行输入、照片和文件附件、取消选择、移除与下载。单文件最多 8 MiB，PNG/JPEG/WebP 图片最多 5 MiB；附件接收不代表模型已处理，模型图片能力取决于所选 provider。
- 回复完整后显示，运行状态单独呈现。消息提交、处理完成、工具执行和外部投递有不同收据，不能相互替代。
- 桌面工具与实时画面依赖 runtime 侧已配置的桌面服务及授权；客户端本身不自动获得设备控制权限。见 [Linux 桌面与人工接管](docs/linux-desktop-image.md)。
- 定时任务与监控由 **agent 管理**，runtime 保存状态和触发记录；客户端仅展示已有任务状态，不提供手填时间、cron 或监控创建表单。可通过普通聊天向 agent 表达需求，实际能力及启用方式见 [proactive runtime](docs/proactive-runtime.md)。

## 开发与验证

```sh
npm run check
npm run gui:check
npm test
node --import tsx --test test/*.test.mjs
npm run gui:build
npm run demo
```

Demo 使用真实 Pi SDK 和 faux provider，不调用真实模型。测试使用隔离数据与本机进程/端口；受限环境需允许相应的本地测试操作。构建成功不等于原生设备、网络或签名验收。

[GUI 使用说明](docs/gui.md)、[协议](docs/protocol.md)、[Pi 认证与后台 worker](docs/pi-auth-workers.md)、[手机回归](docs/clients/PHONE-REGRESSIONS.md)提供进一步说明。以下保留 runtime 架构、执行语义和恢复边界，便于开发与贡献时核对行为。

## 真实模型 CLI

```sh
# 可在 GUI 的「Pi 登录与模型」配置，或在 Pi 中 /login 和 /model
npm start
```

GUI 与 CLI 读取 Pi 原生 settings.json、models.json、auth.json；凭据解析与 OAuth 刷新由 Pi SDK 负责。不再使用 PI_BOT_PROVIDER / PI_BOT_MODEL，也不自动读取 DSH key。每个 bot 提供基于社区 pi-subagents 0.77.0 的异步 subagent extension，可把重活派给独立的原生 Pi coding session，通过持久 jobs 回传结果。子会话提供 Pi coding tools（包括 shell/文件），不加载第三方扩展、不递归派发，也不能直接回复用户。详见 [Pi 认证与重活派发](docs/pi-auth-workers.md)。

默认共享状态目录 `work/gui/demo/`，用 `PI_BOT_DIR` 更改。每行普通文本发给 main bot；无需等待模型完成即可继续输入：

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

代码按四层组织，依赖只能自上而下（`test/layers.test.ts` 强制检查）：

```
gui ──► sdk ──(type-only)──► pi ◄── daemon ──(type-only)──► sdk
evals ──► 任意层（层外评测工具）
```

| 层 | 目录 | 职责 |
|---|---|---|
| ① 核心 Pi 插件层 | `src/pi/` | `session-factory.ts`（Pi 会话、native tools、extension permission chain）、`context.ts`（后台摘要与原生 compaction）、`background-codemode.ts`、`coding-worker.ts`、`proactive-extension.ts`；`types.ts` 是领域记录，`host.ts` 是宿主端口（`BotHost`/`ProactivePort`/`CredentialPort`/`SessionFactory`）。只依赖 Pi SDK，不引用任何宿主代码 |
| ② daemon 层 | `src/daemon/` | `runtime/`（调度、SQLite、OpenMatter、proactive、credentials）；`core/`、`handlers/`、`events/`、`requests/`、`transports/` 组成 app-server；`main.ts` 负责宿主入口 |
| ③ SDK 层 | `src/sdk/` | `protocol/`（TypeBox JSON-RPC 定义）+ `client.ts`（命名空间 API）、`state/` reducer 和 `transports/`，浏览器/Node 通用，无 `node:` 依赖 |
| ④ GUI 层 | `src/gui/` | React + Radix 前端，只通过 `PiBotClient` 访问 daemon |
| 层外 | `src/evals/` | evaluation、benchmark、`demo.ts`、smoke provider |

常用入口：`npm start`（SDK 附着现有 daemon，没有宿主才嵌入）、`npm run daemon`（app-server）、`npm run gui`（构建 GUI 并启动独立 client，复用或启动 server）。GUI 支持 Pi 原生登录和默认模型选择；定时任务、监控由 agent 按 bot 管理，GUI 只读展示状态。GUI/CLI 的正常操作只走协议。

实现、迁移、36 次真实 API 调用及验证边界见 [app-server 交接](docs/design/app-server-implementation-20261014.md)。协议表见 [docs/protocol.md](docs/protocol.md)。

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

改状态工具（`send_message`、`schedule_cancel`、`monitor_enable`、`monitor_cancel`）按 Agent 已读版本条件提交，冲突时零副作用并返回结构化结果；保护矩阵与未覆盖项见 [Agent 状态保护](docs/state-protection.md)。

Linux 桌面、共享浏览器 profile、Computer 实时画面与人工接管，见 [运行及验收说明](docs/linux-desktop-image.md)。

Real flood, natural-language correction/cancellation and concurrent background compaction acceptance: [2026-10-14 report](docs/real-flood-compaction-20261014.md).

## 官方 Pi bash 沙箱

真实 daemon 默认加载 Pi 官方 sandbox 示例扩展，覆盖后台 bash 和 coding worker 的 bash；不改变原生 Pi 登录与模型设置。
它不覆盖所有工具，且保留上游初始化失败时退回普通 bash 的行为。安装、配置、日志确认与限制见 [沙箱说明](docs/sandbox.md)。

## 许可证与贡献

项目使用 [MIT 许可证](LICENSE)。贡献前请运行上面的检查与测试，并说明改动影响、验证方法和未覆盖边界；客户端、SDK 与 runtime 的依赖方向需遵守本文的分层约束。
