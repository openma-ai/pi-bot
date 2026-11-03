# Remote access and device pairing

pi-bot can optionally be reached from other devices through an
[alma-relay](https://github.com/yetone/alma-relay) instance, modeled on Alma
Remote Access. Pairing and per-device credentials apply to the daemon's
**local** HTTP API as well: every request needs a paired-device token, on
loopback too.

## Turning it on (optional, default off)

Remote access is off unless a relay URL is configured. First match wins:

| Source | Example |
| --- | --- |
| flag | `pi-bot daemon --relay https://relay.example.workers.dev --relay-key-file ~/.config/pi-bot/relay.key` |
| env | `PI_BOT_RELAY_URL=https://…` and `PI_BOT_RELAY_KEY_FILE=…` (or `PI_BOT_RELAY_KEY`) |
| file | `<dataDir>/remote.json`: `{"relay":{"url":"https://…","keyFile":"…","enabled":true}}` |

`--no-relay` or `PI_BOT_RELAY=off` force it off. The URL must be `https`
(plain `http` only for a loopback test relay). The registration key is the
relay operator's `RELAY_REGISTRATION_KEY`; it is read from the file and never
logged. Without a relay, nothing is dialed; only the local auth below applies.

## Pairing

The daemon keeps a 256-bit **connect code** in `<dataDir>/remote-access.json`
(0600). Pairing hands a client three things, packed into a QR code / link
(`pibot://pair#<base64url JSON>`):

| Field | Purpose | Relay sees it? |
| --- | --- | --- |
| `relay` | Relay origin | yes (it is the relay) |
| `code` | E2E handshake secret; the routing token is derived from it | no |
| `ticket` | One-time pairing ticket (the short manual code), 10 min, 5 attempts | no (inside E2E) |

The client opens an E2E tunnel (below), then `POST /remote/pair
{ticket, name}` inside it and receives its own **device token**
(`pbd_…`). It stores `{relay, code, deviceId, token}`. Every later request
carries `Authorization: Bearer <device token>`.

### Desktop UI

Settings → 远程访问 → 生成配对码 shows the QR code, the short code, the device
list with revoke, and connect-code rotation.

### Headless / SSH

```sh
pi-bot pair --data-dir <dir>          # ASCII QR + short code + copyable link
pi-bot pair --rotate                  # rotate the connect code first (re-pair everyone)
pi-bot pair --json                    # machine-readable
```

The QR renders in any UTF-8 terminal, so it works over SSH. If you cannot
scan, paste the link into the client. The short code alone pairs a client
that can already reach the daemon's HTTP port (loopback, an SSH port
forward, or the browser page at `/pair`); a remote client additionally needs
the connect code, which is only in the QR/link.

Running `pi-bot pair` again invalidates the previous ticket.

### Invite from a paired device

A paired device calls `POST /remote/invite` and gets a fresh pairing link and
short code to show to the new device. The new device is recorded with
`via: invite, invitedBy: <device id>`.

### Automation / CI

- `pi-bot devices provision ci-runner` prints `{deviceId, token}` once.
- Or pre-provision: start the daemon with `PI_BOT_DEVICE_TOKEN=pbd_…` or
  `PI_BOT_DEVICE_TOKEN_FILE=<file>` (`PI_BOT_DEVICE_NAME` optional). The token
  is registered (hash only) at startup.
- Both are revocable like any device; a revoked provisioned token stays
  revoked even if the env var is still set.

## Devices, revoke, rotation

```sh
pi-bot devices                 # list
pi-bot devices revoke <id>     # revoke one device; its SSE streams and connections close
pi-bot devices rotate-code     # new connect code: old QR/links/route die, every remote device re-pairs
```

HTTP: `GET /remote/devices`, `POST /remote/devices/revoke {id}`,
`POST /remote/token/rotate` (a device rotates its own token; the old one stops
working immediately).

## Local API auth

