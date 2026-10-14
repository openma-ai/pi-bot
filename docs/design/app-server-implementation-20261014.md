# App-server 实现与验收交接

当前命名 Runtime 设置、SSH 原生部署与可选一体镜像见 [Runtime 连接指南](runtime-connections.md)。以下保留历史验收。
2026-10-14。实现依据 [daemon-app-server 提案 v2](daemon-app-server.md)。远程 main 的分层与设计提交已合并到 local-behavior，本地合并提交为 b06e682；保留既有 bot、群聊、消息、原生 Pi sessions 和 Linux 桌面功能。

## 已实现

- daemon 是运行时与 SQLite 的唯一写入宿主。GUI 和交互 CLI 使用同一 SDK：JSON-RPC 2.0、initialize/initialized 握手、TypeBox 参数及结果校验、结构化错误。协议位于 src/sdk/protocol，运行时移到 src/daemon/runtime；旧 REST server 已删除。
- in-process、HTTP RPC + SSE、stdio JSONL 三种传输。CLI 根据 daemon.json 附着到已有进程；没有已运行宿主才嵌入。只读取证命令 messages:query 归入 evals，显式读取指定数据库，不能驱动运行时。
- 状态写入与事件在同一事务提交；全局 seq、历史回放、过滤水位、ACK、cursorExpired、慢连接保护、重启重新认证与续传。GUI 先取一次 snapshot，再应用事件，不轮询完整状态。保留 7 天或 100 万事件，受近期 ACK 保护。
- thread/turn/item 持久生命周期，原生工具、send_message、usage 和后台 compaction 的观测。普通 assistant final 不作为用户回复；reasoning 文本不进入事件。只有声明 debugInternal 的连接收到内部文本片段。回复预览按 thread 隔离，失效源不产生新预览，结束或让出的 turn 清除未完成预览。
- thread 安全卸载检查 active turn、运行中 job、待处理输入和 pending request；归档阻止新输入。默认最多 32 个 loaded thread，空闲 10 分钟卸载；原生 session 从原文件恢复。
- question、可选 approval、credential 请求持久化，恢复、首次决定获胜、超时与取消。secret 只能经独立直连表单提交，不经 JSON-RPC、事件或聊天。默认不额外启用审批；daemon --approval-required 可启用。
- 生命周期包含 ready/draining/stopped，停止新工作、最长 30 秒排空、超时保留 uncertain，绝不自动重放副作用。回环监听、Host/Origin 检查、0600 token/discovery、HttpOnly SameSite cookie、CSRF；snapshot 没有访问 token。
- GUI 使用既有 React + Radix Themes。原生 Pi 登录、默认模型及思考强度选择；每个定时任务和监控持有 botId，列表按选择的 bot 过滤，创建表单独立保存负责 bot 与回复范围。

## Pi 登录与配置

GUI 的「Pi 登录与模型」调用 Pi ModelRuntime.login/logout 与 SettingsManager，不重写 OAuth，也不引入自己的模型/认证环境变量。支持原生 provider 提供的 API key、OAuth URL、device code、选项和 manual code 流程；只有已保存认证的类型/存在状态对外可见。登录限一个活动流程、10 分钟，关闭会取消。输入值只经 /pi/login/:id/input 私有表单通道，原生 auth.json 管理存储及刷新。

默认模型保存后，在运行时完全空闲、没有 pending request 时关闭缓存会话并替换 factory；工作未结束则延后应用，保留原始 inbox、路由和 session 文件。项目 .pi/settings.json 若覆盖默认模型，GUI 明确拒绝冲突，不偷偷删除项目配置。原生 Pi 模型目录决定可选模型。

这次按用户明确授权读取已有 DSH key，通过 Pi 原生登录保存到本机 Pi。该步骤只用于本次本地配置，不是产品运行时的 DSH 回退。没有读取 Terminal 凭据、把 key 写入代码、聊天、报告、环境变量或镜像。

