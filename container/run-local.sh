#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p work/gui/desktop
docker run -d --name pi-bot-desktop --shm-size=1g -p 127.0.0.1:6090:8080 -v pi-bot-desktop-data:/data pi-bot-desktop:local
for n in $(seq 1 100); do
  if docker exec pi-bot-desktop node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("/data/control.json"));fetch("http://127.0.0.1:8080/state",{headers:{authorization:"Bearer "+c.token}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' ; then
    docker cp pi-bot-desktop:/data/control.json work/gui/desktop/control.json
    chmod 600 work/gui/desktop/control.json
    break
  fi
  sleep .2
done
test -f work/gui/desktop/control.json || { echo 'Desktop readiness timed out'; exit 1; }
printf '%s\n' 'Desktop started. Restart the local GUI to load the desktop connection.'
