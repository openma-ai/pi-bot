#!/bin/bash
set -euo pipefail
exec 9>/data/profile-owner.lock
flock -n 9 || { echo "Shared profile is already owned by another runtime" >&2; exit 1; }
rm -f /data/profile/SingletonLock /data/profile/SingletonCookie /data/profile/SingletonSocket
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 5120x900x24 -nolisten tcp -ac &
for n in $(seq 1 100); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep .1; done
openbox >/data/openbox.log 2>&1 &
for n in 0 1 2 3; do xrandr --setmonitor "Pi-$n" "1280/340x900/240+$((n*1280))+0" none || true; done
chromium --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --user-data-dir=/data/profile --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 about:blank >/data/chromium.log 2>&1 &
exec node --import tsx /app/src/desktop-service.ts
