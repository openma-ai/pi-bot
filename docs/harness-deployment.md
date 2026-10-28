# Harness：本机安装与 Docker 部署

这里部署的是同一个真实 Pi harness（`src/daemon/main.ts daemon`），包含持久会话、模型设置和本地网页，不是演示执行器。桌面 App 随包 harness 由 App 管理；本页是独立机器/服务器的安装方式。不要让两个入口共用数据目录。

## 支持范围与准备

- 用户进程安装支持 macOS、Linux，要求可信来源的 Node.js **24+**（本项目验证版本 24.18.0）、npm，以及已审阅的本项目源码 checkout。Windows 原生安装尚未验证，可使用 Docker 的 Linux 容器流程。
- Docker Engine/Desktop 与 Compose v2；headless Dockerfile 使用 Node 24.18.0 / Debian bookworm，同一 `package-lock.json`。可选 Linux computer-use/VNC 镜像仍是 [原有 Dockerfile](../container/Dockerfile)（trixie），不要混淆能力。
- 安装需要依赖下载与足够磁盘（至少为每个版本预留 1 GiB；备份另按真实数据大小计算）。不要在磁盘不足时自动 prune 或删除其他容器/目录。
- 不需要 root、系统 TUN、宿主 Docker socket 挂载、系统服务或防火墙修改。脚本不安装 Node，不接管系统 VPN、DNS、代理，不自动登录 Tailscale。
- 不挂载个人 home、现有 Pi 认证目录或其他 runtime 卷。每套安装均有独立 `var/pi`、`var/runtime`、`var/home`、`var/workspace`。启动清除继承的 provider keys、`NODE_OPTIONS` 和全局 Pi 环境；在应用设置中为此实例配置模型。

## 在现有机器安装

在可信源码目录运行；路径可自定，首次目标必须为空，源码与安装目录不能相互嵌套。不要用 sudo。

```sh
export PIBO_INSTALL="$HOME/.local/share/pibo-harness"
node deploy/harness.mjs install --source "$PWD" --root "$PIBO_INSTALL"
node deploy/harness.mjs start --root "$PIBO_INSTALL"
node deploy/harness.mjs health --root "$PIBO_INSTALL"
```

默认只监听 `http://127.0.0.1:4318`；若端口已占用，**先停止此实例**，编辑 `$PIBO_INSTALL/config.json` 的 `port` 后再启动，不停止占用端口的其他应用。安装只复制源代码、锁文件和构建产物，`npm ci --ignore-scripts` 后只执行项目内 bridge patch 与 GUI build。完整缓存场景可加 `--offline`；维护者已执行 `npm ci --ignore-scripts`、`npm run prepare:background`、`npm run gui:build` 的同平台 checkout 可显式用 `--prepared` 复制该构建（不重新解析依赖）。`release.json` 记录锁文件 SHA-256、Node 版本及是否 prepared；prepared 不是发布签名。

保存源码 checkout，以后仍用其中的 `node deploy/harness.mjs ...` 管理。安装目录无需加入 PATH，也不会开机自启。其目录如下：

| 路径 | 用途 |
| --- | --- |
| `releases/<id>` | 每次独立安装的代码/依赖/GUI；不在原目录覆盖升级 |
| `install.json`, `config.json` | 当前版本指针和非秘密监听配置 |
| `var/runtime` | SQLite、事件、会话及服务认证记录；整体持久化 |
| `var/pi` | 本实例模型配置与凭据；不能进入仓库、日志或镜像 |
| `var/workspace` | agent 工作目录；不是源码目录 |
| `logs/server.log` | 启停/错误日志；分享前人工检查与脱敏 |
| `backups/<id>` | 停机快照，含私密数据；按凭据同级保护 |

新目录以 0700/0600 创建。`start` 等待真实 `/readyz` 并查询真实 daemon status；缺模型时会明确输出 `setupRequired: true` 和配置入口。健康检查通过仅代表 harness 可服务，不代表模型凭据可用，不会为了检查发起收费请求。打开打印出的本地 URL → 设置 → Pi 登录与模型，由用户输入自己的凭据/完成登录并选择模型。不要把密码、API key 放入命令行或 `config.json`；不要把旧 `auth.json` 复制到镜像。模型功能授权与服务登录是两件事。

