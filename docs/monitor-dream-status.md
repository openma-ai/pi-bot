# Monitor / Dream：实际能力与收敛方向

2026-10-23，独立 harness 分支；draft 已 fetch，HEAD 仍为 `32c626e` / v4.104。
审计基线为 `5bb4213`（实施前）；下方新增一节记录本轮实现，避免把原有能力与新切片混淆。
本核对和fixtures不启用真实后台任务或调用付费模型。

## 先准确命名

- **Monitor：明确条件检测。** draft `content/personal-agent-harness/article.md:69`
  记载 Muse 的 event hook 是固定间隔 Bash 轮询、条件成立才唤醒 agent，且无期限。
  Pibo 当前用 host-allowlisted read-only Detector API，不是开放 Bash hook。
- **Dream：开放式发现。** draft `article.md:81–85,117` 具体叙述的是 **dots Dreamer**，
  不是证明 Muse 存在同名 API：心跳读取近期对话、笔记/待办、连接应用发现线索；只向
  主助手回报，不能直接联系用户或替用户执行。这里把它简称 dream 是本项目的设计命名。
  这些材料来自非官方提示词；只能说明研究依据，不能证明线上行为。

## 实施前的实现矩阵（基线 5bb4213）

| 能力 | 状态 | 源码证据 / 缺口 |
| --- | --- | --- |
| Monitor 持久定义、cursor/baseline、nextCheck | 已实现 | `src/daemon/runtime/proactive.ts:158–205,568–630`；Store tables中monitors/fires。 |
| 静默检查不叫模型、变化去重入inbox、deadline closure | 已实现 | `proactive.ts:450–515,568–630`；`test/proactive.test.ts`已有fixture。 |
| enable前dry-run、host allowlist、超时 | 已实现 | `proactive.ts:165–188,240–248,450–495`。未放开任意shell/网络。 |
| 取消/替换、迟到观察不提交 | 已实现 | `ecf755d`补齐 await 后 source/deadline 重检；不是新增完整Muse monitor。 |
| 断进程后持续监测 | 部分 | 定义/基线保存在SQLite；重启tick重新检查，不恢复原来正在执行的detector。daemon必须运行，不唤醒系统。 |
| 内置可用条件源 | 部分 | `proactive-detectors.ts:5–35`只有host指定文件的stat元数据；`core/daemon.ts:120–128`恢复并注册file detector。邮件、票价、日历等连接器未实现。 |
| 无限期Muse风格hook | 缺失 | `proactive.ts:162,167`强制有限deadline，detector API不是任意Bash脚本。本轮不为了仿Muse放开安全面。 |
| Dream后台执行基础 | 部分 | `proactive.ts:309–414`已有research/memory proposal、durable job、generate/review、evidence hash、取消及回inbox。 |
| 研究模型隔离/预算 | 已实现的library能力 | `proactive-model-worker.ts:5–51`无工具；只读本地给定evidence，一次生成+一次独立审核，有限tokens、零重试。不是联网research agent。 |
| Dream生产环境接线 | 缺失 | `core/daemon.ts:124–128`当前仅传detectors，未传workers；`createModelBackgroundWorker`只有export/test使用。旧文档中CLI环境开关的描述不能证明当前daemon已启用。 |
| 定时上下文发现循环 | 缺失 | 没有自动选近期对话/笔记/待办、周期research、按已连接应用搜索变化的dream runner；当前background_work是显式调用且需host注册worker。 |
| Dream结果审核/回传 | 已实现的library能力 | `proactive.ts:352–384`审核后research结果送原任务inbox，quiet memory不自动外发；`pi/proactive-extension.ts:93`要求通过send_message决定是否通知。 |
| Dream崩溃续跑 | 部分 | jobs/运行中proposal标uncertain，不自动重放生成/外部动作；未恢复原模型请求。 |
| 用户触达 | 原有inbox/outbox已实现；SDK切片另交付 | discovery结果不是系统push；共用原source/task/inbox，SDK只派生触达意图，不再造监测器/研究调度。 |

## 足够的产品模型，最小的工程差距

**Monitor + Dream 作为两个生产者足够；它们共用已有任务生命周期与结果交回。**
这是建议，不代表删掉既有schedule/memory/job，也不代表自动打开dream。

```
明确条件 → 既有 monitor/detector ─┐
                                ├→ 原任务 inbox → 主助手核验/决定
开放式发现 → 既有 background job ─┘                 ↓
                                           原 outbox / pending request
                                                   ↓
                                      共用 notification policy + adapter
```

由此收敛的实现方案是：只需在现有schedule/tick触发下增加一个**有预算、可关闭、无外发权**的
worker接线：host选择近期证据/目标范围，稳定周期key避免重跑，同一时刻只一个，结果仍走
现有proposal审核和inbox。先用本地evidence fixtures跑闭环；外部app读取权限和付费模型
另行授权。不能把现在的无工具归纳器改名就宣称具备完整开放式研究。

当前SDK切片只补共用出口：从canonical pending request/reviewRequired以及host显式核验
的最终结果派生持久通知意图，处理去重、read、静默、任务失效、有限重试；无默认外发。
不在notification service里发现新目标、轮询外部条件或启动研究，避免形成平行调度器。

## 本轮新增（与上述基线区分）

- 通知SDK已独立提交 `61a0e46`：默认无adapter、无自动外发；host核验结果后显式选择
  触达，read与adapter acceptance分开。没有新增调度器。
- 新增host `createDream` 和daemon SDK显式 `researchWorker` 注册入口。复用schedule
  tick、fire、durable job、proposal和research inbox；固定证据refs、有限轮次/deadline、
  单in-flight、取消失效、生成后/复核前重检；不唤醒主Pi去执行research trigger。
- 现有无工具model worker的生成+独立审核预算继续沿用；没有导入新模型或凭据。
- 中断工作保留uncertain、暂停dream等待host核查；未注册worker时不运行。没有把
  未确定的旧工作自动重放。前台继续接收新用户输入。
- fixtures验证两类producer都先返回主inbox，再由主agent/host决定最终结果和触达候选。
  所有新测试使用假worker/假adapter，不产生外部效果。

仍然缺失：开放式读取应用/笔记/待办、自动选择新目标/证据、无限长期研究、真正APNs。
因此本轮是 **有预算的local-evidence dream SDK闭环**，不能称为完整Muse/dots复刻。
未重写monitor，未删除原有schedule/memory/job，未自动启用任何真实后台研究。

## 本轮验证证据

- 完整 `npm test`：371/371通过、0失败、0跳过。日志：本地忽略文件
  `work/proactive-sdk-final.log`，含原有前台交互/后台压缩回归。
- `npm run check`、`git diff --check`通过。
- 新增通知SDK/服务fixtures共17例，dream core 14例、producer SDK路径3例。
  后者实际经过daemon opt-in worker、typed客户端的monitor创建/启用、原inbox、host筛选
  和notification API；另证实host拒绝权限时worker一次也不调用。
- dream core覆盖重复tick/单in-flight、前台新输入不等待research、maxRuns、剩余deadline
  abort、取消/替换/关闭、迟到review、重启uncertain隔离、证据失效/预算耗尽不饿死monitor。
- 本轮未运行付费模型、外部监测或原生通知，没有APNs/token/权限/部署变更。
