# alma-relay desktop agent

`scripts/alma-relay-agent.mjs` is a desktop-side agent that bridges a local
pi-bot runtime to [yetone/alma-relay](https://github.com/yetone/alma-relay).
It speaks the relay's wire protocol (protocol 2, with protocol-1 fallback) and
forwards tunneled HTTP and WebSocket traffic to the pi-bot daemon.

```
phone / Apple / Tauri client
        │  HTTPS or WSS  https://<relay>/c/<connect-code>/…
        ▼
   alma-relay  ──WSS /agent?th=<sha256(code)>──  pi-bot host
                                                     │
                                      http://127.0.0.1:4317
```

The agent is a transport only. It does not implement Alma's application API,
push notifications, TURN, or end-to-end encryption.

## Security model — no Alma E2E

**There is no Alma end-to-end encryption layer in this agent. The relay sees
plaintext HTTP request/response bodies, headers (including cookies and
`Authorization`), SSE streams, and WebSocket messages. TLS protects the hops
to the relay; it does not hide content from the relay operator.**

The protections that do exist are:

1. **TLS** between the phone/client and the relay, and between the agent and
   the relay. A plain `http://` relay URL is supported for local testing but
   should not be used across a network.
2. **Relay registration key** (`key` in the register frame), if the relay is
   configured to require one. This decides who may register a desktop, not who
   may reach it afterwards.
3. **The connect code**, a locally generated bearer secret. The relay stores
   only its SHA-256 hash and routes `/c/<code>/…` by hashing the path segment.
   Anyone who learns the code can reach this tunnel while the agent is
   connected.
4. **Whatever authentication the pi-bot backend enforces itself.** The agent
   does not add credentials or bypass an authentication check; it forwards
   headers (including cookies and `Authorization`) to the backend. It does
   rewrite `Host`/`Origin` so the loopback daemon accepts tunneled requests,
   so the daemon's same-origin check is not an authentication boundary here.

The default pi-bot listener at `http://127.0.0.1:4317` is designed for loopback
and trusted local clients, not for direct exposure. When it is tunneled, the
connect code becomes the effective bearer secret for that listener. If your
threat model requires a service password or another application-layer gate,
put that gate in front of the backend and verify it end to end; this agent
does not implement one. Do not treat "TLS to the relay" as equivalent to
end-to-end encryption.

Operational rules:

- Treat the connect code like a password. The agent prints the code in its
  one-time startup banner (also embedded in the client URL) and never repeats
  it in reconnect logs.
- Keep the registration key file readable only by the agent's user. The agent
  never logs the key or its contents.
- Remember that request headers and paths may contain session tokens. The
  agent deliberately does not log request paths or headers.

## Requirements

- Node.js 24+ (the repository engine).
- The `ws` dependency already listed in `package.json`.
- A running pi-bot daemon, by default on `http://127.0.0.1:4317`.

## Running

From the repository root:

```sh
npm run alma-relay
```

With no `--code`, the agent generates a cryptographically random,
URL-safe 43-character code and prints it once together with the client URL:

```
alma-relay agent
  relay:        https://alma-relay.hrhrngxy.workers.dev
  backend:      http://127.0.0.1:4317
  connect code: <43-character token>
  client URL:   https://alma-relay.hrhrngxy.workers.dev/c/<token>/
```

Example with explicit settings:

```sh
RELAY_URL=https://alma-relay.hrhrngxy.workers.dev \
CONNECT_CODE="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" \
BACKEND_URL=http://127.0.0.1:4317 \
RELAY_REGISTRATION_KEY_FILE=/home/box/agent-data/alma-relay-registration.key \
npm run alma-relay
```

Or with flags:

```sh
npm run alma-relay -- \
  --relay https://alma-relay.hrhrngxy.workers.dev \
  --code "$CONNECT_CODE" \
  --backend http://127.0.0.1:4317 \
  --key-file /home/box/agent-data/alma-relay-registration.key \
  --name pi-bot
```

### Options and environment

| Flag | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `--relay` | `RELAY_URL` | `https://alma-relay.hrhrngxy.workers.dev` | Relay origin; `https` becomes `wss`, `http` becomes `ws`. |
| `--code` | `CONNECT_CODE` | generated | Connect code, `[A-Za-z0-9_-]{16,128}`. |
| `--backend` | `BACKEND_URL` | `http://127.0.0.1:4317` | Local pi-bot origin; `http` maps to `ws`, `https` to `wss`. |
| `--key` | `RELAY_REGISTRATION_KEY` | — | Registration key. Prefer a file: command-line keys are visible in the process list. |
| `--key-file` | `RELAY_REGISTRATION_KEY_FILE` | `/home/box/agent-data/alma-relay-registration.key` if it exists | File containing the registration key. |
| `--name` | — | `pi-bot` | Name sent to the relay in the register frame. |
| `--help` | — | — | Print usage. |

Key precedence is `--key`, `--key-file`, `RELAY_REGISTRATION_KEY`,
`RELAY_REGISTRATION_KEY_FILE`, then the default file. The default file is used
only when it exists. An explicitly configured key or key file that is missing
or empty is a startup error.

The version reported to the relay is the `version` field from
`package.json` (`0.2.0` currently), with `0.2.0` as a fallback.

### Running under a service manager

Run the agent in the foreground and let systemd/launchd restart it. The agent
already reconnects internally, so an outer restart loop should only be a
last resort. Send `SIGINT` or `SIGTERM` for a clean shutdown; the agent closes
the relay socket, backend sockets, and in-flight requests.

## How a client reaches it

The relay maps the path after `/c/<code>` to the same path on the backend.
With the default backend:

| Client URL | Backend |
| --- | --- |
| `https://<relay>/c/<code>/` | `http://127.0.0.1:4317/` |
| `https://<relay>/c/<code>/rpc` | `http://127.0.0.1:4317/rpc` |
| `https://<relay>/c/<code>/events` | `http://127.0.0.1:4317/events` |
| `wss://<relay>/c/<code>/api/desktop/<id>/ws` | `ws://127.0.0.1:4317/api/desktop/<id>/ws` |

The query string is preserved. The code is a secret: do not put the full
client URL in screenshots, shell history, issue reports, or logs.

### Backend request handling

The relay strips `Host` before forwarding. The agent:

- rewrites `Host` to the backend origin, which the pi-bot daemon requires;
- rewrites an existing `Origin` to the backend origin, which the daemon also
  requires for browser HTTP and WebSocket handshakes;
- forces `Accept-Encoding: identity` so streamed bodies and SSE are not
  transparently compressed;
- removes hop-by-hop headers and recomputes `Content-Length`;
- streams streamed request bodies (`HBODY` → backend, `hack` back to the relay)
  and response bodies (`HCHUNK`), pausing the backend stream when the relay
  socket has more than 1 MiB buffered.

WebSocket caveat: protocol 2's `wopen` frame carries only a path — no headers.
The agent can therefore forward WebSocket messages and close frames, but it
cannot forward a phone's cookie or `Authorization` header to the pi-bot
WebSocket handshake. pi-bot WebSocket endpoints that require header/cookie
authentication are not reachable through this agent as written. HTTP `/rpc`,
`/events` (SSE), and the GUI's HTTP endpoints do carry headers normally.

## Reconnect behavior

- On any unexpected disconnection the agent reconnects with exponential
  backoff (1 s base, 30 s cap) plus random jitter, and resets the backoff after
  a successful registration.
- Close code `4000` means another agent registered the same connect code. The
  agent logs this and exits without redialing.
- Close codes `4002` (bad token hash), `4003` (bad registration key), and
  `4401` (bad relay token) are also terminal; retrying them cannot succeed.
- Relay restarts (`1012`), network failures, and ordinary closes are retried.
- The agent pings the relay every 30 s and terminates a dead socket, which then
  triggers the reconnect path.

## Protocol notes

The agent implements the upstream
[`docs/PROTOCOL.md`](https://github.com/yetone/alma-relay/blob/main/docs/PROTOCOL.md):

- First frame: `{t:'register', tokenHash, name, ver, key?, proto: 2}`.
- The relay's `registered.proto` selects protocol 2 only when the relay also
  answers 2; an absent value means protocol 1.
- Protocol 2 uses binary frames for response chunks (`HCHUNK`), streamed
  request bodies (`HBODY`), and WebSocket messages (`WBIN`/`WTEXT`). JSON
  base64 forms are still accepted for compatibility.
- Streamed request bodies are acknowledged with `{t:'hack', id, n}` only after
  the backend accepts the bytes, preserving the relay's 4 MiB upload window.
- `hreq`, `hres`, `hchunk`, `hend`, `herr`, `hcancel`, `hreqend`, `wopen`,
  `wopened`, `wmsg`, `wclose`, and `werr` are handled.

The local binary helper in `scripts/alma-relay/binary.mjs` implements only the
upstream `BIN`, `encodeBinary`, and `decodeBinary` pieces; it does not import
the relay repository at runtime.

## Client checklist (measure against the real client)

These items are deliberately unchecked. They require a real Apple/Tauri
client and a real relay; do not assume the answer from the protocol alone.

- [ ] Determine whether the client's "remote URL" field wants the bare relay
      origin (`https://alma-relay.hrhrngxy.workers.dev`) or the full
      `https://alma-relay.hrhrngxy.workers.dev/c/<code>/` prefix. Test both;
      record which one the client actually accepts.
- [ ] Confirm the client's service-password/login flow against the backend
      used here. The agent forwards auth headers/cookies but does not add a
      password layer, and the default loopback daemon has no password prompt.
- [ ] Verify authenticated HTTP (`/rpc`, `/events` SSE) through the tunnel,
      including cookies, CSRF headers, and long-lived SSE.
- [ ] Verify the pi-bot GUI or desktop WebSocket path through the tunnel.
      Remember that `wopen` has no headers; an authenticated WS handshake may
      fail.
- [ ] Verify reconnect after a relay restart and after a network drop.
- [ ] Verify that a second agent with the same code triggers close `4000` and
      that the first agent exits instead of fighting for the tunnel.
- [ ] Verify large uploads/downloads and backpressure; watch memory on both
      the agent and the relay under a slow reader.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `relay rejected registration: Invalid registration key` / close `4003` | Missing or wrong registration key; check `--key-file` or the default file. |
| Close `4000` | Another agent registered the same connect code. Stop this instance or use a different code. |
| Close `4002` | The relay rejected the token hash; the code is outside the allowed character set/length. |
| `Invalid host` / `Invalid origin` from pi-bot | `--backend` is not the exact loopback origin the daemon expects (for example `localhost` instead of `127.0.0.1`). |
| `401 Authentication required` | The backend requires a pi-bot bearer/session that the client did not send. The agent does not supply one. |
| WebSocket closes immediately with `1008`/`1011` | The backend rejected the WS handshake; header/cookie authentication is not forwarded by `wopen`. |
| Reconnect loop with `ECONNREFUSED` | The relay origin is wrong or unreachable; this is retryable and will back off to 30 s. |

## Related

- Upstream protocol: <https://github.com/yetone/alma-relay/blob/main/docs/PROTOCOL.md>
- Upstream reference agent (tests only): `test/fake-agent.mjs` in that repo.
- pi-bot remote connections: [client connection docs](clients/DIRECT-PASSWORD.md) and
  [Tailscale direct](clients/TAILNET-DIRECT.md).
