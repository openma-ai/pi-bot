#!/bin/bash
# Install native macOS Computer Use for pi-bot (no Colima / Linux Docker desktop).
# Uses community package @nredd/pi-computer-use (official @agent-sh/computer-use-macos is unpublished).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname -s)" != Darwin ]; then
  echo 'This installer targets macOS only. On Linux use ./scripts/setup-linux-desktop.sh.' >&2
  exit 1
fi

PACKAGE='@nredd/pi-computer-use@0.6.0'
HELPER_APP="${PI_COMPUTER_USE_HELPER_APP_PATH:-$HOME/Applications/pi-computer-use.app}"

if ! command -v node >/dev/null || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]; then
  echo 'Node.js >= 24 is required. On botty use ~/.local/share/pi-bot/node/bin/node if installed.' >&2
  exit 1
fi

echo "Installing ${PACKAGE} (no package.json save; same pattern as Linux computer-use)..."
npm install --no-save --package-lock=false --ignore-scripts --legacy-peer-deps --registry=https://registry.npmjs.org "$PACKAGE"

HELPER_SETUP='node_modules/@nredd/pi-computer-use/scripts/setup-helper.mjs'
if [ ! -f "$HELPER_SETUP" ]; then
  echo "Missing $HELPER_SETUP after install." >&2
  exit 1
fi

echo "Running helper setup (installs/signs ${HELPER_APP})..."
node "$HELPER_SETUP"

cat <<NOTE

Installed native macOS Computer Use.

Next — grant TCC once in System Settings → Privacy & Security:
  1. Accessibility → enable pi-computer-use.app
  2. Screen Recording → enable pi-computer-use.app
     (if a toggle is already on after re-sign, turn it off then on again)

Helper path: ${HELPER_APP}
Bundle id:   com.injaneity.pi-computer-use

Then restart pi-bot. Capabilities should move unconfigured → permission-required → ready
after a read-only helper probe (no companion control.json required).

Disable with: PI_BOT_MACOS_COMPUTER_USE=0
Force enable after package install without helper binary: PI_BOT_MACOS_COMPUTER_USE=1

Smoke (on the Mac, after TCC):
  node --import tsx -e "import { probeMacosNativeCapabilities } from './src/daemon/macos-computer-use.ts'; console.log(await probeMacosNativeCapabilities({ platform: 'darwin' }))"

NOTE
