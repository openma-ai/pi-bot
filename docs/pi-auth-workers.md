# Pi 原生认证与独立 coding workers

2026-10-13 的 GUI / CLI 更新。

## 配置与认证

模型由 Pi 的 `SettingsManager` 读取全局 `~/.pi/agent/settings.json` 和项目 `.pi/settings.json`；目录遵循 Pi 自己的 `getAgentDir()`。`defaultProvider` 和 `defaultModel` 必须成对有效。Pi `ModelRuntime` 读取原生 `models.json` 与 `auth.json`，负责标准环境变量解析、认证和 OAuth 刷新。没有复制密钥到 bot 目录，没有重新实现 OAuth。

移除本项目 `PI_BOT_PROVIDER` / `PI_BOT_MODEL` 选择，以及 GUI 的 `DEEPSEEK_API_KEY` 优先覆盖和自动 DSH 凭据兜底。Pi 自身支持的标准配置行为仍由 Pi 管理。运行目录、监听端口、有限评估预算相关设置保留；这是运行配置，不是另建认证系统。

先在正常 Pi 交互界面 `/login` 认证、`/model` 选模型，再启动/重启 `npm run gui` 或 `npm start`。未配置时 GUI 仍能查看现有 bot 和消息，提交任务明确返回配置错误。配置错误不会触发备用 provider，也不会要求在聊天中发送 key。GUI 当前复用已有认证，不提供自己的 OAuth 登录界面。

本机只检查了 SDK 配置元数据：`~/.pi/agent` 存在 auth/settings 文件，但没有默认 provider/model，SDK 未列出保存的 credential。因此新功能没有真实 API 成绩；没有迁移、写入或输出本机凭据。

## 重活派发

每个 GUI / CLI bot 注册 `subagent` extension 工具：`task`、稳定 `key`、必要时 `source_message_id`。它验证原始宿主任务，使用现有 `startJob` 持久化机制返回 receipt，并创建独立 `createAgentSession`，复用同一个 ModelRuntime、模型及认证。子会话只含原始宿主任务与派发内容，不复制私聊/群聊历史；工具调用和结果保存原生 session，脱敏 tool_call/tool_result 使用既有 trace。

Pi 自带 subagent 示例位于已安装包的 `examples/extensions/subagent/`。它同步等待并在父回合 abort 时杀子进程，因此没有原样全局安装。本项目以本地 Pi extension 注册异步工具，直接复用 Pi coding SDK 的 coding tools/session；没有第三方进程或替代 agent。

worker 位于对应会话的 `workers/<stable hash>/`，文件任务默认在那里执行。它没有 send_message、send_to_bot 或递归 subagent 工具，不自动加载用户/项目第三方扩展或上下文文件。父 bot 通过 job 完成 inbox 被唤醒，读取 `job_result`，核查后用 send_message 回应用户。子任务不能自行改变回复路由。

同一 bot 最多一个在运行的 coding worker，重复 key 与相同任务返回已有 job；冲突拒绝。全局原有 job 数限制仍生效。每子任务最多 16 请求、总时间 10 分钟、单请求 10 分钟、最多 16,384 输出 token，禁用 provider 自动重试；GUI 父/子会话共用 32 请求、384k 输入预留及 60 分钟期限，不另开隐形预算。子会话禁止同步压缩，不使用任意裁剪。

父 bot 的推理被新消息中断不会取消子 job。工具执行前再次验证任务有效性和宿主 permission hook；失效后的新工具被拦截。已启动的工具不因父消息取消；最终结果再验证任务有效性，过时结果不能通过父 bot 发出。worker 总期限终止的是该独立会话，不是父 bot 的推理控制器。进程崩溃后 jobs 保持现有 uncertain 语义，不自动重跑文件操作。

CLI 使用同样的 native Pi 配置与 subagent；CLI 没有 GUI 整轮共享预算，但每 worker 仍有自身有限请求/时间限制。

## 验证

测试覆盖原生配置与 API-key fixture 认证解析、自定义模型环境变量不生效、半配置拒绝；独立 SDK coding worker 真实 write/read；工具执行前失效拦截；重复派发只产生一个持久 job；子工作尚未完成时父 bot 能发送新用户任务的回复。Provider 使用 faux，因此这是离线原生 SDK/工具验证，不是 DeepSeek、OAuth 登录或真实 API benchmark。

复现：`npm run check`；`node --import tsx --test test/pi-config.test.ts test/coding-worker.test.ts`；`npm test`。完整离线测试 **170/170 通过**，TypeScript 检查和 GUI 构建通过。最后完整测试日志在忽略的 `work/gui/pi-auth-worker-tests.log`。真实 API 验收需要有效的 Pi 默认模型及认证；此前 OpenMatter smoke 不可替代本次结果。
