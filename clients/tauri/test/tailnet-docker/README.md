# Disposable userspace Tailnet test peer

This project serves only synthetic `/health`, binary POST `/echo` (16 KiB), and
WebSocket `/ws` echo endpoints. It provides no file access or shell endpoint.
The Node process listens on 127.0.0.1:8080 in the Tailscale container's network
namespace. No host port is published. After browser approval, configure official
Tailnet-only TCP Serve (not Funnel):

```sh
docker compose -f clients/tauri/test/tailnet-docker/compose.yaml exec -T tailnet \
  tailscale --socket=/tmp/tailscale.sock serve --bg --tcp=8080 tcp://127.0.0.1:8080
```

Login, once for this running node, uses browser approval:

```sh
docker compose -f clients/tauri/test/tailnet-docker/compose.yaml exec -T tailnet \
  tailscale --socket=/tmp/tailscale.sock up --hostname=pibo-docker-test \
  --accept-dns=false --accept-routes=false --ssh=false --timeout=10m
```

Do not repeat login to refresh a pending request. No auth key is needed.
State is `mem:`; stopping the daemon loses its identity. There are no volumes or
host directory/socket mounts. Both services drop all capabilities, use readonly
root filesystems and no-new-privileges. Limits: Tailscale 0.5 CPU / 256 MiB /
128 PIDs; echo 0.25 CPU / 64 MiB / 32 PIDs. Restart is `no`. Temporary files use
bounded tmpfs. Docker still shares its Linux VM/kernel and host egress with other
work; a bridge network/capability drop does not guarantee absolute isolation or
block all outbound LAN/host access. No system VPN/proxy/DNS/firewall settings are
changed, and no route/exit-node advertisement or Tailscale SSH is enabled.

Official image provenance used on this Mac:

- Tailscale official GHCR v1.104.1 index SHA256:
  `87c55d6be56ad85b3d8bceca5f87f73de288c609131460dd1be1874c250cc41d`;
  arm64 image config SHA256:
  `97ca02ae61be2ac9abab0af278572023f29058418f333ebbe5cd66c874c504b1`.
- Docker official `node:22-alpine`, arm64 image config SHA256:
  `0d459d0765f0e55925663ba63fad229237ea06ad6ba4fa38658e7c5b5308a0b9`.
- App image is built locally from that Node base with only server.mjs copied.
  `.dockerignore` excludes every other context file. Compose uses pull_policy
  never for these already-verified local images. Recheck provenance on rebuild.

On this Mac Docker CLI hung in `docker-credential-desktop list`; no credentials
were read or changed. The task used a temporary empty-auth client config at
`/tmp/pibo-docker-client` and the same daemon endpoint
`unix:///Users/xiaoyang/.docker/run/docker.sock`. Prefix commands with
`docker --config /tmp/pibo-docker-client --host unix:///Users/xiaoyang/.docker/run/docker.sock`
in place of `docker` while this temporary config exists. Official image content
was transferred with verified HTTPS and checked compressed + uncompressed layer
SHA256 digests before Docker load. Certificate verification remained enabled.

Verification: `node --test .../server.test.mjs` checks synthetic HTTP bytes,
unknown-path denial and WebSocket. The same HTTP/WebSocket echo ran inside the
container namespace. These do not prove Tailnet transport. Logs and actual
container limits are in ignored `artifacts/tailnet-docker/`. The simulator's prior
session expired near 2026-10-21 05:30 UTC without observed approval; it must not
be silently renewed. Cloud peer remains unavailable.

Reversible suspension: `docker compose -f .../compose.yaml pause`, then `unpause`
to resume while Docker stays running. To finish, `... down` removes only this
project's two containers and dedicated network; there are no volumes to delete.
Its in-memory identity is then lost. Optional image removal must target only
`pibo-tailnet-echo:local` and the two listed official images after confirming no
other container uses them; never prune global images or caches. Existing
`pi-bot-desktop` was left running throughout.

References: https://github.com/tailscale/tailscale/pkgs/container/tailscale
and https://tailscale.com/docs/reference/tailscale-cli/serve

## Runbook desktop verification (2026-10-21)

