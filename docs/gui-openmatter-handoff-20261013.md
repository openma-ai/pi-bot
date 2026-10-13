# GUI / OpenMatter 交接（2026-10-13）

## 最终实现

React + Radix Themes 的本地聊天 GUI，连接真实 Pi 1.1.0。保留原 bot、SQLite 消息记录、任务和原生会话文件。左侧直接进入定时任务、监控、Bot 对话；可在 GUI 发任务、看 send_message 结果、创建群聊、创建/暂停/恢复/取消 schedule 与 monitor。没有演示回复兜底，没有升级 Pi 1.2。

群聊维护一份公共消息记录，并为每个成员创建独立 inbox 收件。普通消息所有成员可见；@成员提高该成员的处理优先级；@全体成员提高所有成员的优先级。它们不是可见性过滤器。引用、代码块和邮件形式的 @ 不触发提及。Bot 间直接消息单独展示，不泄露到公共群聊。群聊广播仍只给本群成员。

每个 bot 的私聊、群聊和线程使用独立原生 Pi 会话文件；同一 bot 仍只有一个前台执行通道。新的直接用户任务或被提及任务可以让其他会话的推理让出执行权，旧承诺排队恢复；已经启动的工具和独立 jobs 不被取消。普通 peer 消息排队；直接 urgent peer 只在非用户回合 steer，不中止推理；群 peer 的 urgent 不升级。

## OpenMatter 的真实复用边界

上游仓库：https://github.com/openma-ai/OpenMatter

固定提交：`a5181d3f11d52f60c76aca1ab3e0665193b751df`。

实际复用 Core WorkEvent schema、DurableInbox 合约、SQLite inbox 实现；对应源文件在 `vendor/openmatter/`，原始 SHA256 和仅修改导入路径的说明在 PROVENANCE.json。未发布 npm 包，因此使用固定源码及 lockfile 的 Effect 依赖。不是把聊天记录直接交给模型，也不是替换为 DSH agent，更没有声称采用整个 OpenMatter Loop/Reaction 内核。

`src/openmatter-trigger.ts` 发布稳定事件 ID，调用真实 SQLite 去重、租约和 fenced handoff；再唤醒已经持久化的 Pi inbox。`completed` 仅代表成功交接，任务完成仍由原生 inbox、工具和 send_message 证明。GUI 与普通 CLI 均接入此边界。

OpenMatter DB 与 Pi DB 不共享一个事务。意图先持久化，若交接发现原生消息不存在，会保留事件、停止自动重试，等待宿主核查；不会虚构原始任务。重启按原生队列恢复，执行中但无证据的记录保持 uncertain。GUI 只自动核对确切的已送达结果，或重新入队有明确“尚未启动”证据的原始消息；不盲目重放。

## 验证与证据

最终完整离线测试：**162/162 通过**，TypeScript 检查与 GUI 构建通过。离线测试包括真实 Pi SDK + faux provider；它们不是 DeepSeek API 成绩。

真实 GUI 验收使用官方 `deepseek-v4-flash`，thinking high；每请求最多 16,384 输出 token（含 reasoning）、10 分钟、零自动重试。每轮最多 32 请求、384,000 输入预留、60 分钟。美元上限已按用户要求取消，其他保护仍保留。已有 DSH 凭据仅由宿主读取到内存，没有放入 GUI、轨迹、报告或代码。

OpenMatter 三轮有限真实 API：

| 轮次 | 请求预留数 | 输入预留 | 验收内容 |
| --- | ---: | ---: | --- |
| 1 | 9 | 285450 | 单成员 @、@全体；诊断多余只读工具调用 |
| 2 | 15 | 321736 | 修正后的 @全体、闲聊静默、另一群隔离、schedule、monitor、历史任务恢复 |
| 3 | 8 | 218547 | bot→bot 交接、真实 bash 文件写入/读回、peer 回传、唯一最终回复 |

这里请求数是宿主可验证的预留计数，不能冒充账单请求数。第三轮另有 8 条带正 token usage 的原生模型回复：input 25,705，cacheRead 31,104，output 1,795（其中 reasoning 793），total 58,604；配置价格估计 $0.0191967，不是账单。前两轮快照的 usage 是整个保留工作区累计值，不能相减或用重叠的 60 分钟窗口冒充每轮费用。原生 usage 可继续审计。

