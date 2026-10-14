# 会话导航、错误提醒与真实截图验收（2026-10-14）

本轮修复真实 Pi GUI。当前界面使用官方 shadcn/ui Sidebar、Radix ScrollArea / Dialog / Toast 和 cmdk；保留原生 Pi 登录、模型配置、inbox、工具执行与 send_message。没有换成演示后端。它是依据实际 Grok Bot 窗口观察改写的界面，不是恢复出的 Grok Bot 原始源码。

## 导航和输入

- Bot 与群聊在同一列表中，按最近公开会话消息排序。私密 bot-to-bot 交接不进入联系人预览或全局搜索。
- 桌面侧栏仅调宽：拖拽分隔线，或聚焦分隔线后用方向键 / Home / End。宽度 76–360 px，小于 156 px 显示头像；名字保留在可访问名称和悬停提示中。宽度本地保存。桌面没有折叠按钮；手机使用官方 Sheet 抽屉。
- 搜索只有一个入口：侧栏搜索按钮或 Cmd+K / Ctrl+K 打开同一 cmdk 弹窗。覆盖 bot、群聊、消息、bot 所属定时任务 / 监控及常用功能。消息结果跳到原会话并短暂高亮。搜索已有可见记录，不检索内部 reasoning、私密交接或凭据。
- 联系人独立使用 Radix overlay 滚动条；页头和页脚固定，没有原来的永久粗轨道。
- 详情从居中的会话名称打开，面板只保留一个关闭按钮。定时任务、监控和协作入口属于所选 bot 的详情；移除全局侧栏的重复页面入口。
- Composer 使用成熟 Textarea，单行外框实测 51 px，多行自适应，最多 160 px 后滚动。只有外框 focus 状态；保留中文 IME、Enter / Shift+Enter 和群聊 @ / @全体成员。关闭第三方语法检查的注入标记。
- 草稿按私聊、群聊及协作双方分别保存到当前浏览器标签页的 sessionStorage；切换会话不串草稿，刷新可恢复。保存失败时仍可在内存编辑。

官方组件来源、原始源码摘要与修改说明见 [组件来源](../src/gui/ui/provenance.json) 和 [MIT notice](../src/gui/ui/SHADCN-NOTICE.md)。

## 提醒系统

| 情况 | 呈现位置 | 恢复方式 |
|---|---|---|
| 服务连接中断 | 顶部小型灰色状态条、连接指示 | SDK 自动重连；保留已显示消息和草稿 |
| Pi 配置缺失 | 顶部配置条 | 直接打开登录与模型配置 |
| 整个消息投递停止 | 顶部服务状态条 | 可查看服务状态、队列数和定位信息 |
| 创建或操作失败 | 表单内提示；非表单操作使用可关闭的 Radix Toast | 修正输入或重试对应操作；不盖住整页 |
| 某条任务未完成 | 对应消息旁 | 显示可读原因、错误分类及任务记录；服务确认安全后才提供“继续处理” |
| 群成员处理失败 | 对应公开消息旁，标明 bot | 使用该成员自己的 inputId；其他群或私密交接不混入 |
| 需要用户决定 | 原会话中的选择卡 | ask_user 可提供 1–6 个选项，也可自由输入；回答保持 question/task 关联 |
| 前端发生未捕获渲染异常 | ErrorBoundary 恢复页 | 可重新载入，服务端历史保留，已有会话草稿可恢复 |

移除旧的 `Execution needs review` 泛化横幅。历史执行异常不再伪装成全局服务错误；执行中断与“等待你的回答”是不同状态。提示不展示原始 provider 异常、URL、认证数据或模型 reasoning。

普通已授权执行不创建审批或事前 review。`ask_user` 只用于阻塞工作的真实决策或必要信息。显式配置的审批模式仍遵守操作者配置；未知外部副作用不盲目重放。这是执行去重保护，不是普通任务的额外确认流程。

## 失败根因和修复

“助手”的原输入 `7369d7d5-9442-4095-9a7b-43d8f3b275d7`：电脑插件成功返回 JPEG 后，`NonBlockingContextManager` 无条件拒绝任何图片。下一次推理没有发出，错误为 `Image inputs need a provider-specific context budget`。同时，Pi 本机注册表把官方 Flash 标为 text-only；仅删除检查可能让 SDK 丢掉图片。

修复为只针对经过确认的官方 DeepSeek Flash endpoint / aliases 提供图片预算，并在加载时修正能力元数据，不改变用户选择、认证或配置文件。原生消息、工具调用/结果配对、图片字节和诊断保留；计数副本使用图片 token 上界，不把 base64 文本当模型 token，不裁剪历史。