```sh
node deploy/harness.mjs status --root "$PIBO_INSTALL"
node deploy/harness.mjs stop --root "$PIBO_INSTALL"
node deploy/harness.mjs backup --root "$PIBO_INSTALL"  # 必须先停止，输出快照 ID
# 在另一个已审阅的新版本 checkout 中运行；旧安装必须停止：
node deploy/harness.mjs upgrade --source "$PWD" --root "$PIBO_INSTALL"
node deploy/harness.mjs start --root "$PIBO_INSTALL"
```

升级先构建独立版本，成功后对旧数据制作停机快照，再切换指针；失败构建不会替换当前版本，但为排障保留未完成版本目录。停止会等待最多 45 秒，不强杀不认识的 PID。活跃任务是否可继续由 runtime 自身恢复策略决定，不重放未确认的外部副作用。

回滚必须明确选择升级输出的备份 ID，恢复**那个版本和同时刻的数据**；不能保证旧代码读取新数据库格式。升级后的新消息不会合并进旧快照，但回滚前的完整新数据另存为新快照，并保留 `replaced-var`。回滚和升级均不会自动启动服务。

```sh
node deploy/harness.mjs stop --root "$PIBO_INSTALL"
node deploy/harness.mjs rollback --root "$PIBO_INSTALL" --backup BACKUP_ID
node deploy/harness.mjs start --root "$PIBO_INSTALL"
```

卸载先停机，`uninstall` 只移除本安装识别的代码版本，保留 `var`、配置、日志与备份。它不会删除个人数据、系统 Node、其他 runtime 或系统服务；如需永久销毁数据，用户检查准确目录及备份后自行处理。未完成/未知版本会阻止自动移除，要求人工核对。

```sh
node deploy/harness.mjs stop --root "$PIBO_INSTALL"
node deploy/harness.mjs uninstall --root "$PIBO_INSTALL"
```

原有 `scripts/install-linux-service.sh` 是可选 Linux 桌面 systemd 流程，会立即 enable 服务；它不属于这里的默认安装，未获得主机服务授权时不要执行。

## 连接与服务认证

本地 daemon HTTP 仅 loopback，同一用户浏览器可配置。不要将 4318 用 `0.0.0.0`、端口代理或公网映射暴露；它不是远端服务认证入口。远端原生客户端使用以下认证网关：

- Tailnet：用户主动加入的私有网络，客户端 SDK 走加密 Tailnet transport，地址为该节点 `100.x.x.x:4319`。
- 直连 HTTPS：已有受信任证书的 TLS 反代，配置 `serviceOrigin`，客户端验证证书；不是任意远端明文 HTTP。
- 普通浏览器不能直接使用原生 SDK，也不能绕过网关的 Origin 检查。这里的本地网页仅在安装机器浏览器使用；远端使用原生 App。

当前网关沿用显式 Tailnet address + loopback Serve 协议。`config.json` 中可加 `"tailnetAddress": "实际节点IPv4:4319"`（必须真实 `100.64.0.0/10` 地址），此时网关只监听 **127.0.0.1:4319**。它不会自动创建 Tailscale 服务，也不会改变宿主路由。然后由用户在该机器自己的终端运行：

```sh
node deploy/harness.mjs password --root "$PIBO_INSTALL"
```

密码在终端隐藏输入两次，12–512 bytes，不接收 argv/env；服务只存加盐 scrypt hash。更换密码会撤销旧会话与配对。远端客户端还需输入这个服务密码，Tailscale 网络登录不能代替它。完整协议见 [服务密码说明](clients/DIRECT-PASSWORD.md)。

## Docker：同一 harness + userspace Tailnet

`container/Dockerfile.harness` 是无桌面 headless 镜像，**不声称支持 computer use/VNC**。默认无 host ports、不使用宿主网络、不挂载 Docker socket。Compose 复用已验证的 Tailscale **v1.104.1 userspace sidecar**，自己的 state 卷与 harness 卷分开，不要求宿主加入 Tailnet。镜像依赖从 lockfile 构建，首次下载需由执行命令的用户批准其网络与来源。

