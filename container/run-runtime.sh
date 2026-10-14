#!/bin/bash
set -euo pipefail
cd /app
runtime_port=${1:-4317}
runtime_desktop_pid='' runtime_client_pid=''
cleanup() {
  if [ -n "$runtime_client_pid" ]; then kill "$runtime_client_pid" 2>/dev/null || true; fi
  node --import tsx src/daemon/main.ts stop --data-dir /data/runtime >/dev/null 2>&1 || true
  if [ -n "$runtime_desktop_pid" ]; then kill "$runtime_desktop_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT
/app/container/run-desktop.sh --url http://127.0.0.1:8080 --same-runtime & runtime_desktop_pid=$!
runtime_ready=false
for runtime_attempt in $(seq 1 150); do
  if [ -f /data/control.json ] && node --input-type=module - <<'JS'
import {readFileSync} from 'node:fs';
const c=JSON.parse(readFileSync('/data/control.json','utf8'));
try{const r=await fetch(c.url+'/state',{headers:{authorization:'Bearer '+c.token},signal:AbortSignal.timeout(500)});process.exit(r.ok?0:1);}catch{process.exit(1);}
JS
  then runtime_ready=true; break; fi
  kill -0 "$runtime_desktop_pid" 2>/dev/null || break
  sleep .2
done
$runtime_ready || { echo 'Runtime desktop did not become ready' >&2; exit 1; }
mkdir -p work/gui/desktop
ln -sfn /data/control.json work/gui/desktop/control.json
node --import tsx src/daemon/main.ts client --data-dir /data/runtime --client-dir /data/client --port "$runtime_port" --bind 0.0.0.0 & runtime_client_pid=$!
wait -n "$runtime_client_pid" "$runtime_desktop_pid"