依据：[官方 Vision 文档](https://api-docs.deepseek.com/guides/vision/)、[图片 token 上界](https://api-docs.deepseek.com/news/news260821/)、[旧模型别名](https://api-docs.deepseek.com/quick_start/pricing/)。每图上界 384 token；限制图片数量和单图大小。未知 provider / endpoint 不获得推测的图片能力或预算。

初次浏览器截图还错误地把 `screenshot` 放到 tool，而未提供 browser `args.action`。工具说明现明确 browser 参数形状；需要原生图片时使用 computer screenshot。

恢复路径还发现 OpenMatter 已完成原 handoff 的去重键，重新 publish 同一 eventId 不会再次激活。现在每次经过证据检查的恢复使用新的 activationId，payload/source 仍关联原生 inbox id。恢复次数持久化；原始投递及恢复事件分别保持幂等。已完成的 send_message 证据只修正状态，不再次执行；存在 job、未完成输出、写入工具或未知效果时不重放。

图片预算检查中断后，只有完整记录证明工具均为已完成的截图/状态读取、没有 job 或输出时才能续跑。`task/recovery` 只读返回可恢复性，`task/reconcile` 在操作时重新检查。不会因为按钮显示“恢复”就跳过这些检查。

并发全量检查还暴露后台结果读取的真实竞态：`codemode_read` 在 cell 未完成时把临时 `{state:running}` 当完整结果返回，并推进偏移量；随后读取真实结果会跳过开头。新增一个确定性 gate 回归，修复为未完成返回 done=false、next_offset=0，完整结果保持从 0 读取，不重跑执行。不提高请求保护上限来掩盖问题。

## 本轮验收

离线：245 项测试通过，包含图片消息和原生 screenshot tool-result 配对、字节/诊断保留、未知 provider、超限拒绝、问题选项幂等、已 handoff 输入的实际再激活、写入痕迹拒绝重放、群内错误关联和搜索隔离。另有 `npm run gui:check` 的前端 no-undef 检查，修复了实测发现的 composer 旧变量引用。类型检查及 GUI 构建通过。

真实 API 与离线结果分别记录在 [脱敏真实轨迹](gui-evidence/gui-vision-decision-20261014.json)：

| 原生 Pi 场景 | 结果 |
|---|---|
| GUI → desktop_list → computer screenshot → send_message | 真实识别 Chromium 空白页；完成 |
| GUI → browser navigate → computer screenshot → send_message | 提示中没有校验内容；读出 `VISION 8Q4N7Z`，识别左蓝、右橙；完成。未调用 bash/evaluate/文件读取/subagent |
| GUI → ask_user choices → GUI 选择 → send_message | 选择“暂不测试”，仅一次关联回答和一次最终输出；完成，无多余确认 |
| GUI → codemode → 运行中 codemode_read → 完成通知 → 完整读取 → send_message | 运行中 done=false / next_offset=0，完成后 done=true；bash 仅一次、无轮询，回复 CELL-READ-GUI-20261014=56 |
| 原云电脑问题续跑 | 使用保留的图片上下文回复；原 inbox 已 processed，最终输出已 delivered |

新建 GUI 场景 4/4 完成，另有一次决策回答唤醒和原问题恢复。包含修复前失败在内，原生文件中观察到 21 个有 usage 的成功 provider 响应，以及一个由本地图片检查产生、零 usage 的 aborted SDK 记录；不要把后者算成真实 API 成功。修复后的完成 turn 合计 417,808 totalTokens（其中 cacheRead 134,400；output 4,700 含 reasoning，reasoningTokens 1,819）。Pi 元数据估算费用约 $0.09006，不是账单核对结果，不是预算上限。

初次恢复按钮确实只把原消息放回队列；这个真实发现已记入轨迹。新增投递回归证明无需重启就能重新 handoff。原互动消息在最终服务重启时处理完成；不把初次按钮操作单独说成成功。

实际浏览器验收：76 px 纯头像、拖拽到 280 px、宽度刷新保留；390×844 抽屉选择群后关闭；1280×900 桌面无折叠按钮；Cmd+K 搜索与 Enter 跳转；群聊 @全体成员；草稿跨会话隔离与刷新恢复；定时任务/监控创建表单默认绑定当前 bot；单一详情入口。实际关闭再启动空闲服务，GUI 自动重连，断线状态条消失，未发送草稿原样保留；没有在这些表单检查中创建额外定时任务。

截图：[Cmd+K](gui-evidence/cmd-k-search-20261014.png)、[头像侧栏](gui-evidence/sidebar-avatar-only-20261014.png)、[真实读图结果](gui-evidence/sidebar-vision-result-20261014.png)、[决策卡](gui-evidence/decision-card-20261014.png)、[错误位置](gui-evidence/task-failure-20261014.png)。

## 复现

1. 使用已有 Linux 桌面镜像和原生 Pi 配置启动 GUI；先检查已有 daemon，避免重复启动。通过 GUI 配置模型和认证，不把 key 写入环境脚本或聊天。
2. `docker cp test/fixtures/vision-proof.html pi-bot-desktop:/tmp/pi-bot-vision-proof.html`。
3. 在一个已有、空闲且已分配窗口的 bot 私聊发送：用 desktop_call browser navigate 打开 `file:///tmp/pi-bot-vision-proof.html`，再用 computer screenshot，仅读图片回复校验字符串与两个矩形颜色；禁止 bash/evaluate/文件读取/subagent。提示中不要包含期望值。
4. 对照原生工具 trace 和 send_message：必须有 navigate/screenshot 图片及最终相关输出；只有 DONE 或普通 assistant 文本不算成功。
5. 用 Cmd+K 搜索该结果，Enter 应跳到正确私聊。侧栏拖到最窄应保持同一会话列表及可访问名称。
6. `npm run gui:check && npm run check && npm test && npm run gui:build`；故障恢复回归可单独运行 `node --import tsx --test test/protocol.test.ts test/image-context.test.ts`。

## 边界

这轮没有重新运行消息洪流/后台压缩全量 benchmark，参见先前的 [真实并发报告](real-flood-compaction-20261014.md)。包含图片的稳定前缀仍不进入文本摘要；没有同步摘要兜底，不证明图片历史的真实后台压缩。未扩展未知 provider 的 vision 计数，也未把 macOS host bash 迁移到 Linux 容器。桌面操作仍只允许所属窗口；本轮未重跑全部跨屏点击及 takeover 验收。消息投递暂停通过 `daemon/triggerChanged` 的持久 SSE 事件即时更新，无需刷新；专项回归覆盖这一链路。

源码恢复、所有 provider、完整云电脑能力和复杂工程 benchmark 不能由本轮 GUI/截图 smoke 推导。