实际请求使用 deepseek-v4-flash、官方 api.deepseek.com、thinking enabled、effort high、最多 16,384 输出 token（含 reasoning）。[官方文档](https://api-docs.deepseek.com/quick_start/pricing/)说明旧别名由 V4.1 Flash 服务。本机原生 models.json 登记该别名，GUI 也可选择原生目录的 deepseek-flash。

## 本轮验收结果

离线 **220 项测试**，包含所有 Python executable oracle；类型检查、GUI 构建、协议 schema 快照、分层、不变量、HTTP/SSE/stdio、原生 Pi context reload、审批/问题/凭据、安全卸载、LRU、回复预览、预算拒绝均覆盖。具体最终通过数量以 work/gui/app-server-full-tests.log 为准。21st 对变更 GUI 的最终检查无发现。

真实 API 与离线测试分开计数。真实功能验收共 6 个场景、7 个预期用户回复，7/7 送达；最终验收轨迹没有遗漏、重复、错群或额外确认回复：

| 场景 | 独立证据 | 请求数 |
|---|---|---:|
| GUI 发任务；123 × 456 写入并读回 | 原生 bash、文件值 56088、send_message 单条送达 | 3 |
| 卸载 + daemon 重启后的原生上下文恢复 | 新消息不提供旧文件路径；Pi 找到旧文件并只读核对，文件 SHA-256 不变 | 3 |
| bot 绑定的定时触发 | schedule fire → 对应 bot inbox → 单条 send_message | 与下两项合计 8 |
| bot 绑定的文件监控 | dry-run 不提交 cursor；静默检查 0 模型请求，真实文件变化唤醒一次 | 同上 |
| 群聊 @全体成员 | 同一公共消息，每个成员一份 inbox，两个 bot 在同一群各回复一次 | 同上 |
| bot2bot 文件交接复测 | B 用 bash 写入并读回 73，两个 peer inbox，A 最终回复；B 不直接回复用户 | 8 |

上述成功验收共 22 请求；连同诊断轮与有界复测，共 **36 个付费 provider 请求/36 个带 usage 的原生响应**。总计未缓存输入 143,732、缓存读取 144,128、输出 8,795 token；输出包含 3,511 reasoning token，合计 296,655。Pi 目录固定价格估算 **$0.054538368**，是保守估算，不是账单；实际时段价格可能更低。

用户随后取消总量限制。正常 GUI 不再限制累计请求、输入预留、费用或一小时寿命，也不读取旧 gui-budget.json；保留单请求 10 分钟、每个 wake/worker 最多 16 次请求、任务消息/跳数、去重与失效检查。显式 smoke evaluator 单独使用有限请求数与超时，不限制输入 token 或费用。上述 384k 等数字只描述已完成的历史轮次。

### 保留的诊断及修复

1. 初版验收脚本在定时任务仍执行最终模型步骤时开始检查 monitor，把前一任务的后续请求误判为静默 monitor 请求。修复为先等待整个运行时空闲；回放证明没有 monitor inbox。原失败报告仍保留，最终计费从排空后的预算文件和原生 response usage 重新核对：该诊断轮是 4 请求，不能用排空前报告的 3 请求。
2. 第一次 peer 文件任务已完成并送达，但繁复 codemode 记录使后续 completion notice 超出 384k 保守预留；一条通知保留 uncertain，没有重跑文件。原生适配器曾把 host 预算拒绝掩盖成 provider error，现用独立 ProviderRequestGuardError 保留 budgetExhausted。复测明确使用直接原生工具，8 请求完成完整链路，0 runtime error。旧诊断库与 uncertain 记录保留，不自动删除或重放。
3. 实际 GUI 复现 Return control 后仍显示接管：桌面后端释放租约返回 null，新协议只允许 object。已修正结果 schema 为 lease | null，增加 SDK 回归，控制切换期间禁用按钮，并展示错误；实际 GUI 再验收 take/return 已通过，归还后显示 Watching，租约释放。
4. 慢 SSE 写入未被接受时，队列曾提前移除帧；现只有接受后出队。Last-Event-ID 回放也沿用订阅过滤，不能混入别的 bot/thread。
5. 过时/让出 turn 的未完成回复预览曾残留；已按 turn 清除，并在原生预览发出前验证 source 的任务仍有效。

真实 API 报告与脱敏 inbox、工具、send_message、turn/event 轨迹保存在忽略的 work/gui/app-server-evidence/：gui-real-resume-report.json、real-20261014-r2/report.json、real-20261014-peer-r2/report.json、acceptance-summary.json。历史诊断在 real-20261014 与 real-20261014-peer；成本核对使用排空后的只读 SQLite 与原生 session usage 元数据，不导出 reasoning 文本或凭据。raw 原生 session 仍由 Pi 保管。

### 用户取消总量限制后的追加验收

正常 GUI 保留的旧 gui-budget.json 已过期，仍成功完成新的真实 Pi 只读任务：原生 bash 读取历史文件 56088，单条 send_message 送达，turn completed、error=null。GUI 不再显示请求余额或费用，证据为 gui-no-cap-report.json。

社区 pi-subagents@0.77.0 真实复测：父 bot 只派发一次 subagent；独立 worker 用 bash 计算 31×17、写入并 read 核对 JSON value=527，仅在 workers 目录保存一份文件。只有一个已完成 pi-coding-agent job、一个父 bot 用户回复，无失败任务、重复或错群；worker 的原生 session 文件也已核对。

第一次 worker 验收出现额外的父目录复制和 codemode 绕用；现明确原生 worker 工作目录与保存语义，复测任务限定父 bot 直接调用 subagent/job_result/send_message。测试脚本曾误把只含元数据的 jobs 列表当成完整 result；两份原失败报告保留。复测的最终判定通过只读数据库、真实 worker session 和文件重新核对，不再次执行副作用，见 real-worker-20261014-r2/verified-report.json；脚本现在从单条 job 读取完整 result。上述追加的两个场景使最终成功功能场景为 **8 项、9/9 预期用户回复**；前表与历史费用数字保留为追加验收前的记录。

## Linux 镜像及桌面

GUI/Pi app-server 在本机，Linux desktop 服务在 Docker，保留共享 Chromium profile、bot → window → screen、noVNC/WebSocket、Watching/Take over/Return control。不增加 SSH、本机 macOS computer use 或公网部署。

干净镜像构建下载 computer-use-linux v0.7.16 二进制遇到 Docker 网络 ECONNREFUSED。核对 dependencies/devDependencies 与既有已验收镜像完全相同后，从本地基础镜像 b87f78393498… 重打应用层，保留独立数据卷、不挂源码。最终镜像身份见 work/gui/desktop/app-server-image.json；这不是成功的全新依赖下载构建。

真实容器的 7 项检查通过：共享 profile、focus 隔离、原生点击、拒绝别人的窗口、拒绝跨屏坐标、人工接管及恢复、两屏像素不同。该工具测试的 dispatch broker 使用 faux provider，真实 Linux/Chromium/插件效果不是模拟；真实模型读取桌面截图的视觉能力未验收。

## 复现

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run protocol:schema
npm run gui                    # http://127.0.0.1:4317
npm start                      # SDK 附着已有 daemon
npm run pi-bot -- status
npm run pi-bot -- daemon --listen stdio --data-dir work/stdio-run
```

GUI 内原生 Pi 登录并选择默认模型，选择 bot 发任务；「定时任务」「监控」按 bot 查看/创建/管理。凭据只填登录表单或 credential form，不能发到聊天。

以下命令会实际计费，必须显式 --real；使用新的工作目录，已有数据库不会被再次驱动。三个场景组分别是有限轮次，使用每轮的请求数与超时保护：

```sh
npm run smoke:app-server -- --real --data-dir work/acceptance-proactive
npm run smoke:app-server -- --real --peers --data-dir work/acceptance-peer
npm run smoke:app-server -- --real --workers --data-dir work/acceptance-worker
```

GUI 读回复现：发送计算/写入/读取任务，核查 bash item 和单条送达结果；在详情卸载线程，重启 daemon，再让同一 bot 根据保留上下文找回旧文件并只读核对。不得靠 DONE 文本或文件存在单独判定通过。

## 实现取舍与未验收边界

- 真实 API 是功能 smoke，不是完整消息洪流、TaskChain/MARBLE、多 agent benchmark 或吞吐/延迟成绩；自然语言取消/改口在消息洪流中的完整新评估未做。本轮真实调用关闭后台摘要，不能证明真实并发压缩效果；离线后台压缩回归单独保留。
- 原生 OAuth 桥做了离线 URL/选项/manual code/取消测试，没有真实账号 OAuth 验收。
- 实际 sessionFiles 使用 scope 的 SHA-256 前 24 位；迁移从权威 inbox route 推导 thread，保留不能匹配的旧文件，绝不把 hash 当路由 JSON。迁移版本到 4；历史 items 物化方便分页，不伪造历史事件。
- server core 不依赖 SDK client。仅 daemon/transports/auto.ts 作为宿主 CLI 入口适配器例外，分层测试限定这一处；核心、handlers、events、requests 不得反向依赖它。
- 单用户回环服务；没有公开 listener、多租户认证、远程 SSH 或完整 VPS 打包部署。事件回放当前一次读取范围，尚未做百万条场景的分页性能验收。
- 代码与文档本地提交；不 push、merge 远程 PR 或部署。


2026-10-14 续测与修复：上述限额、关闭摘要和未验收说明属于历史轮次。最新真实消息洪流、自然语言改口/取消、运行中取消及后台压缩并发验收，见 [真实并发验收](../real-flood-compaction-20261014.md)。普通 GUI 已启用后台摘要；旧失败未改写成通过。
