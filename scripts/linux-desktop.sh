#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -x "$HOME/.local/share/pi-bot/node/bin/node" ]; then export PATH="$HOME/.local/share/pi-bot/node/bin:$PATH"; fi
runtime_project="$PWD"
runtime_state="$runtime_project/work/gui/desktop/native"
runtime_pid="$runtime_state/desktop.pid"
mkdir -p "$runtime_state/profile" "$runtime_state/screens"
chmod 700 "$runtime_state"
runtime_command=${1:-start}
if [ "$runtime_command" = stop ]; then
  if [ -f "$runtime_pid" ]; then
    runtime_stopped=$(cat "$runtime_pid")
    kill "$runtime_stopped" 2>/dev/null || true
    for runtime_attempt in $(seq 1 50); do kill -0 "$runtime_stopped" 2>/dev/null || break; sleep .1; done
  fi
  exit
fi
if [ "$runtime_command" = start ]; then
  if [ -f "$runtime_pid" ] && kill -0 "$(cat "$runtime_pid")" 2>/dev/null; then echo 'Desktop already running'; exit; fi
  nohup dbus-run-session -- "$runtime_project/scripts/linux-desktop.sh" foreground >"$runtime_state/desktop.log" 2>&1 &
  runtime_started=$!
  printf '%s\n' "$runtime_started" > "$runtime_state/launcher.pid"
  for runtime_attempt in $(seq 1 150); do
    if [ -f "$runtime_state/control.json" ] && node --input-type=module - "$runtime_state/control.json" <<'JS'
import {readFileSync} from 'node:fs';
const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
try { const r=await fetch(c.url+'/state',{headers:{authorization:'Bearer '+c.token},signal:AbortSignal.timeout(500)});process.exit(r.ok?0:1); } catch { process.exit(1); }
JS
    then
      ln -sfn "$runtime_state/control.json" "$runtime_project/work/gui/desktop/control.json"
      echo 'Desktop ready on this machine. Restart the Pi server if already running.'
      exit
    fi
    kill -0 "$runtime_started" 2>/dev/null || break
    sleep .2
  done
  if [ -f "$runtime_pid" ]; then kill "$(cat "$runtime_pid")" 2>/dev/null || true; fi
  kill "$runtime_started" 2>/dev/null || true
  echo 'Desktop did not become ready; inspect work/gui/desktop/native/desktop.log' >&2
  exit 1
fi
test "$runtime_command" = foreground || { echo 'Usage: linux-desktop.sh start|stop|foreground' >&2; exit 1; }
test "$(uname -s)" = Linux || { echo 'Linux is required for this desktop.' >&2; exit 1; }
for runtime_tool in Xvfb openbox chromium x11vnc xdotool wmctrl xrandr dbus-run-session; do command -v "$runtime_tool" >/dev/null || { echo "Missing desktop dependency: $runtime_tool" >&2; exit 1; }; done
test -f node_modules/@agent-sh/computer-use-linux/pi/extension/index.ts || { echo 'Run setup-linux-desktop.sh first.' >&2; exit 1; }
exec 9>"$runtime_state/profile-owner.lock"
flock -n 9 || { echo 'Shared desktop profile is already owned.' >&2; exit 1; }
printf '%s\n' "$$" > "$runtime_pid"
rm -f "$runtime_state/profile/SingletonLock" "$runtime_state/profile/SingletonCookie" "$runtime_state/profile/SingletonSocket"
export DISPLAY=:99 XDG_SESSION_TYPE=x11 GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0
runtime_children=()
trap 'for runtime_child in "${runtime_children[@]}"; do kill "$runtime_child" 2>/dev/null || true; done; wait || true; rm -f "$runtime_pid"' EXIT
trap 'exit 0' TERM INT
# Never remove another user's X lock. Xvfb refuses an occupied display.
Xvfb :99 -screen 0 5120x900x24 -nolisten tcp 9>&- & runtime_children+=("$!")
for runtime_attempt in $(seq 1 100); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep .1; done
kill -0 "${runtime_children[0]}" || exit 1
openbox >"$runtime_state/openbox.log" 2>&1 9>&- & runtime_children+=("$!")
for runtime_screen in 0 1 2 3; do xrandr --setmonitor "Pi-$runtime_screen" "1280/340x900/240+$((runtime_screen*1280))+0" none || true; done
runtime_browser_args=(); if [ "$(id -u)" = 0 ]; then runtime_browser_args+=(--no-sandbox); fi
chromium "${runtime_browser_args[@]}" --disable-dev-shm-usage --no-first-run --no-default-browser-check --user-data-dir="$runtime_state/profile" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 about:blank >"$runtime_state/chromium.log" 2>&1 9>&- & runtime_children+=("$!")
node --import tsx src/daemon/desktop-service.ts --root "$runtime_state" --port 6090 --url http://127.0.0.1:6090 --bind 127.0.0.1 --same-runtime 9>&- & runtime_children+=("$!")
wait "${runtime_children[-1]}"