当前 Computer Use companion 仅适配 Linux X11；macOS/Windows 本机能力不能当作已支持。即使安装了可选 Linux 桌面镜像，也要以 companion 的 supported / configured / ready 探测结果为准；没有 companion 时不会自动安装或开启 VNC。AT-SPI 不可用时，只能声明已验证的坐标输入，不能把 `ready` 解释为语义控件选择器也可用；详见 [能力探测说明](harness-capabilities.md)。

所有示例使用新的项目名 `pibo-personal`；部署第二套请换名字。不要复用已有 `pibo-tailnet-test` 名称/卷，不运行 `down -v`。

```sh
# 创建一个非秘密配置文件（先只有本地端口，不会启动远端入口）
mkdir -p "$HOME/.config/pibo-harness"
cp deploy/harness.example.json "$HOME/.config/pibo-harness/harness.json"
export PIBO_HARNESS_CONFIG="$HOME/.config/pibo-harness/harness.json"
export PIBO_HARNESS_IMAGE=pibo-harness:YOUR_REVIEWED_REVISION
docker compose -p pibo-personal -f deploy/compose.yaml build harness
docker compose -p pibo-personal -f deploy/compose.yaml up -d tailnet
# 下面是用户主动网络授权步骤；自行打开命令给出的登录链接，禁止把 auth key 写到仓库：
docker compose -p pibo-personal -f deploy/compose.yaml exec tailnet tailscale --socket=/tmp/tailscale.sock up --accept-dns=false
docker compose -p pibo-personal -f deploy/compose.yaml exec tailnet tailscale --socket=/tmp/tailscale.sock ip -4
```

把输出的真实 IPv4 加入配置：`"tailnetAddress": "100.x.x.x:4319"`（用真实地址替换），保留 `port: 4318`。然后：

```sh
docker compose -p pibo-personal -f deploy/compose.yaml up -d harness
```

管理命令如下（显式 tsx 和隔离目录）：

```sh
docker compose -p pibo-personal -f deploy/compose.yaml exec harness node --import /app/node_modules/tsx/dist/loader.mjs /app/src/daemon/main.ts status --data-dir /data/runtime
docker compose -p pibo-personal -f deploy/compose.yaml exec harness node --import /app/node_modules/tsx/dist/loader.mjs /app/src/daemon/main.ts service-password --data-dir /data/runtime
# 密码设置成功后才主动开放 Tailnet TCP Serve（不启用 Funnel）：
docker compose -p pibo-personal -f deploy/compose.yaml exec tailnet tailscale --socket=/tmp/tailscale.sock serve --bg --tcp=4319 tcp://127.0.0.1:4319
docker compose -p pibo-personal -f deploy/compose.yaml ps
```

用原生 App 的 Tailscale 设置登录，再连接 `真实IPv4:4319`，输入服务密码，在模型设置中配置此远端 harness 的模型。不要将 `/data/pi` 替换为宿主凭据。Docker health 只探测 `/readyz`；上面 `status` 才同时显示模型是否待配置。

容器使用 uid/gid 1000 的 node 用户，首次 named volume 由镜像的 `/data` 所有者初始化；已有错误 owner 的目录应由部署者确认后单独修复，不在启动脚本中自动 chown 用户目录。`harness-data` 保存整个 `/data`，含 runtime、模型配置、home 与 workspace；`tailnet-state` 只保存网络身份。`docker compose stop` 和 `down`（**不加 `-v`**）均不删除卷。

## Docker HTTPS、升级与回滚

已有 TLS 反代时，配置 `serviceOrigin: "https://pibo.example.com"`，保留真实 `tailnetAddress`。反代必须与网关共享可达的私有网络命名空间、保持精确 Host、透传 SSE 与 WebSocket；保留浏览器 Origin（网关会拒绝它），不能删除 Origin 来绕过校验。不要直接公开本地 owner HTTP。当前 Compose 不自动安装/发布反代、证书、Serve HTTPS、Funnel 或端口；具体公共入口由运营者另行授权配置。单纯写 `serviceOrigin` 不会产生证书/可达服务。

