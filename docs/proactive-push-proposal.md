# Proactive 触达：源码核对与最小切片提案

核对日期：2026-10-23。**本文件是设计与测试计划，未实现或启用推送。**
独立工作树 `feat/harness-lifecycle`，代码核对基线 `ecf755d`；未改正在发包的目录。
重新 fetch `clash-art/draft:docs/personal-agent-harness-context`，最新仍为
`32c626e39bb978f36756f5311fee081ccec7307c` / v4.104。

## 结论

可以做，而且基础事件已具备。建议先补一个 transport 无关的持久通知中心与策略层，
用 fake sink 验证，再单独选择 APNs 的 provider 放在哪里。若目标是锁屏/退出 App
后仍收到新任务进展，则最终需要原生远程通知；只有 App 内提示或本地通知不够。

Draft 值得复用的是三个判断分开：发现线索、允许行动、现在值得打扰。
`content/personal-agent-harness/article.md:31,63–75,83,115–117` 中：
Muse 对照最近对话/送达记录去重、普通消息延后并限制频率；dots 的 Dreamer
只发现，主助手决定是否告知。材料注明归档/重建来源，不能当作线上产品保证。
建议借鉴原则，不照搬一天一次或“紧急”的判定为未经用户选择的固定规则。

## 当前代码已经有什么

| 证据 | 能力与实际边界 |
| --- | --- |
| `src/daemon/runtime/store.ts:61–85`，`events/derive.ts:40–80` | SQLite 写入与事件日志在同一事务；已有 request、job、routine、proposal 和 task/reviewRequired 事件。适合确定性派生候选，不需要每条事件再叫模型。 |
| `src/daemon/runtime/runtime.ts:724–744` | job 结算以稳定 `settled:jobId` 写回原任务 inbox，quiet job 不写此通知。它是唤醒助手的结果事件，不是手机通知。 |
| `src/pi/proactive-extension.ts:93`，`runtime/proactive.ts:368–384` | research 结果先入 inbox；结果获取和用户发送分开，返回 `notify:false`。不能把每个 proposal/job 完成直接推给用户。 |
| `src/daemon/requests/request-broker.ts:24–39,69–99,137–166` | 待处理问题/审批已有持久请求、原始 source ID、有效期和取消检查，可提供行动入口。审批默认十分钟超时，daemon 重启会取消旧 pending approval，不能宣称审批已跨重启续跑。 |
| `src/daemon/runtime/runtime.ts:530–576,751–792` | 已有 conversation outbox、稳定 key、发送前任务有效性检查；sink 抛错记 uncertain，不盲重试。 |
| `src/daemon/core/daemon.ts:168–170` | app-server 当前传给 `deliver` 的是空 sink。此链路的 delivered 不能解释成 APNs 成功，更不能解释成用户已看到。 |
| `src/daemon/events/event-log.ts:60–100`，`src/gui/useDaemon.js:138–162` | snapshot + seq replay/ack，适合断线重同步；ack 是接收事件进度，保存在连接级内存中，**不是人已读回执**。 |
| `src/gui/Notification.jsx:4–22`，`main.jsx:1016–1018` | 当前 Notification 是 Radix Toast，主要显示操作/连接反馈；无系统推送。 |
| `src/gui/useRuntime.js:102–114`；`clients/tauri/src-tauri/src/lib.rs:48–56,258–261` | 原生移动端隐藏时主动 disconnect、abort SSE，回前台重连。现有设计本来就不靠后台常驻连接收事件。 |
| `clients/tauri/src-tauri/Cargo.toml:14–30`，`capabilities/default.json`，`src/lib.rs:757–788` | 未接 notification/push plugin、APNs token 注册或回调桥；native invoke/SSE bridge 可复用。 |
| `clients/tauri/src-tauri/gen/apple/project.yml:44–63` 及被引用 plist/entitlements | 当前源工程无 `aps-environment`，无 `UIBackgroundModes:remote-notification`；实际 entitlement 是空 dict。未检查已签名 archive，不能据此断言线上/TestFlight 包权限。 |
| `clients/tauri/src-tauri/gen/apple/pi-bot-desktop.xcodeproj/project.pbxproj:438,471` | iOS bundle ID 是 `dev.pibot.ios`，不是桌面 `dev.pibot.desktop`；未来 APNs topic 要对齐实际签名包。 |

本次搜索未找到持久 per-user read cursor、通知偏好/静默时段、device token 表、
APNs sender 或 notification delivery outbox。不要把现有协议中名为 notifications
的 RPC 事件当作原生通知能力。

