# Pi Bot 真实任务、后台执行与异步压缩评估 — 2026-10-13

两轮真实生成任务已各完成 2/2；交接来源与闲聊串线的确定性问题已修复，并保留失败轨迹。接入原生后台执行后，实际 Python 进程的连续性、读取完整结果及运行中取消均有真实 API 证据。后台摘要最后一轮完成、与前景重叠并实际采纳，晚到更正形成的程序通过 13 项检查。**最后整轮仍未通过：输入预留保护触发，14 个 inbox 记录被保守标为 uncertain。没有放宽 384k 或裁剪历史来获得通过。**

## 确定性修复与限制

1. 原交接轨迹显示协调 agent 把自己的 inbox ID 交给 worker 的记录工具，产生 Record source route rejected；一次成功运行实际经历了拒绝后补救。现在宿主为声明绑定的工具注入验证过的来源字段；原父任务 ID 只解析到当前 bot 已观察到的唯一继承分支。另一条同 task key 的外部任务不能借此冒充来源。
2. 多任务交错时，省略 source_message_id 原来会回复最新闲聊。离线回归先得到错误 outbox，再修复为明确拒绝歧义来源。已观察的真实重叠场景复测无额外闲聊回复。但早先那条 noise-7 回复没有保存正文，不能断言它一定来自此机制。
3. 权威 runtime ledger 原先漏掉 processing inbox，导致模型查状态看见空任务列表；已修复可见性。hostTask 将原始宿主授权投影与 untrusted bot 建议分开，保留原任务交付契约。
4. 原预算把 SDK details/nestedCalls 等未发给 API 的诊断副本算进预留。官方适配器实际只发送工具 content；新真实 CLI 在 fetch 之前按**完整实际 JSON 请求体 UTF-8 字节加 1,024**预留，包含全部消息、工具 schema 和 reasoning replay。诊断原件和对话不删除；数字仍是保守预留，不是 tokenizer 结果。旧 native-context 与新 wire 预留不可直接横比。
5. 完整 codemode_wait 返回全部验证结果时，旧评分只认 codemode_read，造成假阴性。回归修复后接受实际完整结果，拒绝 READY 声明和未完成分页；原报告不覆盖，另存重评。
6. 权限拒绝分支没有触发 Pi tool_result hook，但原生 cell 文件仍保存 tool_finished。评估从脱敏 cell 轨迹补齐这类结果，记录实际 denied outcome。

## 真正产出的任务