升级前记录旧镜像 tag **和 image ID**，停止 harness，给两个 named volume 做受保护的离线快照，保留原文件权限与 uid/gid；不要复制运行中的 SQLite。下面命令只是停止/查看，不导出秘密到日志：

```sh
docker compose -p pibo-personal -f deploy/compose.yaml stop
docker compose -p pibo-personal -f deploy/compose.yaml images
docker volume ls --filter label=com.docker.compose.project=pibo-personal
```

备份/恢复可使用组织已有的 Docker volume backup 流程；为避免不可信工具下载，本仓库提供 [卷快照脚本](../deploy/volume-backup.sh)，只使用已经构建的本项目镜像和当前项目卷，见脚本 `help`。备份包含服务密码 hash、session hashes、模型凭据与 Tailnet identity，必须作为秘密保存。测试恢复请用全新卷；严禁对正在使用或别的部署卷恢复。

```sh
./deploy/volume-backup.sh backup pibo-personal "$PWD/private-backup" "$PIBO_HARNESS_IMAGE"
cp "$PIBO_HARNESS_CONFIG" "$PWD/private-backup/harness.json"  # 非秘密配置；另存以便恢复同一端口/Host
# 审阅新 checkout 后用新的 immutable tag 构建，再 up；旧 tag 保留：
export PIBO_HARNESS_IMAGE=pibo-harness:NEW_REVIEWED_REVISION
docker compose -p pibo-personal -f deploy/compose.yaml build harness
docker compose -p pibo-personal -f deploy/compose.yaml up -d harness
```

只切回旧镜像不能保证数据库兼容。回滚时停机，恢复升级前快照到**新的卷/新的项目**，用原 image ID 启动；原新版本卷保留以免丢失升级后的消息。不要同时启动两个使用同一 Tailnet identity 的节点。卸载 `docker compose ... down` 后保留卷和镜像；删除数据/镜像是另外的人工决定。

```sh
docker compose -p pibo-personal -f deploy/compose.yaml stop
./deploy/volume-backup.sh restore pibo-personal-rollback "$PWD/private-backup" OLD_IMAGE_ID
export PIBO_HARNESS_IMAGE=OLD_IMAGE_ID
export PIBO_HARNESS_CONFIG="$PWD/private-backup/harness.json"
# 原项目保持停止，避免同时运行同一个 Tailnet identity：
docker compose -p pibo-personal-rollback -f deploy/compose.yaml up -d
```

## 排障

| 现象 | 检查/处置 |
| --- | --- |
| `EADDRINUSE` / 启动失败 | 查看本实例 `logs/server.log` 或 `docker compose logs --tail=80 harness`；换空闲本地端口，不杀未知进程 |
| `setupRequired: true` | harness 可用但未配置模型；通过对应实例的设置输入凭据与选择模型，不反复重连 |
| Tailnet `NeedsLogin` / 无地址 | 在 sidecar/App 的登录入口由用户授权；宿主不在 Tailnet 时 host curl 超时不证明服务坏了 |
| `/pibo/service` 可达但登录失败 | 确认服务端已设置密码、目标地址正确；不自动降级到免认证 |
| `Invalid host/origin` | HTTPS origin/Host 必须一致；浏览器 Origin 被设计拒绝，不能通过删头绕过 |
| 密码命令要求本地终端 | 用交互终端或 `docker compose exec` 的默认 TTY；不要 echo/password env |
| owner/数据库锁错误 | 停止重复使用相同目录/卷的实例，核对目录所属；不自动删锁或改 owner |
| `.operation.lock` 已存在 | 先确认无安装管理进程；异常中断留下的锁才由用户手动移除，代码/数据不删除 |
| 磁盘不足 / build 中断 | 保留当前版本，报告使用量和未完成目录；不自动 prune/清盘 |

这些流程不会替用户配置付费模型或 OAuth，也不把“进程 ready”等同于真实模型回答通过。当前实际验证范围记录在交付说明中，未跑的架构/远端认证不应标为通过。
