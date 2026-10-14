# 真实消息洪流与后台压缩并发验收 — 2026-10-14

基线 61eeb01，local-behavior。模型由本机 Pi 原生配置与 auth.json 解析：官方 DeepSeek Flash（deepseek-v4-flash），所有前景与摘要请求均 thinking enabled、effort high。用户已取消费用和输入预留限制；每轮仍最多 32 次 HTTP dispatch、单请求/后台工具 10 分钟、整轮 60 分钟，最多 16 次请求/wake，零自动 provider retry。没有 DSH agent 或新增认证环境变量。

## 测试路径与结果

逐条消息进入真实 BotRuntime durable inbox；使用实际 Pi session、原生工具、独立 codemode/Python 进程和 send_message/outbox。群传输是本地模拟传输，保留频道/线程/原始用户路由；不是外部群服务生产验证，也不是吞吐或延迟成绩。

| 轮次 | 判定 | 有效任务 | 关键证据 |
|---|---|---:|---|
| [flood-1](behavior-traces/20261014/flood-1.json) | 通过 | 5/5 | 23 条独立到达消息；重叠任务、跨群隔离、更正/取消、bot 交接，0 遗漏/重复/错群/过时动作/闲聊回复 |
| [natural-1](behavior-traces/20261014/natural-1.json) | 通过 | 1/1 | 未注入 host taskControl；模型自行吸收 RED→BLUE 与自然语言取消，0 过时动作或取消回复 |
| [cancel-1](behavior-traces/20261014/cancel-1.json) | 通过 | 1/1 | 正在运行的 TaskChain 发布被取消；原 Python PID 继续并结束，后续保存被权限钩子拦截；独立 CSV 完成，取消任务不计遗漏 |
| [summary-1](behavior-traces/20261014/summary-1.json) | 通过 | 2/2 | 前景重叠、真实摘要完成并原生采纳；快照之外的更正生效，旧版本提交被拒绝 |
| [summary-2](behavior-traces/20261014/summary-2.json) | 失败，保留 | 0/2 | 24 条集中闲聊、摘要期间更正和取消；摘要已采纳，但诊断副本被误计入上下文，26 pending/uncertain、4 runtime errors |
| [summary-3](behavior-traces/20261014/summary-3.json) | 通过 | 2/2 | 相同密集场景，修复后 0 pending/error，正确新版和 CSV 均交付；用量记录有独立仪表错误，不能当作零 token |
| [summary-4](behavior-traces/20261014/summary-4.json) | 失败，保留 | 未完成 | 有效消息本身超过人工 256k 窗口；关闭时 monitor 访问已关闭 SQLite，进程在写报告前退出，另保存只读失败快照 |
| [summary-5](behavior-traces/20261014/summary-5.json) | 通过 | 2/2 | 模型原生窗口、允许重复后台压缩：2 次摘要完成/采纳，24 条闲聊，更正/取消正确，pending/error=0 |
| [complex-1](behavior-traces/20261014/complex-1.json) | 失败，保留 | 产物通过，交付未完成 | 双 bot 两个社区 worker 生成 WorkQueue，26/26 执行测试通过，但 32 次调度保护挡住最终用户交付 |
| [complex-2](behavior-traces/20261014/complex-2.json) | 通过 | 1/1 完整项目 | 有界复测允许 64 次调度，实际 35；26/26，测试未改动，两个 completed worker、两条 peer 消息、一次最终用户交付，pending/error=0 |

成功轮要求全量 inbox processed、runtime errors=0、配对完整、无超时、取消与噪声无用户输出，成果通过独立执行检查，再确认单一正确路由的 delivered send_message。不会以 READY 文本、文件存在或摘要 entry 存在单独判定通过。

TaskChain 来自 MARBLE coding task 46 的明确 headless 改造，原 API/异常/通知/协作/报告检查 12 项，加晚到 RELEASE_TAG 共 13 项；CSV 由真实输入计算并单独核验。不是 MARBLE 原编排或 leaderboard 成绩。运行暂停用于建立可观测并发，不作为速度成绩。

## 发现与修复

1. 上下文保护原先序列化整个 toolResult，把 SDK 的 details 诊断副本算作发送给模型的内容。失败轮原生投影约 231,353 UTF-8 字节，其中 details 59,219 字节；再加系统/工具/权威 ledger 后误触保护。官方适配器只发送 tool content。现计量排除仅 SDK details 的诊断计数，仍完整计入 content/系统/工具/ledger。原消息与 details 原对象均保留，真实 content 溢出仍拒绝；没有删历史、任意截断、同步摘要或等待摘要兜底。
2. 默认摘要原 2,048 输出不够容纳 high reasoning 和可用正文。前景与摘要统一最多 16,384 输出（包括 reasoning），model.maxTokens 可降低该上限，调用者也不能抬高。摘要提示要求正文小于 6,000 UTF-8 字节，采纳硬检查为不超过 8,000 JSON 字节；另校验稳定前缀、完整工具边界、原 session ID 与 sourceHash，下一原生安全边界采纳。
3. 默认摘要此前未经过宿主请求 guard。现与前景共用 beforeProviderRequest，并关联整轮 lifetime；新消息只抢占前景，摘要/已启动工具仍独立。原生 Pi 回归证明摘要确实经过 guard。
4. 流式观测初版使用 request record 与 usage record 同名变量，吞掉 summary-3 的用量记录；旧报告保留。现提取独立 SSE 数字观测函数，记录 finish_reason/[DONE]/usage，原始 payload、reasoning、headers 和凭据不保存。没有完整 usage 的请求不能推断零用量或零费用。

