#!/bin/bash
set -euo pipefail
export HOME=/data/home DISPLAY=:99 XDG_SESSION_TYPE=x11 GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0
mkdir -p "$HOME" /data/profile /data/screens /app/work/gui/desktop
ln -s /data/control.json /app/work/gui/desktop/control.json
exec dbus-run-session -- /bin/bash -c '
/app/container/run-desktop.sh --port 8091 --bind 127.0.0.1 --url http://127.0.0.1:8091 --same-runtime & desktop=$!
trap "kill $desktop 2>/dev/null || true" EXIT
node --import tsx /app/clients/tauri/test/tailnet-docker/direct/wait-broker.ts
node --import tsx /app/clients/tauri/test/tailnet-docker/direct/runtime.ts
'
