# Native macOS Computer Use

pi-bot can drive a **per-session virtual desktop on the host Mac** without Colima or a Linux Docker companion.
Business logic mirrors the Linux desktop companion: one shared "display surface", tiled per bot, serial input, capability states, bind-on-session / tear-down-on-idle.

## Package + helper

Official `@agent-sh/computer-use-macos` is **not published** (npm 404). The maintained community
package used here is [`@nredd/pi-computer-use@0.6.0`](https://www.npmjs.com/package/@nredd/pi-computer-use)
(Pi extension entry `extensions/computer-use.ts`) plus its Accessibility / Screen Recording helper app.

| macOS (`@nredd` + companion VD) | Linux companion (`@agent-sh`) |
| --- | --- |
| One `CGVirtualDisplay` companion (wide) | One X11 `:99` |
| Tiles of 1280×800 per bot (`DesktopOwnership`) | Tiles of 1280×900 per bot |
| Helper `captureDisplay` / `desktopInput` | xdotool / ImageMagick / computer-use-linux |
| Viewer = tile screenshot stream (`canOpenView`) | Viewer = x11vnc clip RFB |
| Input **serialized** (one global cursor/focus) | Input isolated per X display |

## Virtual display (companion)

macOS does not give each bot a separate login session. Concurrent extra `CGVirtualDisplay`s also
often fail when Screen Sharing already consumes virtual-display slots (observed on botty: only ~1
extra VD is reliable). Therefore pi-bot uses the **same tiling model as Linux**:

1. `pi-virtual-display-companion` creates **one** wide `CGVirtualDisplay` (`capacity × 1280` × 800).
2. Each bot `desktop/bind` claims a tile (`screen * 1280` origin on that companion).
3. Windows are confined into the tile (drag + `setWindowFrame`; AX alone may clamp negative X).
4. Screenshots use `captureDisplay` on the companion index; input is remapped into the tile.
5. When the last binding is released (or the daemon closes), the companion process exits and the VD vanishes (`.forSession` arrangement — no permanent orphans).

Build:

```sh
./scripts/build-macos-virtual-display.sh
# or via
./scripts/setup-macos-desktop.sh
```

Binary default: `~/Library/Application Support/pi-bot/bin/pi-virtual-display-companion`.
Override with `PI_BOT_MACOS_VD_BIN`. **No extra TCC** for the companion (private CoreGraphics API from a non-sandboxed CLI). Do **not** re-sign `pi-computer-use.app` or its Accessibility grant breaks.

### Honest isolation limits

- **Pixels / windows:** bots can be kept on the companion; the main display stays free of bot windows when confinement succeeds.
- **Input:** macOS has a **single global cursor and focus**. Concurrent bots must not type at once; the host serializes helper input (same practical constraint Linux tiles share when using one X server pointer — Linux still has stronger process/display isolation).
- **Multi-VD:** creating one CGVirtualDisplay **per bot** is not reliable alongside Screen Sharing VDs; tiling is intentional.

## Setup

On the Mac only:

```sh
./scripts/setup-macos-desktop.sh
```

### TCC (required, human)

In **System Settings → Privacy & Security**, enable for **pi-computer-use.app**:

1. **Accessibility** — interact with UI
2. **Screen Recording** — capture pixels

After a helper re-sign, macOS may keep a stale grant: turn each toggle **off then on**.
The harness probe never opens Settings panes or calls `registerPermissions` during capability detection.
Automation (Apple Events) prompts for Terminal/`osascript` are unrelated — prefer the helper APIs.

## Capability states

With no Linux `control.json` companion on darwin:

| State | Meaning |
| --- | --- |
| `unconfigured` | Package/helper missing — run setup script |
| `permission-required` | Helper answered; Accessibility and/or Screen Recording denied |
| `unreachable` | Helper installed but socket/daemon did not answer the read-only probe |
| `ready` | Helper verified both permissions |
| `unsupported` | Non-darwin native path, or VNC (not offered; use screenshot-tile view) |

`canOpenView` becomes true when Computer Use + Screen Recording are ready **and** the companion binary exists (screenshot-tile viewer path).

Opt out: `PI_BOT_MACOS_COMPUTER_USE=0`.

## Architecture

1. Discovery (`src/pi/macos-computer-use.ts`) finds the package + helper on darwin.
2. Daemon refreshes capabilities via `probeMacosNativeCapabilities`.
3. `MacosVirtualDisplayHost` (`src/daemon/macos-virtual-display.ts`) owns companion lifecycle + `DesktopOwnership` tiles.
4. `desktop/bind` on darwin starts/ensures the companion and returns the bot's tile binding.
5. Live Pi sessions still load `@nredd/pi-computer-use` for semantic UI tools; bind scopes the session to its tile.

Linux X11/VNC `desktop-service.ts` is unchanged.

## Manual verification on botty

1. `./scripts/setup-macos-desktop.sh` (builds companion + installs helper package).
2. Grant TCC as above.
3. Probe capabilities; expect `computerUse`/`screenCapture` ready and `canOpenView` true.
4. Bind two bots; place windows on each tile; type on A; confirm B and main display unchanged; capture companion screenshots.
5. Release bindings / stop daemon; confirm companion display disappears from the online display list.
