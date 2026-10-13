# Pi 原生认证与独立 coding workers

2026-10-13 的 GUI / CLI 更新。执行内核现已采用社区 `nicobailon/pi-subagents@0.77.0`，锁定 npm 版本与完整性，不再使用自写的子会话执行流程。

## 配置与认证

模型由 Pi 的 `SettingsManager` 读取全局 `~/.pi/agent/settings.json` 和项目 `.pi/settings.json`；目录遵循 Pi 自己的 `getAgentDir()`。`defaultProvider` 和 `defaultModel` 必须成对有效。Pi `ModelRuntime` 读取原生 `models.json` 与 `auth.json`，负责标准环境变量解析、认证和 OAuth 刷新。没有复制密钥到 bot 目录，没有重新实现 OAuth。

移除本项目 `PI_BOT_PROVIDER` / `PI_BOT_MODEL` 选择，以及 GUI 的 `DEEPSEEK_API_KEY` 优先覆盖和自动 DSH 凭据兜底。Pi 自身支持的标准配置行为仍由 Pi 管理。运行目录、监听端口、有限评估预算相关设置保留；这是运行配置，不是另建认证系统。

现在可直接在 GUI「Pi 登录与模型」中通过原生 Pi 登录、选择默认模型及思考强度；保存后等待已有工作空闲自动应用。也可在 Pi 交互界面使用 `/login` 与 `/model`。未配置时 GUI 仍能查看现有 bot 和消息，提交任务明确返回配置错误。配置错误不会触发备用 provider，也不会要求在聊天中发送 key。GUI 连接原生 AuthInteraction，展示 provider 的 OAuth URL/device code/选项/manual code，秘密输入走独立私有 HTTP 表单，绝不经过 RPC 或事件。

历史检查（配置前）：本机只检查了 SDK 配置元数据：`~/.pi/agent` 存在 auth/settings 文件，但没有默认 provider/model，SDK 未列出保存的 credential。因此新功能没有真实 API 成绩；没有迁移、写入或输出本机凭据。

## 重活派发

每个 GUI / CLI bot 注册 `subagent` extension 工具：`task`、稳定 `key`、必要时 `source_message_id`。它验证原始宿主任务，使用现有 `startJob` 持久化机制返回 receipt，交给社区 `runSync` 执行流程和 `createDefaultChildSessionFactory` 创建独立原生 session，复用同一个 ModelRuntime、模型及认证。子会话只含原始宿主任务与派发内容，不复制私聊/群聊历史；工具调用和结果保存原生 session，脱敏 tool_call/tool_result 使用既有 trace。

Pi 自带 subagent 示例位于已安装包的 `examples/extensions/subagent/`。它同步等待并在父回合 abort 时杀子进程，因此没有原样全局安装。本项目以本地 Pi extension 注册异步工具，执行端已替换为社区 pi-subagents 的执行内核；没有全局安装完整社区 extension。薄适配层通过它的每次运行 childSessionFactory 注入现有 Pi SDK、认证和安全钩子，不修改社区包源码，也不全局覆盖其 factory。社区独立 runner、自己的通知/恢复队列与递归/工作流界面未启用，以免和现有 jobs/inbox 重复管理。

社区执行端使用受控 worker profile，fresh context；不进行全局/项目 profile 自动发现。worker 位于对应会话的 `workers/<stable hash>/`，文件任务默认在那里执行。它没有 send_message、send_to_bot 或递归 subagent 工具，不自动加载用户/项目第三方扩展或上下文文件。父 bot 通过 job 完成 inbox 被唤醒，读取 `job_result`，核查后用 send_message 回应用户。子任务不能自行改变回复路由。

同一 bot 最多一个在运行的 coding worker，重复 key 与相同任务返回已有 job；冲突拒绝。全局原有 job 数限制仍生效。每子任务最多 16 请求、总时间 10 分钟、单请求 10 分钟、最多 16,384 输出 token，禁用 provider 自动重试；同一 worker 第二次 child launch 被拒绝，阻止社区 abort recovery 自动重新执行；GUI 父/子会话共用 32 请求、384k 输入预留及 60 分钟期限，不另开隐形预算。子会话禁止同步压缩，不使用任意裁剪。

父 bot 的推理被新消息中断不会取消子 job。工具执行前再次验证任务有效性和宿主 permission hook；失效后的新工具被拦截。已启动的工具不因父消息取消；最终结果再验证任务有效性，过时结果不能通过父 bot 发出。worker 总期限终止的是该独立会话，不是父 bot 的推理控制器。进程崩溃后 jobs 保持现有 uncertain 语义，不自动重跑文件操作。

CLI 使用同样的 native Pi 配置与 subagent；CLI 没有 GUI 整轮共享预算，但每 worker 仍有自身有限请求/时间限制。

## 验证

测试覆盖原生配置与 API-key fixture 认证解析、自定义模型环境变量不生效、半配置拒绝；独立 SDK coding worker 真实 write/read；工具执行前失效拦截；重复派发只产生一个持久 job；子工作尚未完成时父 bot 能发送新用户任务的回复。Provider 使用 faux，因此这是离线原生 SDK/工具验证，不是 DeepSeek、OAuth 登录或真实 API benchmark。

复现：`npm run check`；`node --import tsx --test test/pi-config.test.ts test/coding-worker.test.ts`；`npm test`。完整离线测试 **172/172 通过**，TypeScript 检查和 GUI 构建通过。最后完整测试日志在忽略的 `work/gui/community-subagent-tests.log`。真实 API 验收需要有效的 Pi 默认模型及认证；此前 OpenMatter smoke 不可替代本次结果。

## 固定版本的适配边界

依赖 `pi-subagents: 0.77.0` 及 lockfile，源码 gitHead `1ac9b964eb9cda1662507c52f5277764637daccc`。调用其包内 execution/child-session 模块，这是内部接口，升级必须跑兼容回归。`src/pi/coding-worker.ts` 是宿主桥，不复制社区实现；保留 SDK 请求包装用于预算、超时和脱敏错误，保留工具 guard 用于权限/任务状态。权限拒绝即使模型随后声称成功，也将 job 标为失败。

本轮社区真实执行内核的离线原生工具验收覆盖 write/read、结果返回、重复 key、父 bot 继续回复、失效写入拦截、共享请求预算耗尽不重放文件写入及权限拒绝不能伪报成功。暂不证明 detached runner 跨进程存活、社区全部工作流或真实 API。当前无需 fork；若未来需要稳定公开 factory hook，可以把这个小接口作为上游改动或维护固定 fork。

2026-10-14：已按用户明确授权通过 Pi 原生认证保存已有本地 DeepSeek key，设置官方 Flash 别名和 high thinking。真实 GUI、恢复、定时、监控、群聊与交接的 36 个实际请求及诊断记录见 [新交接](design/app-server-implementation-20261014.md)。没有产品级自动 DSH 回退；上面的 172 项测试与“缺少认证”描述是当时状态。

2026-10-14 追加真实社区 worker 验收：pi-subagents@0.77.0 独立原生会话计算并写入/读回 527，单一 job 和用户结果送达通过。详见 design/app-server-implementation-20261014.md。正常 GUI 已移除累计请求、输入、费用和一小时限制；保留单次超时和防循环保护。
