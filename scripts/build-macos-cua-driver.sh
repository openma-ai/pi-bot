#!/usr/bin/env bash
# Build trycua/cua cua-driver (MIT) for per-pid input: AX → SkyLight SLEventPostToPid → CGEvent.postToPid.
# Needs Rust (rustup) + Command Line Tools. Runtime needs Accessibility (and Screen Recording for
# its window screenshots) granted to the cua-driver binary — a user action in System Settings.
set -euo pipefail
REV=07460674e1924ba2ed1219e858c31647bc206669
SRC="${PI_BOT_CUA_SRC:-$HOME/Library/Caches/pi-bot/cua-$REV}"
OUT_DIR="${PI_BOT_MACOS_VD_BIN_DIR:-$HOME/Library/Application Support/pi-bot/bin}"
if [ ! -d "$SRC/.git" ]; then
  git clone -q --filter=blob:none --sparse https://github.com/trycua/cua "$SRC"
  git -C "$SRC" sparse-checkout set libs/cua-driver
fi
git -C "$SRC" fetch -q --depth 1 origin "$REV" || true
git -C "$SRC" checkout -q "$REV"
(cd "$SRC/libs/cua-driver/rust" && cargo build -p cua-driver --release)
mkdir -p "$OUT_DIR"
cp "$SRC/libs/cua-driver/rust/target/release/cua-driver" "$OUT_DIR/cua-driver"
echo "$OUT_DIR/cua-driver"
