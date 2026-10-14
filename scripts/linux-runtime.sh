#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -x "$HOME/.local/share/pi-bot/node/bin/node" ]; then export PATH="$HOME/.local/share/pi-bot/node/bin:$PATH"; fi
runtime_owns_desktop=false
runtime_pid_file=work/gui/desktop/native/desktop.pid
if [ ! -f "$runtime_pid_file" ] || ! kill -0 "$(cat "$runtime_pid_file")" 2>/dev/null; then runtime_owns_desktop=true; fi
./scripts/linux-desktop.sh start
runtime_server_pid=''
cleanup() {
  if [ -n "$runtime_server_pid" ]; then kill "$runtime_server_pid" 2>/dev/null || true; wait "$runtime_server_pid" 2>/dev/null || true; fi
  if $runtime_owns_desktop; then ./scripts/linux-desktop.sh stop || true; fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT
node --import tsx src/daemon/main.ts daemon --listen http://127.0.0.1:4318 "$@" &
runtime_server_pid=$!
wait "$runtime_server_pid"