## 四种触达不能混用

| 通道 | App 运行/连接要求 | 本项目用途 |
| --- | --- | --- |
| App 内通知中心 | 下次连接可从服务端同步；不依赖系统通知许可 | 所有可追溯候选/行动/结果的事实来源，支持已读、过时和延期原因。与 agent 的 inbox 分开。 |
| 前台提示 | App 打开且在线 | 非当前会话的新结果提示；当前会话可见时避免重复 banner。 |
| 原生本地通知 | App 必须先把请求交给 OS；之后时间触发可由 OS 执行 | 已知时间提醒或 App 仍有执行机会时的事件；无法得知手机休眠后服务器新完成的任务。 |
| APNs 远程 alert | 运行中的 provider 向 APNs 发送，OS 处理到达 | 锁屏/后台的新任务结果和需要行动提示；点击后重连并读取最新状态。 |

Apple 说明本地通知由系统处理预先安排的请求；后台更新则是另一类低优先级、
可能延迟/丢弃的远程通知。silent push 不保证投递，也不是长期运行 agent 的办法。
普通 alert 触达不要求先靠 silent push 唤醒 JS；`remote-notification` background
mode 是需要后台更新处理时的另一个选择，不能把它当作 alert 的必选项。

来源：[本地通知](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app)、
[后台更新](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)、
[UIKit 后台执行](https://developer.apple.com/documentation/uikit/about-the-background-execution-sequence)。

Tailscale 提供网络路径，不授予 iOS 后台执行时间。源码的 hidden→disconnect
进一步说明本项目不能用“保持 Tailnet/SSE 在线”替代 APNs。

Tauri 官方 notification 插件支持 iOS、本地展示/调度/取消和 actions；核对其
[Swift 实现](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/notification/ios/Sources/NotificationPlugin.swift)
是向 `UNUserNotificationCenter` 添加 `UNNotificationRequest`，不是 APNs 注册/provider。
因此可以用于后续本地通知；远程推送需另做窄 native bridge 或单独评审远程插件。
注意避免多个插件争抢同一个 notification delegate。
[官方插件文档](https://v2.tauri.app/plugin/notification/)。

## 推荐最小完整切片（待实施）

第一步只实现 **NotificationService + 持久 App 内中心 + fake transport**。
不改 Pi 内核，不增加自动模型调用，不新增 APNs 凭据或真实网络发送。
依赖已有 SQLite Store、event journal、request 和 message lineage。

### 先覆盖三个明确事件

| 类别 | 候选依据 | 默认提案 |
| --- | --- | --- |
| 任务完成 | 原任务下已经核对、提交的最终用户结果，关联 outbox/message ID | 正常优先级；只有 job completed 而无最终结果时不报“任务完成”。需显式结果语义，不能从 turn completed 猜。 |
| 需要用户行动 | 仍 pending 的 question/approval/credential request | 较高优先级；显示“需要你的确认”等最小摘要，点击进入已有待处理页。通知不能直接批准；不把凭据字段/工具参数带到锁屏。 |
| 重要状态变化 | task/reviewRequired 或已核验、获准发布的重要 monitor/research finding | 需要决定/时间敏感时较高优先级；普通进度只进中心。routine/fired 本身不等于有重要发现。 |

第一轮需为最终结果增加可验证的 `completion`/`important_change` 元数据，由 host
校验原始 source、结果记录与通知类别；agent 自报的 urgency 不能绕过主机策略。
已有 pending request / reviewRequired 可确定性接入；不能以模型“我做完了”作证明。

### 最小数据和接口

建议新增 `notification_entries`（持久中心）、`notification_deliveries`（每通道/设备尝试）、
`notification_reads`（用户/会话 read watermark）、`notification_preferences`。
这是派生通知意图，不复制 inbox/outbox 为第二个业务真相。

entry 必须保留：`id, recipientId, runtimeId, sourceMessageId, taskId, sourceRevision,
requestId/resultMessageId, kind, semanticKey, contentRevision, priority, reason,
createdAt, notBefore, expiresAt, status, supersededBy`。recipient 从 host 已验证的
route/owner 解析，不能广播到所有已连接客户端或从任意文本猜用户。

建议协议：`notification/list`、`notification/read`、`notification/preferences` 和
`notification/updated`。都是新增，不改变原 events/ack 的语义。先接现有 Requests
页面和会话跳转，展示已读/待处理/延期/已失效状态；不要另造审批表单。

### 策略、去重与已读

- 稳定 semanticKey 建议由 runtime、收件人、任务 incarnation、类别和结果/request ID
  构成；contentRevision 单调。更新同一 entry，而不是每条 `job/updated` 新建提醒。
- 候选与中心 entry、投递 intent/cursor 同事务提交；事件重放仍只有一份。journal
  cursor 可能过期，届时从 canonical pending requests/results 重建并以 key 去重。
- 优先级用 normal / action-required / time-sensitive，最后一类须有可核对期限与用户
  偏好；不等同于 Apple Critical Alert，也不默认启用 Time Sensitive capability。
- 静默时段使用用户 IANA timezone，不能用主机时区。建议 normal 延后至醒来窗口、
  多任务合并为一次摘要；action-required 可更快但仍尊重静默；越过静默需单独 opt-in。
  “普通最多一天一条”作为可配置起点，需产品选择，尚非实现默认。
- 建议合并窗口 30–60 秒，同任务只保留最新有效版本；不同审批不可合并成一项可执行
  动作。普通未读结果可聚合计数，但每条来源在中心可查。过期审批不进入晨间摘要。
- read 必须在对应通知/消息实际可见或用户明确标记时提交，并持久化；仅收到 SSE、
  socket online、App 前台或 events/ack 都不能标已读。活跃会话 presence 用短 TTL，
  只做短暂延迟提示，不永久吞通知。任一设备已读后可抑制其他设备尚未发出的提醒。

### 取消、替换和过时通知

创建意图、每次发出/重试前、点击读取时都重新校验 source/trigger/request 当前状态。
使用本分支已补齐的 source identity 与 `assertTaskCurrent`；任务版本要从 canonical
control lineage 得出，不用 createdAt 猜。取消/替换/已解决令排队 delivery superseded；
新任务用新 key；request resolved/expired 即使 unread 也不再催办。

**能保证的是禁止发出新的过时通知，不能保证撤回 APNs 已接收的通知。**
APNs 可能延迟或重排；因此锁屏文案宜为“Pibo 有一项更新，打开查看”，不写不可撤销的
“请立刻批准 X”。payload 只带不透明通知/路由 ID 和版本；点击后重新鉴权、同步并
显示最新状态，过时入口不可执行。过期/已读可尽力清理本地 pending/delivered，不能
把 cleanup 当作服务端可远程撤回锁屏通知的承诺。

### 持久 outbox、重试与幂等

现有 conversation outbox 保持原语义；单独建立 notification delivery ledger：
`queued/deferred → sending → provider_accepted`，另有 `retry_wait / uncertain /
expired / suppressed / superseded / permanent_failure`。`readAt` 独立。
APNs 200 只记 provider_accepted，不能记用户收到/看到/完成。

- `(entryId, contentRevision, installationId, transport)` 唯一；attempt 另记，worker
  使用 generation/lease CAS，崩溃恢复只接管过期 lease。主服务已有单进程文件锁可沿用。
- retry 不重新执行原工具，也不重复创建业务消息；每次重试前重跑时效、已读和取消策略。
- 明确失败按 reason 分类：429 TooManyRequests 延迟退避；5xx 依 Apple 当前文档，
  15 分钟后再试并退避。次数与 expiresAt 双重上限，短期审批通常先过期，不应重发。
  410/无效 token 等永久错误停用相应注册；403 配置/鉴权错误停通道等待修复，不狂重试。
- 网络超时或崩溃发生在发送后而确认前，保留 uncertain：APNs 无通用按 apns-id 查询
  并证明未投递的事务接口。只在允许重复提醒的策略下有限重试，否则留中心并待核对。
- 稳定 apns-id 便于关联；apns-collapse-id 可合并、apns-expiration 限制滞留，但均不是
  exactly-once 保证。App 根据 entryId/revision 去重；OS banner 仍有重复/延迟边界。

来源：[APNs 响应与重试](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)、
[发送、合并及过期](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)。

## APNs 的后续架构选择与成本

| 选择 | 可以复用 | 代价/边界 |
| --- | --- | --- |
| 现有常在线 daemon 直接作为 provider（个人使用优先评估） | 现有机器、SQLite、任务有效性/已读策略；只需向 Apple 出站 HTTP/2，不要求手机可从公网打进 daemon | 机器睡眠/离线就不能发送；APNs 私钥保存在此机器；手机经现有可信连接注册 token。无需单为 push 新建 CI 或公有 relay。 |
| 薄 relay 作为 APNs provider（多用户/密钥集中管理） | 可复用确实已有且获准的后端、鉴权、存储 | 当前源码未证实已有可用 relay。需托管、数据库、流量、监控、运维和密钥轮换预算；不能保证免费额度永久够用。relay 只转发，不跑 agent。 |
| 第三方推送托管 | 可能减少 APNs sender 运维 | 新增供应商/SDK、token 数据处理和可能用量费用；选定服务后再核价，当前不建议先引入。 |

独立云 relay 不是 iOS push 的硬性要求，运行中的现有 daemon 可以就是 provider。
但如果源 daemon 休眠且工作也停了，relay 不能凭空知道新结果；若要独立提醒，必须提前
提交/授权事件或迁移相应调度。relay 如有排队，也要具备版本/撤销同步或发送前验证；
无法核实时延后，不向用户投递未经确认的旧动作。仍无法撤回已进入 APNs 的内容。

CI 成本和运行时推送成本分开：此设计不要求付费 CI；可以沿用本地构建/签名发布，
provider 运行、网络/存储及维护则需评估。Apple Developer Program 官方当前为
99 USD/年（地域有差异）；已有 TestFlight 团队资格可复用，但本次未查询账户或签名
能力，不新增/购买任何服务。无需为了这轮设计调用模型。
[Apple 会员说明](https://developer.apple.com/programs/enroll/)。

## 后续接真实推送前的具体授权点

1. 确定 provider 部署位置及可接受的离线延迟；若 relay，确认域名、持有方、托管预算
   和授权范围。当前没有启用或创建任何服务。
2. 在实际 iOS App ID/签名团队启用 Push Notifications，生成匹配 profile/entitlement；
   provider 使用授权的 APNs key 或证书，明确 Key ID/Team ID/topic、环境与轮换责任。
   不从现有发布凭据中自行提取密钥，不把 key 打包到 App。
3. 用户在 App 中自愿开启系统通知；原生接收 registration 回调、更新 token，经已配对
   的认证通道注册/撤销。token 不是授权凭据，需绑定安装实例/收件人/runtime/topic/
   environment，不允许任意设备 token 注入、跨 runtime 发送或日志泄露。
4. 选择 token 保存位置、访问范围、保留/注销规则；先凭 fixture 验证，再单独授权
   真机测试 token 上传和测试通知目标。
5. 如确需 silent background refresh，再增加 Background Modes；不要为普通 alert
   顺手开启后台执行、Critical Alerts、Time Sensitive 或新的持久网络访问。

[Apple 注册与 entitlement](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)、
[provider 建立](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server)、
[请求通知许可](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)。
后续改动须同时覆盖受版本管理的 XcodeGen 配置、实际工程/entitlements 与 release
复制脚本；只改临时发布目录不可复现。

## 最小切片验收计划（尚未执行）

全部使用虚拟时钟、SQLite、fixture 和 fake sink，付费模型请求为零。

- 同一 request/result 的重复事件、SSE replay、服务重启只生成一条中心记录；同 taskId
  不同 runtime/用户/thread 不串通知；event cursor 过期可重建而不重复。
- job complete 不误报任务完成；核验最终结果才生成 completion；quiet memory job
  不打扰；pending request 生成行动项，resolved/expired 后抑制。
- IANA 静默时段含 DST 跨日，合并窗口/频率上限、延期后到期剔除；重要事件不能靠
  模型自报升级来绕过偏好。
- read 与 events/ack 分离；跨设备已读抑制待发，断线/后台没有假已读；当前可见会话
  不重复提示，presence 过期后恢复决策。
- 取消/替换分别发生在候选产生前、延期中、发送前、429重试前、provider已接收后；
  前四者不发过时通知，最后者验证点击只读到最新状态、不执行旧审批。
- fake 200/400/403/410/429/5xx、超时、进程崩溃点（事务前后、发送后确认前）、lease
  竞争和过期：状态准确，重试有界，不重跑业务动作，不把 accepted 当 read。
- 点击去原 thread/待处理项；错误 runtime/token/topic/env 拒绝；payload、日志和锁屏
  不含凭据/原始参数；token 轮换/注销仅影响对应注册。
- 实现后跑既有 `npm run check`、`npm test`；新增通知 fixture suite。真正 APNs
  entitlement/设备权限/前台后台/锁屏/Focus/失联/点击重连另需授权真机矩阵验证。

本轮实际完成：最新 draft fetch、源码检查、Apple/Tauri 官方文档核对和本提案。
没有新增推送代码、schema、系统权限、APNs key、device token、远程通知、部署或网络
配置。本地 `work/push-research/` 保存官方 Markdown 读取证据（不包含用户数据）。