基准来源为 [MARBLE / MultiAgentBench](https://github.com/ulab-uiuc/MARBLE)，锁定 `8d60fa17b5596b44458a52d4296061b9fc13d6f2`，coding task 46 TaskChain。上游任务及 MIT 许可保存在仓库 fixtures/marble-taskchain。

这是明确改造的 headless 子集：依赖管理、任务状态、协作评论、通知、进度报告和 Mermaid 图输出；使用独立 Python 执行检查。没有实现完整上游 UI/实时服务，也没有使用 MARBLE 原编排或 leaderboard oracle。CSV 是相同工作场景的自定义数据分析伴随任务，不是原 benchmark 成绩。

- 修复后完整自定义 smoke 一轮 5/5，26 请求；后一轮 4/5，24 请求并触发输入预留保护。独立最终交接真实 CLI 一轮 1/1，8 请求通过。
- 真实 TaskChain 生成 + CSV 两轮各 2/2，均 20 请求；程序每轮 12/12 执行检查通过。纠正通知 ready→unblocked、取消 export、重复投递以及闲聊均未导致重复、错群或过时最终产物。
- 保留 [生成程序](real-work-3/TaskChain/solution.py) 与 [CSV](real-work-3/Reports/progress.csv)。这是原生 Pi inbox、jobs/tools 与 send_message 路径；没有运行 DSH agent，没有把 flood 拼成单个聊天 prompt。

## 本次后台真实轮

| 运行 | 有效任务完成 | 原始整轮 pass | 请求 | 输入预留 | usage 记录 |
|---|---:|---|---:|---:|---:|
| [20261013-background-1](behavior-traces/20261013-background-1-original.json) | 1/2 | False | 6 | 313,945 | 5 |
| [20261013-background-2](behavior-traces/20261013-background-2-original.json) | 2/2 | False | 7 | 321,959 | 6 |
| [20261013-cancellation-1](behavior-traces/20261013-cancellation-1-original.json) | 1/1 | True | 6 | 253,537 | 5 |
| [20261013-compaction-1](behavior-traces/20261013-compaction-1-original.json) | 2/2 | False | 9 | 338,359 | 8 |
| [20261013-compaction-2](behavior-traces/20261013-compaction-2-original.json) | 2/2 | False | 8 | 362,895 | 6 |
| [20261013-compaction-3](behavior-traces/20261013-compaction-3-original.json) | 2/2 | False | 8 | 305,173 | 6 |

- background-1：1/2。真实程序仅 7/12，异常类型契约错误；同时旧预算拒绝后续请求。保留失败产物和所有轨迹。
- background-2：2/2，程序 12/12、CSV 正确；完整 codemode_wait 已返回真实结果，PID 4981 从开始到结束，期间 B 完成并释放 A。无遗漏、重复、错群、闲聊回复、runtime error 或超时。原始 pass=false 是完整结果评分假阴性；[重评](behavior-traces/20261013-background-2-regraded.json)另行保存，独立重跑实际生成程序及 CSV 检查通过，pass=true。
- cancellation-1：1/1 有效承诺（CSV）完成，TaskChain 被运行中取消，不应算遗漏。原 Python PID 连续到结束；validate→save_artifact 的新后续调用被实际权限钩子拒绝 1 次，未保存 TaskChain 产物、未发送其用户回复；runtime errors=0、pending=0、timeouts=0。1 条原生 tool error 是预期取消保护，不是执行故障。
- compaction-1：2/2 成果完成，但摘要 2,048 输出全部 reasoning、无可采纳正文；没有证明压缩。输入预留拒绝 1 次，pending=11、runtime errors=2。
- compaction-2：2/2 成果完成，晚到 release tag 通过第 13 项检查，旧提交被拒绝。4,096 输出仍 length 截断，没有完成/采纳摘要。前景重叠=2；输入拒绝=1，pending=13、runtime errors=2。
- compaction-3：摘要 8,192 输出上限内完成，正文 4,775 字符；started=1、completed=1、native compaction adopted=1、foregroundOverlap=5。snapshot 不含晚到更正；真实旧进程继续，新旧程序是不同版本的验证，非重启旧进程。旧版本 save_artifact 被拒绝 1 次，新版 RELEASE_TAG 通过 13/13，CSV 正确，两份 send_message 均 delivered 到原线程。**输入预留拒绝 3 次，runtime errors=3、pending/uncertain=14，所以整轮严格 pass=false。** 这证明实际异步摘要/安全边界路径已运行，不能证明在当前保护下稳定完成整轮全部 inbox 收尾。

所有后台轮：实际执行器为 Pi 原 QuickJS/codemode→submit→独立 sandbox Python→save_artifact；记录起止 PID、native 父子调用、进度、完整结果、cell 和 outbox。普通新输入只结束等待，原进程不重启。受控 pause 用来保证观测期间存在重叠，不是吞吐或延迟目标。数据来自模拟本地群传输；不是外部聊天生产验证。

## 压缩的保护

摘要在独立请求运行；宿主 predicate 只选择真实进程开始后的启动时机，不阻塞前景。摘要自身输出上限从 2,048 经诊断增到 4,096、8,192，始终低于 16,384。前景与摘要共用 32 请求、384,000 输入预留、每请求 10 分钟、整轮 60 分钟保护。没有同步摘要兜底或任意 history clipping。采纳证据是原生 compaction entry，含 sourceHash、firstKeptEntryId 和 background-ready-only details；晚到更正仍在 tail/权威 ledger。

离线汇总 [日志](behavior-traces/offline-final.log)：116/116 通过；TypeScript 与 diff whitespace 检查通过。离线 provider/摘要政策是 deterministic fixture，不计真实模型成绩。

## 可核验用量和费用

这次 6 个后台轮合计 **44 次 HTTP/dispatch attempt**，36 条 usage，8 次无 usage；已知输入 423,429，输出 54,183（含 reasoning 40,383），缓存命中 84,736。reasoning 不再次加到输出。详细分轮 [用量](behavior-traces/current-api-usage.json)。缺失 usage 的请求不能推断零计费。

[官方定价页](https://api-docs.deepseek.com/quick_start/pricing/)：Flash 峰时每百万输入未命中 $0.30、命中 $0.006、输出 $1.20；闲时减半。已知 usage 费用估算 **$0.083568–$0.167136**，不是整轮费用上限或供应商账单，不含无 usage 请求。其他会话的 14 次背景 smoke 独立记账，本表不混入它；更早的普通任务报告保留原 token/费用。实际请求 ID deepseek-v4-flash 现由官方 V4.1 Flash 服务。

## 复现与文件

```sh
cd /Users/xiaoyang/Documents/Codex/2026-10-12/task-2/pi-bot
npm run prepare:background
npm run evaluate:behavior -- --dry-run --real --suite taskchain --background-execution --auth-source dsh
# 选择全新 report/status 路径；下列是复现例子，不会自动循环：
npm run evaluate:behavior -- --real --suite taskchain --background-execution --auth-source dsh --report work/new-bg/report.json --artifact-dir work/new-bg/artifacts
npm run evaluate:behavior -- --real --suite taskchain --background-execution --cancel-during-execution --auth-source dsh --report work/new-cancel/report.json --artifact-dir work/new-cancel/artifacts
npm run evaluate:behavior -- --real --suite taskchain --background-execution --background-summary --auth-source dsh --report work/new-summary/report.json --artifact-dir work/new-summary/artifacts
```

先创建 report 的父目录，并检查现有 status/pid。CLI 拒绝覆写报告或复用 status。认证仅 host-only 读取已授权 DSH scalar；key 没有进代码、参数、工具、环境导出、日志或报告。运行数据、SDK spill 及临时程序均在项目 work/，选定成果在本 outputs/；旧 /tmp 报告只读复制用于归档，未继续往 /tmp 写新运行。

所有原始失败报告在 [用量索引](behavior-traces/current-api-usage.json)相邻文件，命名 *-original.json；每轮 executions 子目录保存脱敏逐事件 JSONL 和 cell JSON。未覆写或撤销共享后台实现；未 push、merge 或部署。

尚需进一步工作：在保持保护的条件下，让压缩后的任务/噪声 inbox 干净收尾，处理 quota 触发后整个 wake 的保守 uncertain 状态；不能用已交付成果替代 inbox 全部结清的证明。此次停止付费循环，保留明确可复现的保护触发和对应原生证据。


2026-10-14 续测与修复：上述限额、关闭摘要和未验收说明属于历史轮次。最新真实消息洪流、自然语言改口/取消、运行中取消及后台压缩并发验收，见 [真实并发验收](real-flood-compaction-20261014.md)。普通 GUI 已启用后台摘要；旧失败未改写成通过。