`Dockerfile.desktop-test` reuses the existing `pi-bot-desktop:local` project base
and executes `scripts/setup-linux-desktop.sh`, then the unchanged
`container/start-desktop.sh --runtime` / `run-runtime.sh` / `run-desktop.sh`.
Build from a staging context containing only tracked project sources; never copy
personal directories, `.env`, work data or Git metadata into the image. The
observed base was arm64 Node 24.18.0 / Debian trixie glibc 2.41. The original
runbook uses Chromium `--no-sandbox`; this remains confined to the test container.

The final incremental image `pibo-tailnet-desktop:local` is `1ef4cec5077c`, with
Pi agent/core/AI/MCP/TUI and codemode **1.2.0**, native computer-use plugin 0.7.16.
The earlier 1.1.0 recovery images are only build recovery snapshots. The root
Tauri API dependency is required for the shared GUI build's dynamic imports.

Start only the desktop service with both compose files and `up -d --no-deps desktop`.
Its limits are 1 CPU, 1536 MiB, 768 PIDs, 128 MiB shared memory, readonly root,
no capabilities, no-new-privileges, no restart, no volumes, no published ports;
`/tmp`, `/data`, `/app/work` are bounded tmpfs. The first 256-PID limit was
insufficient for Chromium windows and caused `Cannot fork`; it was increased
only for this test container. Existing Tailnet and echo containers stayed alive.
The desktop broker's random bearer is generated in tmpfs, never exported to chat.

`node scripts/test-desktop-image.mjs tailnet-native-a tailnet-native-b` passed
shared-profile, native keyboard focus isolation, native mouse, foreign-window
and off-screen denial, manual takeover/resume and distinct PNG frame checks.
`desktop-novnc-check.mjs` runs with `node --import tsx` inside this container.
It opens only a container-loopback synthetic viewer, relays authenticated RFB to
the existing broker, and checks actual noVNC canvas pixels, `RFB-KEYBOARD` entry
and a mouse click. During manual control it drives only its bound synthetic
viewer via CDP; agent calls remain paused. No model API is invoked. All passed.
Evidence is under ignored `artifacts/desktop-120/`; the noVNC PNG is 128903 bytes,
SHA256 `f0b35c74fd14598529466be77ee7be81470e7f5c3b380dcd21d666c9221ea4da`.
This verifies Linux-container Chromium, not Mac browser or iOS-over-Tailnet VNC.
No additional Tailnet desktop forward has been enabled yet. The prior simulator
identity was deleted after its 13:53:48 UTC deadline; new iOS testing needs a new
browser-approved temporary session after desktop access is configured.

The three task containers are `pibo-tailnet-test-tailnet-1`,
`pibo-tailnet-test-echo-1`, and `pibo-tailnet-test-desktop-1`; no volumes exist.
To suspend reversibly, pause these exact containers, then unpause them. A later
explicit teardown may use both compose files with `down`; this loses the
in-memory Tailnet identity and desktop tmpfs, so export synthetic evidence first.
Never run global prune. Keep the unrelated `pi-bot-desktop` container untouched.

## Persistent direct-test follow-up (2026-10-23)

The user approved project-only persistent node storage. `persistent.compose.yaml`
adds `tailnet-persistent` without replacing/deleting old containers. Its external
named volume `pibo-tailnet-test-state` is mounted only into this project's
Tailscale container. The private state directory is mode 700 and state file 600.
Do not use `down -v`, reset/remove the identity, disable key expiry or change ACLs.
The volume is retained even after the test stops. Restart the node and compare
public Self.ID/IP after approval before starting the dependent runtime; a file
surviving on a volume alone does not prove authenticated identity reuse.

Actual resources created: `pibo-tailnet-test-tailnet-persistent-1` and the named
volume above. The node is currently stopped after its bounded login timed out:
`GET https://controlplane.tailscale.com/key?v=148: EOF`. Host curl also failed TLS
to the same official endpoint. No authorization URL or Tailnet IP was obtained,
no Serve/Funnel was enabled, and no new node was approved. Prior in-memory test
containers and unrelated containers were preserved. Restart/login/identity reuse
remain unverified until official control connectivity recovers.

