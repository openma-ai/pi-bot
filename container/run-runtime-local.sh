#!/bin/bash
set -euo pipefail
docker run -d --name pi-bot-runtime --shm-size=1g --stop-timeout=45 -p 127.0.0.1:4317:4317 -v pi-bot-runtime-data:/data pi-bot-runtime:local --runtime
printf '%s\n' 'Open http://127.0.0.1:4317/ and configure Pi in Settings.'
