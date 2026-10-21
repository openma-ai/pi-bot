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
