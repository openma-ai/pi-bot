# Linux 桌面与共享浏览器镜像

使用现成 Pi 插件，不自行实现 browser/computer 操作引擎：

- `pi-chrome-use@1.1.1`：连接现有 Chromium，执行页面导航、页面 JS 和截图。
- `@agent-sh/computer-use-linux@0.7.16`：Pi 原生窗口识别、激活、状态、截图和键鼠工具。
- `@novnc/novnc@1.7.0`：网页实时画面与人工接管。

镜像是现有 Pi Bot GUI 的桌面伴随服务；GUI / 主 agent 保持在宿主运行。镜像内同时包含当前项目和 Pi SDK，但不复制宿主 Pi 凭据，不自行安装模型认证。桌面工具通过原生 Pi tool chain 执行；内部 faux provider 只用于把宿主授权的 RPC 编排成原生 tool call，不调用模型 API，也不替代主 bot 的模型。

## 共享 profile 与归属

一个 Chromium 进程，一个 `/data/profile`，所有 bot 窗口处于同一个默认浏览器 context。cookie、localStorage 和登录态实时共用，不复制 profile，不为每个 bot 另开 user-data-dir。profile volume 使用独占 flock；第二个 runtime 不能同时使用这个目录。重启时只在持有独占锁后清理 Chromium 过期 Singleton 锁，保留 profile 数据。

Linux Xvfb 根桌面为 5120×900，分成四个 1280×900 的固定虚拟屏幕区域，并注册 RandR monitor 名称。它们是同一 X session 的区域，不是四台隔离机器。宿主维护 botId → CDP targetId → X11 windowId → 屏幕矩形。每个已分配窗口固定在自己的区域；调用和截图检查并维护位置，不依赖当前活动窗口。未知、关闭或错属窗口拒绝，不能回退到任意活动窗口。进程重启后重新绑定窗口 ID，保留共享 profile。

agent 的 `desktop_list` 返回自己的归属及插件 schema，`desktop_call` 用原生插件操作该窗口。浏览器调用只提供 navigate/evaluate/screenshot，JS 在所绑定页面执行，不开放任意服务端 Node snippet。插件 CDP session 的 target 选择受归属限制；浏览器全局操作拒绝。Computer 操作自动绑定 window_id，输入前用原生插件激活窗口，并检查实际焦点。窗口识别结果只向 agent 返回它自己的窗口。

所有桌面输入经过同一串行队列，因为键盘焦点在一个 X session 内共用。主 bot 和社区 coding worker 都复用此入口及任务/权限检查；coding worker 不另外加载不受归属控制的桌面插件。

这是合作式 bot 的操作路由保护，不是恶意租户隔离：共享 profile 本来就共享登录权限，同一容器/X session 不提供独立账户或 OS 安全边界。初版只管理分配的 Chromium 主窗口，不声称任意弹窗、其他应用或跨引擎 profile 已完整验收。

## noVNC 与 Take over

前端单 bot 详情的 Computer tab 展示真实屏幕缩略图；Open 放大成 noVNC 直播。默认 Watching；Take over 激活该窗口并启用对应 VNC server 的输入，其他屏幕保持 view-only，agent 桌面调用暂停。Return control 恢复 view-only 并允许 agent 继续。接管租约最长 60 秒，前端每 20 秒续约；断线后到期自动归还。其他 bot 也暂缓桌面动作，避免全局焦点竞争；普通后台计算不因此取消。

每屏用独立 x11vnc `-clip` stream。WebSocket 经现有 GUI 同源代理；Origin 和 HttpOnly GUI cookie 校验，内部 RPC 使用运行时随机 bearer token。只发布 Docker `127.0.0.1:6090`，CDP、X11 和原始 VNC 端口不发布。token 保存在忽略的 runtime 文件，不进入聊天、报告或镜像。该设置面向本机单用户，不是公网多用户鉴权方案。

## 构建 / 运行

Docker 需要已运行，Node 24+ 用于宿主 GUI。

```sh
docker build -f container/Dockerfile -t pi-bot-desktop:local .
./container/run-local.sh
npm run gui
```

若已有 GUI 监听 4317，先检查其运行任务并正常重启，不能重复起两个实例。若 `pi-bot-desktop` 已存在，检查并使用/停止现有容器；启动脚本不强删容器或 profile volume。

GUI 继续读取本地 Pi settings/auth。本机 Pi 缺默认模型时仍能看屏幕、人工接管，但不能冒充真实模型任务已执行。桌面连接文件为 `work/gui/desktop/control.json`；profile 在 Docker volume `pi-bot-desktop-data`。

基础镜像采用 Node 24.18.0 / Debian trixie，满足插件 Linux arm64 二进制所需的 glibc 2.39+。Bookworm 的初次构建不能运行这个二进制，失败日志保留。当前在 Docker Linux arm64 验收；不声称 amd64 构建也已测。

Chromium 在 Docker 内使用 no-sandbox；容器不能运行 privileged、不挂载 Docker socket或宿主 home。不要把本机访问配置直接用于公网。依赖及插件许可证留在镜像 node_modules；构建上下文排除 work、数据库、node_modules 和 .env。

## 验收 / 证据

```sh
node scripts/test-desktop-image.mjs [BOT_A_ID BOT_B_ID]
```

该脚本对真实镜像里的 Chromium 与原生 Pi 插件执行：两窗口共享新写入的 cookie/localStorage；先焦点 B 后输入 A，检查 B 未改变；错属 windowId 拒绝；人工接管时 agent 拒绝，归还后恢复；原生鼠标点击后读回页面结果；两屏真实 PNG 不同。文件在忽略的 `work/gui/desktop/evidence/`，不能把它当作模型行为成绩。

完整离线测试与类型/GUI 构建另外验证。前端通过实际 noVNC 键盘导航到本地 fixture，并读回所绑定 target 的页面标题；不是静态截图演示。最终镜像以无源码 bind mount 的容器复测，镜像 ID、架构和各验证结果记录在该目录的最终报告。

本机尚无可用 Pi 默认模型配置；这一轮是实际 Linux / 浏览器 / 插件 / noVNC 验收，未新增真实模型 API 成绩。

最终复测：2026-10-13，174/174 离线测试通过，类型检查及 GUI 构建通过；镜像内 7 项实际桌面断言通过。补测发现需设置标准 `XDG_SESSION_TYPE=x11`，否则社区插件鼠标误选 ydotool 后端；已经修正，并将插件返回 `ok:false` 识别为错误。坐标调用限定本 bot 的区域，跨窗口选择与全桌面截图被拒绝。
