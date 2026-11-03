# Native macOS Computer Use

pi-bot can drive the **host macOS desktop** without Colima or a Linux Docker companion.
This is the same *product capability* as Linux Computer Use (observe UI, act, screenshot, input),
implemented with a different adapter.

## Package

Official `@agent-sh/computer-use-macos` is **not published** (npm 404). The maintained community
package used here is [`@nredd/pi-computer-use@0.6.0`](https://www.npmjs.com/package/@nredd/pi-computer-use)
(Pi extension entry `extensions/computer-use.ts`).

Tools differ from `@agent-sh/computer-use-linux`:

| macOS (`@nredd`) | Linux companion (`@agent-sh`) |
| --- | --- |
| `find_roots`, `observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `act_ui`, `read_text`, `wait_for` | `list_windows`, `activate_window`, `get_app_state`, `click`, … |
| `desktop_screenshot`, `desktop_input` | `screenshot`, coordinate input tools |
| CDP browser tools inside the extension | `pi-chrome-use` via desktop-service |

## Setup

On the Mac only:

```sh
./scripts/setup-macos-desktop.sh
```

The script no-ops/refuses on non-darwin. It installs the npm package without writing
`package.json` (same pattern as `setup-linux-desktop.sh`) and runs the package helper
installer into `~/Applications/pi-computer-use.app` (or preserves a writable
`/Applications/pi-computer-use.app`).

### TCC (required, human)

In **System Settings → Privacy & Security**, enable for **pi-computer-use.app**:

1. **Accessibility** — interact with UI
2. **Screen Recording** — capture pixels

After a helper re-sign, macOS may keep a stale grant: turn each toggle **off then on**.
The harness probe never opens Settings panes or calls `registerPermissions` during
capability detection.

## Capability states

With no Linux `control.json` companion on darwin:

| State | Meaning |
| --- | --- |
| `unconfigured` | Package/helper missing — run setup script |
| `permission-required` | Helper answered; Accessibility and/or Screen Recording denied |
| `unreachable` | Helper installed but socket/daemon did not answer the read-only probe |
| `ready` | Helper verified both permissions (credential-free reason string) |
| `unsupported` | Non-darwin native path, or VNC (not offered on native macOS) |

A configured Linux companion (`PI_BOT_DESKTOP_CONTROL` / `control.json`) still wins when present;
native host mode is the companion-free darwin path.

Opt out: `PI_BOT_MACOS_COMPUTER_USE=0`.

## Architecture

1. Discovery (`src/pi/macos-computer-use.ts`) finds the package + helper on darwin.
2. Daemon refreshes capabilities via `probeMacosNativeCapabilities` (helper `checkPermissions` over the unix socket) every 10s when no companion is configured.
3. Live Pi sessions load the package extension factory so tools register in-process (native host), not through `desktop-service` HTTP.

Linux X11/VNC `desktop-service.ts` is unchanged.

## Manual verification on botty

Target: machine `botty`, path `~/pi-bot`, Node under `~/.local/share/pi-bot/node`.

1. `cd ~/pi-bot && git fetch && git checkout feat/macos-native-computer-use && ./scripts/setup-macos-desktop.sh`
2. Grant TCC as above (GUI clicks only the human can do).
3. Restart the daemon.
4. Probe:

```sh
export PATH="$HOME/.local/share/pi-bot/node/bin:$PATH"
node --import tsx -e "import { probeMacosNativeCapabilities } from './src/daemon/macos-computer-use.ts'; console.log(JSON.stringify(await probeMacosNativeCapabilities({ platform: 'darwin' }), null, 2))"
```

Expect `computerUse.state === "ready"` and `screenCapture.state === "ready"` after TCC.
5. In a bot session, call `find_roots` then `observe_ui` on a known app; confirm no Linux/VNC tools are required.
6. Do **not** claim public README “macOS Computer Use supported” until this smoke note is recorded.

## Verification status (this PR)

- Linux box: unit tests + `npm run check` for classification and non-regression.
- botty live TCC + smoke: **not run in this environment** — follow the steps above.
