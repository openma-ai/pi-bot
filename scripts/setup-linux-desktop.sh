#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Linux || { echo 'This installer targets Linux. macOS can run the server without a Linux desktop.' >&2; exit 1; }
runtime_glibc=$(getconf GNU_LIBC_VERSION | awk '{print $2}')
test "$(printf '%s\n' 2.39 "$runtime_glibc" | sort -V | head -1)" = 2.39 || { echo 'Desktop plugins require glibc >= 2.39 (Ubuntu 24.04+ or Debian 13+).' >&2; exit 1; }
command -v apt-get >/dev/null || { echo 'Automatic dependency setup supports Debian/Ubuntu only.' >&2; exit 1; }
if [ "$(id -u)" = 0 ]; then runtime_sudo=(); else runtime_sudo=(sudo); fi
"${runtime_sudo[@]}" apt-get update
"${runtime_sudo[@]}" apt-get install -y --no-install-recommends curl ca-certificates xz-utils chromium xvfb openbox x11vnc xdotool wmctrl x11-xserver-utils dbus-x11 imagemagick libatk-adaptor at-spi2-core fonts-noto-cjk util-linux
if ! command -v node >/dev/null || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]; then
  case "$(uname -m)" in x86_64) runtime_arch=x64;; aarch64|arm64) runtime_arch=arm64;; *) echo 'Unsupported CPU architecture' >&2; exit 1;; esac
  runtime_version=v24.18.0
  runtime_archive="node-$runtime_version-linux-$runtime_arch.tar.xz"
  runtime_temp=$(mktemp -d)
  trap 'rm -rf "$runtime_temp"' EXIT
  curl -fSL "https://nodejs.org/dist/$runtime_version/$runtime_archive" -o "$runtime_temp/$runtime_archive"
  curl -fSL "https://nodejs.org/dist/$runtime_version/SHASUMS256.txt" -o "$runtime_temp/SHASUMS256.txt"
  (cd "$runtime_temp"; awk -v file="$runtime_archive" '$2 == file { print }' SHASUMS256.txt | sha256sum -c -)
  runtime_node_dir="$HOME/.local/share/pi-bot/node"
  mkdir -p "$runtime_node_dir"
  tar -xJf "$runtime_temp/$runtime_archive" --strip-components=1 -C "$runtime_node_dir"
  export PATH="$runtime_node_dir/bin:$PATH"
fi
npm ci --ignore-scripts
npm install --no-save --package-lock=false --ignore-scripts --legacy-peer-deps --registry=https://registry.npmjs.org @agent-sh/computer-use-linux@0.7.16
node node_modules/@agent-sh/computer-use-linux/npm/install.js
npm run prepare:background
npm run gui:build
printf 'Installed. Node path: %s\nStart desktop: ./scripts/linux-desktop.sh start\n' "$(command -v node)"