The direct fixture (`direct/`) uses the audited desktop image, broker loopback
8091, daemon loopback 4318 and explicit Serve-loopback gateway 4319. It requires
an explicit current approved node IP. Its SessionFactory only copies synthetic
uploaded files to generated artifacts (including safe image MIME), without a
model/provider call or attachment execution. Broker readiness/auth remains
inside the container; credentials are never printed. Runtime data is disposable
tmpfs; only the Tailnet node identity volume persists. No host mounts/ports are
published. Use a tracked-source-only staging build context; do not build from a
working context containing private files. `direct/Dockerfile` assumes the audited
`pibo-tailnet-desktop:local` base is already available; no new packages are fetched.
The built local image is `pibo-tailnet-direct:7d4c25f` (inspect its current ID).
Compose and strict TypeScript/shell syntax checks passed; the new runtime has
not been started because the approved node has no current IP.

An isolated `dev.pibot.direct-simulator` App was unsigned-built against the real
SDK static archive, installed and launched on the already available iPhone 17 /
iOS 26.4 Simulator. The actual new connection homepage rendered; the app was then
terminated, retained for continuation. It did not start a client node/login or
write network credentials. Original `dev.pibot.ios` was not replaced. Local
ignored evidence: `artifacts/tailnet-direct/initial-app-ready.png`; build logs
`/tmp/pibo-direct-simulator-build.log`, `/tmp/pibo-direct-xcode-build.log`.
The first generated Xcode attempts selected the device archive or development
dylib; the final isolated build uses a static-only alias and verifies defined
`start_app`, `tailscale_dial`, `tailscale_status_json` symbols with no dependency
on the build-tree dylib. The generated diagnostic project is saved with the
ignored evidence, not used for official distribution.

Pending real checks: browser approval on both nodes, paired native SDK HTTP/SSE,
file/image bytes, WKWebView desktop pixels/input, container and client restart
identity reuse, and cleanup of the future test Serve/pairing. No TestFlight or
system networking/signing/security changes were performed in this follow-up.

Read-only EOF comparison: host and a credential-free diagnostic container both
resolved `controlplane.tailscale.com` to `198.18.0.243`. Host `login.tailscale.com`
resolved to `198.18.0.252`; both official HTTPS endpoints failed TLS before an
HTTP response (host SSL_ERROR_SYSCALL, container unexpected EOF/reset). Host route
to 198.18.0.243 used utun9 via 198.18.0.1. No HTTP(S)/ALL_PROXY environment was
inherited by host diagnostics or the test-node container, and system HTTP/HTTPS/
SOCKS/PAC enable flags were zero. Docker's existing daemon proxy is
http.docker.internal:3128 and its TCP port is reachable from the test bridge.
No proxy request/override, DNS change or TLS verification bypass was performed.
This demonstrates a shared outer-network failure before Pibo service traffic;
it does not identify the tunnel application's cause or prove an SDK fix.
A possible next bounded experiment needs confirmation: only recreate the new
test-node container with HTTPS_PROXY=http://http.docker.internal:3128, preserving
the same named state volume, then retry the official public-key HTTPS probe with
normal certificate verification. This may also fail and is not yet executed.

Approved proxy experiment, 2026-10-23: the stopped non-proxy persistent container
was preserved as `pibo-tailnet-test-tailnet-persistent-no-proxy`. A replacement
`pibo-tailnet-test-tailnet-persistent-1` uses the same state volume and restrictions,
with only HTTPS_PROXY=http://http.docker.internal:3128 added. The optional
`proxy.compose.yaml` records that exact override; it is not a default setting.
BusyBox wget did not demonstrate proxy use (it still printed the destination IP),
so it was not treated as proof. The installed official Go CLI command
`timeout 20 tailscale debug ts2021 --force-port=443 --verbose` explicitly confirmed
that proxy for the official `/key?v=148` request, then failed with EOF. A separate
CONNECT-only probe received `HTTP/1.0 200 OK`, `Connection: close`, length zero;
no verified HTTPS response was obtained. Normal certificate verification stayed
enabled. A scratch helper was not run because read-only-rootfs/noexec restrictions
blocked copying/execution; those restrictions were retained, and the existing
Go CLI supplied the decisive result instead.

No new login was attempted after the failed verified-client probe; no auth URL,
registration, pairing or Serve port resulted. The proxy test container was then
stopped, retaining both old containers and the identity volume. The next action
needs restored official HTTPS connectivity or an explicitly approved different
known-working proxy. Do not blindly repeat login, alter system/simulator network
settings, or turn off TLS verification. Persistence/restart and real Tailnet
application data tests remain pending.
