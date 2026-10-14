# Pi 官方 bash 沙箱

pi-bot 的真实 Pi daemon 默认加载 Pi v1.1.0 的官方 sandbox **示例扩展**，不是另写一套安全系统。
实现来自 [官方源码](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/examples/extensions/sandbox/index.ts)，
依赖按上游固定为 `@anthropic-ai/sandbox-runtime@0.0.26`。Pi 源码为 MIT，许可证保存在 `vendor/pi-sandbox/LICENSE`；runtime 自带 Apache-2.0 许可证。

## 启用与配置

1. 在更新后的 checkout 运行 `npm ci`（Node 24+）。不需要改 Pi 登录、模型或 API 凭据。
2. macOS 使用系统 `sandbox-exec`。Linux 需要已安装的 `bubblewrap`、`socat`、`ripgrep`；本变更不自动安装系统组件、不更改宿主权限或容器选项。
3. 审阅 `examples/sandbox.json`，按需要复制为启动目录的 `.pi/sandbox.json`，填写实际绝对路径。没有该文件时使用官方默认配置。
4. 重启 daemon。首次会话启动时 stderr 出现 `[sandbox:info] Sandbox initialized` 才表示初始化成功；没有消息不能当作启用证明。检查警告和失败信息。

配置合并顺序：官方默认值 → `~/.pi/agent/extensions/sandbox.json` → `<配置目录>/.pi/sandbox.json`。
`PI_CODING_AGENT_DIR` 会影响官方 `getAgentDir()` 返回的全局位置。
配置目录是 daemon 的 `piOptions.cwd`（若指定），否则为启动进程的 cwd，不是每个 bot 的 session 目录。
数组是替换，不是追加。相对文件路径统一按配置目录解析；`~` 仍由官方 runtime 处理。
同一 daemon 内所有会话共享一份配置。修改后重启 daemon，不支持运行中热改沙箱规则。

官方默认允许写启动目录和 `/tmp`；禁止读取 `~/.ssh`、`~/.aws`、`~/.gnupg`；
禁止写 `.env`、`.env.*`、`*.pem`、`*.key`；网络允许官方示例列出的 GitHub/npm/PyPI 等域名。
若 session/data 目录位于启动目录之外，需要明确加入 `filesystem.allowWrite`，不要为了跑通直接放开整个主目录。
例子额外禁止 bash 读取默认 Pi `auth.json`/`models.json`，但不会移动、读取或改写已有凭据。
自定义 Pi agentDir、app 数据库或其他凭据文件，需要把它们的实际路径加入 denyRead。

禁用：在 `.pi/sandbox.json` 设置 `{"enabled": false}` 后重启。pi-bot daemon 不透传 Pi CLI 的 `--no-sandbox`；不要向 daemon 传这个参数。
SDK 直接使用 `piSessionFactory` / `runCodingWorker` 时，传入 `createSandboxHost({ cwd })` 返回的 `sandbox`，关闭所有相关会话后调用 `await sandbox.dispose()`。

## 覆盖范围和重要限制

- 覆盖原生 bash、后台 bash、codemode 通过工具调用的 bash，以及内置 coding worker 的 bash。
- 保留官方 `user_bash` 钩子；在支持 Pi `!command` 的会话中同样包装命令。pi-bot 聊天 UI 不因此新增 `!command` 功能。
- **不覆盖 read/write/edit/grep/find/ls、桌面/浏览器工具、任意扩展自己的 I/O、daemon 自身或模型网络请求。** 这些路径不能据此宣称已隔离。
- **保留官方 fail-open 行为**：配置 disabled、不支持的操作系统、初始化失败时，bash 退回普通执行。stderr 明确报告原因；这不是 fail-closed 安全边界。运行中包装/执行失败不会自动重试成普通 bash。
- 默认 `.env` 规则是禁止写，不是禁止读；路径规则也不会清除已继承的环境变量。不要把它当凭据隔离或防泄漏保证。
- 对不可信代码或强隔离需求，仍需单独容器/VM 与最小权限。这里的目标是使用现成官方扩展做尽力限制。

## 与上游的必要适配

`src/pi/sandbox-upstream.ts` 保留官方默认配置、合并逻辑、命令包装、user_bash、失败回退和状态命令。
只加了宿主注入的会话 cwd、固定配置 cwd、manager 和日志回调。
`src/pi/sandbox.ts` 通过 Pi ExtensionFactory 注册它：后台执行层包装官方 bash，而不是被另一个普通 bash 覆盖。
各 coding worker 独立加载扩展，但共享进程级 runtime 初始化；一个会话关闭不会 reset 仍在运行的同伴。
最后一个 host 释放时才清理 runtime。原生 Pi 登录、认证刷新、用户模型设置和 provider 请求链路没有修改。

测试使用假 provider、假 sandbox manager 和无敏感内容的临时目录，覆盖真实 Pi 扩展装载、后台/worker 路由、cwd、共享生命周期、禁用及初始化失败回退。
这些测试不是 OS 拦截验收。目标机器仍需用虚构文件和测试域名验收；不要拿真实密钥做测试。
