#!/usr/bin/env bash
# Build the per-display VNC server: PabloZaiden/mac-vnc-server (MIT) pinned + pi-bot patch
# (MAC_VNC_DISPLAY_ID pin, MAC_VNC_VIEW_ONLY/MAC_VNC_CONTROL_FILE). Command Line Tools only.
# Runtime needs Screen Recording for this binary (ScreenCaptureKit), and Accessibility only
# for interactive takeover input. Granting is a user action in System Settings.
set -euo pipefail
REV=d2372ea25689afb62ef457362dea16e5b644cd81
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${PI_BOT_VNC_SRC:-$HOME/Library/Caches/pi-bot/mac-vnc-server-$REV}"
OUT_DIR="${PI_BOT_MACOS_VD_BIN_DIR:-$HOME/Library/Application Support/pi-bot/bin}"
if [ ! -d "$SRC/.git" ]; then
  git clone -q https://github.com/PabloZaiden/mac-vnc-server "$SRC"
fi
git -C "$SRC" checkout -q -f "$REV"
git -C "$SRC" apply "$ROOT/native/macos/vendor/mac-vnc-server-pibot.patch"
(cd "$SRC" && swift build -c release --product mac-vnc-server-dev)
mkdir -p "$OUT_DIR"
cp "$SRC/.build/release/mac-vnc-server-dev" "$OUT_DIR/pi-mac-vnc-server"
echo "$OUT_DIR/pi-mac-vnc-server"