| Credential | Who |
| --- | --- |
| `Authorization: Bearer <daemon.token>` | Local tooling as the same OS user: `pi-bot` CLI, `pi-bot client` (desktop GUI host), the Tailnet gateway, tests. The file is rewritten on every start, mode 0600. This is the one documented escape hatch; it never leaves the host and is not accepted any differently through the relay (a remote client cannot know it). |
| `Authorization: Bearer pbd_…` | Paired devices, local or through the relay |
| `pibot_device` HttpOnly cookie + `X-PiBot-CSRF` | A browser paired at `/pair` |

The old behaviour, where loading `/` gave any local browser a session, is
gone: unpaired browsers are redirected to `/pair`.

## End-to-end encryption

The daemon serves **only** WebSocket `/__pibot_e2e__` on the relay. Plaintext
HTTP through the relay gets `403`; any other WebSocket path gets `werr`.

```
client ──WSS /c/<routeToken>/__pibot_e2e__──▶ relay ◀──WSS /agent?th=sha256(routeToken)── daemon
```

- `routeToken = base64url(HMAC-SHA256(code, "pi-bot/route/v1"))`. The relay
  routes by `sha256(routeToken)` and never sees the code.
- Handshake (X25519 ephemeral keys, WebCrypto):
  `hello {pk, n}` → `welcome {pk, n, mac}` → `confirm {mac}`;
  `A = HKDF(code, "pi-bot/e2e/auth/v1")`,
  `th = SHA-256("pi-bot/e2e/v1" ‖ Ec ‖ Ed ‖ nc ‖ nd)`,
  MACs are `HMAC(A, "server"‖th)` / `HMAC(A, "client"‖th)`, keys
  `HKDF(X25519, salt=HMAC(A, th), "pi-bot/e2e/keys/v1")` → one AES-256-GCM key
  per direction. Knowing the code is required to complete it, so the relay
  cannot MITM. Ephemeral keys give forward secrecy.
- Records: binary `[u64 counter][AES-GCM ciphertext+tag]`, IV = direction ‖
  counter, AAD = `th`; strictly sequential counters (replay/reorder closes the
  tunnel).
- Inside: `{t:'req', id, method, path, headers, body}` →
  `{t:'res', id, status, headers}`, `{t:'chunk', id, b}`…, `{t:'end', id}`;
  `{t:'cancel', id}`. SSE streams arrive as chunks.

Implementation: `src/sdk/protocol/remote-e2e.ts` (isomorphic), link format `src/sdk/protocol/remote-pairing.ts`, reference client
`src/sdk/remote/client.ts`, agent `src/daemon/remote/relay-agent.ts`.

### The `/c/<token>` prefix

Clients address the relay as `https://<relay>/c/<routeToken>/__pibot_e2e__`
(WebSocket). The relay strips `/c/<routeToken>`; the daemon sees `/__pibot_e2e__`.
Daemon HTTP routes are **not** prefixed or rewritten: they travel inside the
encrypted tunnel with their normal paths (`/rpc`, `/events?connection=…`,
`/pi/…`, `/remote/…`). A client never builds `/c/<token>/rpc` URLs.

## Threat model: what the relay sees

| Relay sees | Relay does not see |
| --- | --- |
| `sha256(routeToken)` and the route token in client URLs | the connect code, pairing tickets, device tokens |
| Client IPs, timing, number and size of records | request paths, headers, bodies, SSE events, responses |
| The handshake's ephemeral public keys, nonces, MACs | session keys (needs the code) |
| The registration key (it checks it) | |

- Someone holding the route token (relay operator, a leaked log) can open a
  tunnel, but cannot finish the handshake without the code; plaintext gets 403.
- Someone holding the code (an old QR/link) can complete the handshake, but
  still needs a device token for every API call, or a live ticket to pair.
  Rotate the code to also cut their transport.
- A stolen device token is revoked per device; tokens are stored only as
  SHA-256 hashes.
- Tokens, codes, tickets and the registration key are never logged.
  `PI_BOT_RELAY_DEBUG_FRAMES=1` logs frame kinds, sizes and a 24-byte prefix
  of binary (ciphertext) records only.
- Not covered: traffic analysis (sizes/timing), a compromised daemon host or
  client device, a relay that drops traffic (availability).
