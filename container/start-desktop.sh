#!/bin/bash
set -euo pipefail
export HOME=/data/home
export DISPLAY=:99
export XDG_SESSION_TYPE=x11
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0
mkdir -p "$HOME" /data/profile /data/screens
exec dbus-run-session -- /app/container/run-desktop.sh
