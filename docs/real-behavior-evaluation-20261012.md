# Pi Bot 真实消息洪流行为评估 — 2026-10-12

结论：真实 API 已完成首轮、两次单项复测、一次完整复测和一次交接诊断；**完整 smoke 尚未通过**。不能以单项复测或离线成绩替代完整运行失败。后台压缩并发真实验证暂未开展。

## 工作区与实际执行

仓库 `/Users/xiaoyang/Documents/Codex/2026-10-12/task-2/pi-bot`，分支 `local-behavior`，HEAD `ee29ceb015344041d79573fae306e28120fa678e`；开始时干净。原 Terminal 等待进程 PID 82570 无网络连接，指定报告和状态文件不存在。停止该等待进程后再启动，未读 Terminal 内容。

用户随后明确授权直接复用本地 DSH DeepSeek key。认证值仅在宿主进程内读取，传入 ModelRuntime 的内存凭据；没有 key 参数、环境导出或凭据副本。结束时清除 runtime key 和临时模型目录。

复用了 `runEvaluation`、真实 Pi SDK、SQLite inbox/outbox、SimulatedChat、native jobs/tools 和 send_message。没有运行 DSH agent，也没有把消息拼接后直接发送模型。诊断运行只添加观测数据，并选择原有场景，未改变任务或评分规则。

官方 endpoint `https://api.deepseek.com`，请求模型 `deepseek-v4-flash`，thinking enabled / effort high。官方文档说明该旧 ID 现由 V4.1 Flash 服务；本报告按请求 ID 命名，不声称验证了独立的旧 V4 权重。

每轮上限保持 32 请求、384,000 保守输入预留、每请求 16,384 输出（含 reasoning）、单请求 10 分钟、整轮 60 分钟；无自动重试。取消美元预算上限没有取消这些保护。五轮均关闭后台摘要。

## 结果

| 运行 / JSON 文件名 | 有效任务完成 | 整轮通过 | 请求数 | 输入预留 | usage 记录数 | API 输入 / 输出 token |
|---|---:|---|---:|---:|---:|---:|
| pi-bot-real-smoke-20261012T143837Z | 5/5 | False | 28 | 368,946 | 23 | 78,629 / 7,865 |
| pi-bot-real-retest-overlap-isolation | 3/3 | True | 9 | 116,581 | 8 | 26,960 / 1,599 |
| pi-bot-real-retest-handoff | 1/1 | True | 10 | 151,341 | 10 | 35,053 / 5,010 |
| pi-bot-real-smoke-retest-full | 4/5 | False | 26 | 324,578 | 21 | 68,900 / 8,988 |
| pi-bot-real-diagnostic-handoff | 1/1 | True | 8 | 103,083 | 8 | 24,788 / 6,016 |

首轮：5/5 完成；遗漏、重复、错群、过时动作均 0。重叠场景向 `alpha / lounge / bob / noise-7` 多发送一次不合约定的闲聊回复，silence=false，malformed=1。交接任务本身完成，但后续输入预留拒绝 1 次，runtimeErrors=1、pendingEvents=1，因此不算全部收尾。28 次 HTTP 调用中 23 次拿到 HTTP 200 和 usage，其余未拿到响应，不能据此断言零计费。

完整复测：4/5 完成；只有四个期望工具记录存在；交接没有执行 commit_record，且最终回复未满足 `DONE handoff=FINISHED` 的精确合同，malformed=1，因此交接完成率计 0/1。有 1 个遗漏工具记录；重复、错群、过时动作均 0；预算拒绝、runtimeErrors、pendingEvents 均 0。无 provider/整轮超时。原报告没有保存实际回复文本，无法事后确定未执行工具和错误回复的具体决策原因，不能把它仅解释为格式问题或编造失败文本。

两次重叠场景后续运行均通过；交接的两次单项运行均通过。最后诊断 nativeToolCounts 为 list_bots=1、send_to_bot=1、start_job=1、send_message=1，工具错误 0；最终回复精确符合合同。单项通过显示原生路径能够完成任务，不证明失败已消除。

更正与取消：两次完整运行均只提交 BLUE，没有 RED、doomed 或取消任务的回复/动作。这里自然语言同时带 host 的显式 replace/cancel 字段，不能推断仅靠自由文本识别改口也已通过。

所有运行 native transcript 工具调用/结果配对有效。有效 jobs 完成后 agent 能继续给出结果；没有验证跨进程重启恢复、真实外部群聊或无限消息洪流。

## 诊断与修改

已复现的运行边界问题是整轮输入预留耗尽；保护按设计拒绝请求，不能为凑通过而提高首轮上限。单项复测隔离了该因素。闲聊多余回复和交接任务遗漏/错误回复在单项复测中未稳定出现，属于仍存在的模型行为风险；当前证据不足以归因为具体代码 bug，没有进行猜测性实现修补。未 push、merge 或部署。

离线重新验证：TypeScript check 通过，67/67 测试通过，diff 检查通过；这些是离线结果，不是新增真实模型通过项。

## 请求、token 与费用

合计 81 次 dispatch/HTTP 调用，70 个 usage 记录；已返回 usage 的输入 234,330、输出 29,478，其中 reasoning 20,490（reasoning 已包含在输出，不能重复相加）。有 11 次缺少 usage，可能包括提前取消的请求；请求数可核验，完整 token 和实际账单不可核验。

2026-10-12 实时读取 [官方价格页](https://api-docs.deepseek.com/quick_start/pricing/)：Flash 每百万 token 峰时缓存命中 $0.006、未命中 $0.30、输出 $1.20；闲时减半。已知 usage 对应估价范围 **$0.036749–$0.073497**，这不是整个评估费用上限或实际账单。未返回 usage 的计费未包含，runtime 内置 cost 的缓存单价也不能当官方账单使用。

## 复现

原仓库 CLI 仍只有隐藏 TTY 认证，并保留旧批准金额参数；本次没有猜测不存在的 CLI 参数。配套 `run-real-smoke.mjs` 是明确授权后的宿主认证入口，直接调用同一 `runEvaluation`。无需 DSH agent。示例：

```sh
node --import /Users/xiaoyang/Documents/Codex/2026-10-12/task-2/pi-bot/node_modules/tsx/dist/loader.mjs /Users/xiaoyang/Documents/Codex/2026-10-12/pi-bot-agent-users-xiaoyang-documents/outputs/run-real-smoke.mjs /tmp/pi-bot-real-reproduction.json
```

每次显式启动一轮，先检查报告/status 与相关进程，避免重叠。脚本没有自动复测循环；不会打印 raw provider errors、key 或模型文本。

## 后台压缩后续验证计划

完整 smoke 的通过门槛尚未满足，暂不把压缩引入本次失败诊断。后续先稳定复现交接遗漏/闲聊回复问题并完成完整 smoke，再做独立有界压缩轮：真实前景和摘要请求共用 32 请求/384k 预留计数；为摘要请求增加相同超时与输出限制；在已有稳定前缀上启动真实后台摘要，摘要运行期间注入多任务、改口和取消；统计摘要启动/完成、与前景重叠、原生 compaction entry 在下一安全边界采纳，以及消息/工具关联和最终动作。必须实际看到摘要被采纳并完成有效承诺，才能报告压缩效果。不得同步摘要兜底或裁剪历史。