验收中的有效产物均完成：单 @ 回复 `OM-NAMED-64=64`；@全体各成员一条 `OM-ALL-FIX`；`OM-QUIET` 两成员收件但零回复；另一群唯一 `OM-ISOLATED-99=99`；定时 `OM-SCHEDULE-LIVE=OK`；文件变化 `OM-MONITOR-LIVE=OK`。最终协作由工作助手 send_to_bot 交给不是，后者真实 bash 计算并写/读 `om-peer-result.txt`（内容 `31+42=73`），send_to_bot 返回，再由工作助手唯一 send_message `OM-PEER-73=73`。没有观察到遗漏、重复、错群、过时用户动作或本轮引擎错误。最终 trigger 队列为空且未 halted。

这些是小规模 smoke，不能推广为完整消息洪流 benchmark 成绩、吞吐/延迟指标或全部自然语言任务成功率。取消与改口的本轮实现验证主要来自离线回归和已有真实评估资料，不声称第三轮新增真实取消测试。真实压缩后台关闭，因此不证明真实压缩效果。

脱敏本地证据（均在忽略的 work/，不提交用户聊天记录）：

- `work/gui/openmatter-round-{1,2,3}.json`：每轮队列、消息、结果、预算快照。
- `work/gui/demo/tools.jsonl`：原生工具调用/返回轨迹。
- `work/gui/demo/runtime.db`：真实 Pi inbox/outbox/jobs、公共群消息。
- `work/gui/demo/triggers.db`：上游 SDK 事件、去重与租约状态。
- `work/gui/demo/sessions/`：原生 Pi 会话及真实文件产物。内部 reasoning 不在 GUI 展示。
- `work/gui/real-validation.json` 与 `collaboration-before-trigger-refactor.json`：较早真实验收，不能替代本次 OpenMatter 成绩。
- `work/gui/final-tests.log`：最终完整离线结果。

## 定位并修复的问题

1. 跨会话让出后，旧任务的恢复消息反过来中断新任务，造成往返循环。恢复消息标记 deferredContinuation，不能再次抢占新任务；原生 Pi 测试验证两个隔离会话最终完成，独立工具只执行一次。
2. bot 名称“不是”容易造成模型身份歧义和多余查找。每条原生 inbox 注入权威 recipientBot 身份；修正后新群 @全体复测只有 send_message。新上下文复测通过，不宣称这是完全同条件的统计实验。
3. 既有预算耗尽造成历史 uncertain：已有确切结果的任务只补处理状态，不重复发送；尚未消耗、无工具/结果的任务按原 ID 恢复，真实模型回答名字。
4. 并行离线运行的背景超时测试用 5ms 墙钟不稳定，改用可控计时器；取消任务的完成 oracle 原本错误要求模型读取已经取消的工具结果，改为取消路径检查工具存活和过时产物被阻止，正常路径仍必须完整读取。保留失败日志，不回写旧报告。

## 复现与继续工作

Node 24+：`npm ci --ignore-scripts`、`npm run check`、`npm test`、`npm run gui`，访问 http://127.0.0.1:4317/。必须先检查现有监听进程与 DB 锁，不能重复启动。

默认目录 `work/gui/demo` 仅沿用旧目录名保留现有 bot。可以用 PI_BOT_DIR 指定另一个未被进程占用的目录。普通重启保留预算；确实需要新有限轮次时，显式使用 `PI_BOT_NEW_ROUND=1 npm run gui`，没有自动重置。

在 GUI 的 Bot 对话选工作助手、不是、直接协作，提交上面的 OM-PEER-73 文件任务。群聊通过输入框 @建议选择成员/全体；schedule 与 monitor 从左侧页面管理。验收 monitor 已取消，保留记录，防止继续模型调用。

`node scripts/gui-acceptance-snapshot.mjs [输出路径]` 可保存当前脱敏状态、正 usage、文件读回及 trigger 分类计数；它不发任务，也不输出 GUI 写令牌。roundUsage 的时间窗口仅适用于明确独立开始的本轮，重叠轮次应按实际边界审计。

尚未提供日历 cron/RRULE/DST 循环、系统级常驻守护或睡眠唤醒。monitor 当前是仓库内只读文件元数据变化检测，有限 deadline、静默基线和 dry-run；不是通用 GitHub 网络监控。GUI 每秒轮询，不是分页消息客户端。后续需要独立验证真实后台压缩与消息洪流并发、更长任务链和响应速度 benchmark。

所有改动仅本地；不 push、merge 或部署。