5. 压测夹具还人为限制 256k 上下文，并禁止首次摘要后再次调度，不能代表正常 GUI 的实际容量/重复压缩政策。现使用 Pi 所选模型的声明窗口（本机 1,000,000；[官方规格](https://api-docs.deepseek.com/quick_start/pricing/)为 1M），允许原验证进程仍活动时继续单 flight 压缩。真实 window guard 仍存在，低窗口回归仍拒绝过大实际 content；不是把 256k 失败改判通过。
6. summary-4 的测试 release monitor 未在关闭 SQLite 前停止；已在关闭运行时前清理 interval，避免失败收尾时读 closed database。保留崩溃日志和只读快照，未伪造该轮的丢失用量。

离线夹具也统一为请求数保护，移除旧的总输入预留默认值；旧显式限额测试仍保留。QuickJS 失控脚本回归的启动余量由 200ms 改为 2 秒，以覆盖完整并行测试的 WASM 初始化，仍要求硬截止和保留已发出的部分输出；真实工具的 10 分钟截止未放宽。

失败 summary-2 已发生 guard 错误后，宿主显式释放自己的测试暂停文件，让原进程排空；该操作没有重放旧任务，也未改为通过。旧 native 脱敏快照与 host-release.json 保存在 work/behavior-20261014/summary-2。

普通 GUI 已启用真实后台压缩；默认沿用模型窗口的软阈值，预留 16,384 输出，摘要最多 10 分钟、单 flight、有界重试。测压夹具使用较低触发阈值和较短 verbatim tail 来稳定观测并发；不能把此有限轮次推广为无限输入保证。认证、模型切换、消息、工具和群路由均保留。

## 最终请求证据与工程产物

[最终摘要](behavior-traces/20261014/acceptance-summary.json)：summary-5 为 12 次 HTTP dispatch attempt，10 个 HTTP 200 响应、9 份完整 usage；缺失的 3 个请求不按零用量推断。请求时间记录证明 5 对已收到 HTTP 200 的前景/摘要流区间重叠；两份摘要实际结束并生成两条原生 compaction entry。全部请求载荷标记 thinking enabled、high，输出上限不超过 16,384。完整 usage 的 token 汇总见 JSON，reasoning 是输出子集，不重复相加，不另做费用预算。

WorkQueue 是自定义工程夹具，不是现有外部生产仓库 issue 或公开 benchmark 的官方成绩。两个 bot 分工修改共享项目：A 的社区 worker 实现 SQLite、迁移、依赖/状态机/事务，B 的社区 worker 实现 CLI 与使用文档；父 bot 通过原生 peer inbox 交接，运行期间另有 12 条不要求回复的独立消息。A 整合后用 bash 跑测试并唯一交付，宿主再次独立执行。最终存储模块 293 行、CLI 161 行，见 [可运行工程](behavior-artifacts/20261014/workqueue/README.md)；测试文件 SHA-256 未变，26/26 通过，覆盖 SQL 参数化、原子回滚、幂等、多连接、迁移、CLI 错误与 CSV 计算。首轮及复测轨迹均保留；[原生用量](behavior-traces/20261014/complex-2-native-usage.json)含 34 个带 usage 的响应，未记录完整 usage 的调度不按零用量计算。

[真实 TaskChain 产物](behavior-artifacts/20261014/taskchain/TaskChain/solution.py)和 [CSV](behavior-artifacts/20261014/taskchain/Reports/progress.csv)亦保留；新版通过 13 项执行检查。离线 228 项通过，与真实 API 成绩分开。人工缩小窗口的两个失败轮和首个工程截断轮仍失败，不作为通过分母外的隐瞒结果。

## 复现

在 GUI/Pi 中选择已认证的官方 deepseek-v4-flash、high。原生认证输入不得放入聊天、命令参数或报告。报告和 .status 不允许覆盖，请选全新目录：

```sh
npm run prepare:background
npm run check
npm test
mkdir -p work/flood-repro/{smoke,natural,cancel,summary}
npm run evaluate:behavior -- --real --suite smoke --auth-source pi --report work/flood-repro/smoke/report.json
npm run evaluate:behavior -- --real --suite smoke --scenario replace-cancel --natural-controls --auth-source pi --report work/flood-repro/natural/report.json
npm run evaluate:behavior -- --real --suite taskchain --background-execution --cancel-during-execution --auth-source pi --report work/flood-repro/cancel/report.json --artifact-dir work/flood-repro/cancel/artifacts
npm run evaluate:behavior -- --real --suite taskchain --background-execution --background-summary --auth-source pi --report work/flood-repro/summary/report.json --artifact-dir work/flood-repro/summary/artifacts
npm run benchmark:engineering -- --real --data-dir work/engineering-repro
```

这会真实调用 API。auth-source pi 的 inputReservationEnabled=false，只做有限 dispatch/超时保护；旧 tty/dsh 命令保留历史行为。保守 UTF-8 context 计量不是供应商 tokenizer，也不是费用计算。真实 API 的行为结果与离线 regression 分开；旧失败与仪表错误不覆写。
