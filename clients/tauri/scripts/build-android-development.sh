#!/bin/sh
# Explicit arm64 SDK-enabled development build. Never installs the APK or logs in.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
[ -n "${ANDROID_HOME:-}" ] || { echo 'Set ANDROID_HOME to the existing Android SDK.' >&2; exit 1; }
[ -n "${NDK_HOME:-}" ] || { echo 'Set NDK_HOME to the existing Android NDK.' >&2; exit 1; }
sh "$root/scripts/build-embedded-tailscale.sh" android
library="$root/.tailscale-build/android/aarch64/libtailscale.so"
[ -f "$library" ] || { echo 'Embedded userspace SDK build did not produce its Android library.' >&2; exit 1; }
export PIBO_TAILSCALE_LIB_DIR="$root/.tailscale-build/android/aarch64"
cd "$root"
npm run build:gui
npm run tauri -- android build --features embedded-tailscale --debug --target aarch64 --apk --ci
