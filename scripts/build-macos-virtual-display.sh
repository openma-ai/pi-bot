#!/bin/bash
# Build the CGVirtualDisplay companion keeper (Command Line Tools swiftc is enough).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ]; then
  echo 'build-macos-virtual-display.sh targets macOS only.' >&2
  exit 1
fi
SRC=native/macos/VirtualDisplayCompanion.swift
OUT_DIR="${PI_BOT_MACOS_VD_BIN_DIR:-$HOME/Library/Application Support/pi-bot/bin}"
OUT="$OUT_DIR/pi-virtual-display-companion"
mkdir -p "$OUT_DIR"
if ! command -v swiftc >/dev/null; then
  echo 'swiftc not found (install Xcode Command Line Tools).' >&2
  exit 1
fi
echo "Compiling $SRC -> $OUT"
swiftc -O -framework Foundation -framework CoreGraphics -framework AppKit -o "$OUT" "$SRC"
chmod +x "$OUT"
echo "Built $OUT"
