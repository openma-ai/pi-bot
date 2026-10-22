#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../../../.." && pwd)
build=$(mktemp -d /tmp/pibo-tailnet-abi.XXXXXX)
trap 'rm -rf "$build"' EXIT
clang -c "$root/clients/tauri/test/tailscale-offline/stub.c" -o "$build/stub.o"
ar rcs "$build/libtailscale.a" "$build/stub.o"
filter=${1-tailscale_offline}
if [ "$#" -gt 0 ]; then shift; fi
PIBO_TAILSCALE_LIB_DIR="$build" PIBO_TAILSCALE_OFFLINE_TEST=1 cargo test --manifest-path "$root/clients/tauri/src-tauri/Cargo.toml" --features embedded-tailscale,client-fixtures --lib "$filter" -- --test-threads=1 "$@"
