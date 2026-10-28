#!/bin/sh
# Build only: never starts a node or changes host network configuration.
set -eu
platform=${1:-macos}
case "$platform" in macos|ios|ios-sim|android) ;; *) echo 'Use macos, ios, ios-sim, or android (arm64 API24+)' >&2; exit 2;; esac
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
revision=d1dc45d039edb7759ecbee6ba2aea0c4bca884b8
source=${PIBO_LIBTAILSCALE_SOURCE:-"$root/.tailscale-build/source"}
if [ ! -d "$source/.git" ]; then
  mkdir -p "$source"
  git -C "$source" init
  git -C "$source" remote add origin https://github.com/tailscale/libtailscale.git
  git -C "$source" fetch --depth 1 origin "$revision"
  git -C "$source" checkout --detach FETCH_HEAD
fi
[ "$(git -C "$source" rev-parse HEAD)" = "$revision" ] || { echo 'libtailscale revision mismatch' >&2; exit 1; }
# Overlay our process-local socket policy without changing the pinned SDK tree.
overlay=$(mktemp -t pibo-tailscale-overlay)
trap 'rm -f "$overlay"' EXIT HUP INT TERM
python3 - "$source" "$root/native-tailscale/pibo_system_routing.go" "$overlay" <<'PYOVERLAY'
import json,sys
from pathlib import Path
Path(sys.argv[3]).write_text(json.dumps({"Replace":{str(Path(sys.argv[1]).resolve()/"pibo_system_routing.go"):str(Path(sys.argv[2]).resolve())}}))
PYOVERLAY
export GOFLAGS="${GOFLAGS:-} -overlay=$overlay"
if [ "$platform" = android ]; then
  # Reuse the installed official NDK. This is a userspace shared library, not a VPN
  # service, TUN permission, or Android network configuration change.
  [ -n "${NDK_HOME:-}" ] || { echo 'Set NDK_HOME to an existing Android NDK' >&2; exit 1; }
  case "$(uname -s)" in Darwin) host=darwin-x86_64;; Linux) host=linux-x86_64;; *) echo 'Android archive build host must be macOS or Linux' >&2; exit 1;; esac
  compiler="$NDK_HOME/toolchains/llvm/prebuilt/$host/bin/aarch64-linux-android24-clang"
  [ -x "$compiler" ] || { echo 'Existing NDK arm64 API24 compiler not found' >&2; exit 1; }
  output="$root/.tailscale-build/android/aarch64"
  mkdir -p "$output"
  # Go supports c-shared (not c-archive) on Android. Package its DT_NEEDED library
  # beside Tauri's native library so the app never depends on host-installed code.
  (cd "$source" && CGO_ENABLED=1 GOOS=android GOARCH=arm64 CC="$compiler" go build -mod=readonly -buildmode=c-shared -o "$output/libtailscale.so")
  jni="$root/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
  mkdir -p "$jni"
  cp "$output/libtailscale.so" "$jni/libtailscale.so"
  echo "Library ready: $output (Android arm64 API24+, userspace only)"
  exit 0
fi
case "$platform" in
 macos) make -B -C "$source" PWD="$source" c-archive; archive=libtailscale.a ;;
 ios) make -B -C "$source" PWD="$source" c-archive-ios; archive=libtailscale_ios.a ;;
 ios-sim) make -B -C "$source" PWD="$source" c-archive-ios-sim; archive=libtailscale_ios_sim.a ;;
esac
output="$root/.tailscale-build/$platform"
mkdir -p "$output"
if [ "$platform" = ios-sim ]; then
  # rustc's static archive bundler cannot consume a universal Mach-O archive.
  for pair in arm64:aarch64 x86_64:x86_64; do
    arch=${pair%%:*}; rustarch=${pair#*:}
    mkdir -p "$output/$rustarch"
    lipo "$source/$archive" -thin "$arch" -output "$output/$rustarch/libtailscale.a"
  done
else
  cp "$source/$archive" "$output/libtailscale.a"
fi
echo "Archives ready: $output (ios-sim: select aarch64 or x86_64 subdirectory)"
