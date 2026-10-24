# Direct runtime connections and service password

The native Tauri client offers Tailscale peer selection or a manually entered HTTPS origin. Mac local workspace discovery remains available. Client SSH launchers/credential UI are removed; existing SSH profile metadata remains visible for migration but cannot connect. No SSH keys are read, copied or deleted. The browser/Electron legacy host remains local-only and explicitly refuses native direct profiles.

Both native remote entrances use `/pibo/service`, `/pibo/login`, `/pibo/ready` and the same authenticated runtime transport. Chat events remain SSE; files remain binary HTTP; noVNC uses a native WebSocket upgrade. The private WebView bridge exposes only a per-view random ticket, never the service bearer. HTTPS desktop upgrades use the same certificate-verifying client (WSS equivalent on the upstream connection), and redirects are disabled. Ordinary remote HTTP is rejected before sending any password; only explicit loopback HTTP is allowed. Tailnet traffic uses SDK dial and its existing encrypted transport, not a system VPN. Existing outer VPN routing still applies.

## Local owner initialization

Nothing in this change starts a listener or changes an installed service. An operator must deploy the new server before using password login. With the existing explicit Tailnet gateway enabled, run on that server's own terminal:

```
npm run pi-bot -- service-password --data-dir /absolute/runtime/data
```

This reads a hidden password twice from the controlling terminal, never argv/environment or a remote initialization endpoint. Minimum 12 characters, maximum 512 UTF-8 bytes. Local control uses the existing daemon owner bearer and loopback endpoint. The daemon stores a random salt and scrypt hash (N=32768,r=8,p=1,32-byte result) in a mode-0600 atomic file. Changing the password invalidates all previous service sessions and old pairing records, and closes their active streams. No real password was configured during implementation.

Login creates a 256-bit random, revocable, 30-day session. Only SHA-256 bearer hashes are stored by the server; the Apple client stores the bearer in its existing device-only, when-unlocked Keychain service, bound to exact origin or Tailnet peer/network identity. The password is not saved in profiles, Keychain, URLs or logs. There are at most 32 sessions, at most 2 concurrent scrypt checks and 10 global login attempts/minute (in-memory limiter resets on process restart). This intentionally trades availability for a simple bounded credential attack surface.

`tailnet-devices` lists session IDs and expiry; `tailnet-revoke --device ID` revokes one via local administration. “退出并撤销服务会话” revokes the server session before removing the local token; an offline revocation fails explicitly, so the operator can revoke locally. Expired sessions cannot authorize new HTTP/SSE/WS connections and their tracked active connections are closed. Existing desktop control leases/heartbeats remain independent and unchanged. Cancelled login invalidates the in-flight native attempt, does not save a new device token, and attempts to revoke a token already issued by the server.

## Optional HTTPS endpoint

No TLS proxy is installed or configured by this change. For an operator-managed TLS reverse proxy, the gateway accepts an explicit `--service-origin https://pibo.example.com` **only together with** the existing `--tailnet-listen 100.x.x.x:4319 --tailnet-serve-loopback` flags. The gateway still binds only 127.0.0.1; accepted Host values are exactly the configured HTTPS authority or advertised Tailnet authority. Browser Origin remains disallowed at the gateway; forwarded authority/proxy headers are not trusted. The proxy must terminate verified HTTPS, preserve the configured Host, preserve external Origin (the gateway rejects it), and forward WebSocket upgrades and SSE. Do not enable a public endpoint, Serve, Funnel, firewall or proxy change without separate operator approval.

## Migration and limits

Old clients can keep using legacy pairing **only before** a service password is configured. Password setup deliberately revokes those pairings; new clients ask for the service password and never silently reuse SSH credentials or switch destinations. Old releases do not gain the new password form automatically: a new client build and server deployment are required, neither performed here. Normal Tailnet identity storage is unchanged.

Validation uses synthetic credentials, loopback services and isolated browser fixtures. New production password login, Keychain writes, HTTPS proxy deployment, true-device noVNC and live Tailnet password transport were not exercised. Existing published 1023.7.1 and current user test resources remain untouched.

## Isolated Docker test deployment preparation

The test runtime uses `/data/runtime`; its launcher writes the same owner-only `daemon.json` discovery metadata needed by the CLI. After rebuilding and restoring the approved test container (not performed by these instructions), the local hidden-input command is:

```
docker exec -it --user node --workdir /app pibo-tailnet-test-direct-1 \
  node --import tsx /app/src/daemon/main.ts service-password --data-dir /data/runtime
```

Do not run it against the old stopped image: it does not contain password authentication. Existing `/data` is tmpfs, so password/session persistence across container replacement requires a separate project-specific runtime volume mounted at `/data/runtime` with uid/gid 1000 and restrictive permissions. This is distinct from `pibo-tailnet-test-state`; never mount the Tailscale identity store into the runtime. Volume creation/mounting, service start, Tailnet-only TCP 4319 Serve and real password configuration require the operator's deployment approval. No such changes were executed during preparation.
