#!/bin/sh
# Build only: never starts a node or changes host network configuration.
set -eu
platform=${1:-macos}
case "$platform" in macos|ios|ios-sim) ;; *) echo 'Use macos, ios, or ios-sim' >&2; exit 2;; esac
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
case "$platform" in
 macos) make -C "$source" c-archive; archive=libtailscale.a ;;
 ios) make -C "$source" c-archive-ios; archive=libtailscale_ios.a ;;
 ios-sim) make -C "$source" c-archive-ios-sim; archive=libtailscale_ios_sim.a ;;
esac
output="$root/.tailscale-build/$platform"
mkdir -p "$output"
cp "$source/$archive" "$output/libtailscale.a"
echo "PIBO_TAILSCALE_LIB_DIR=$output"
