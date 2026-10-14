#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v systemctl >/dev/null || { echo 'systemd is required. Alternatively run linux-runtime.sh directly.' >&2; exit 1; }
runtime_node=$(command -v node || true)
if [ -x "$HOME/.local/share/pi-bot/node/bin/node" ]; then runtime_node="$HOME/.local/share/pi-bot/node/bin/node"; fi
test -n "$runtime_node" || { echo 'Install Node 24+ first.' >&2; exit 1; }
mkdir -p "$HOME/.config/systemd/user"
# systemd quoted paths: reject newline/quote/specifier rather than generate an ambiguous unit.
case "$PWD$runtime_node" in *$'\n'*|*'"'*|*'%'*|*'\\'*) echo 'Choose a project path without newline, quote, backslash or percent.' >&2; exit 1;; esac
cat > "$HOME/.config/systemd/user/pi-bot-runtime.service" <<UNIT
[Unit]
Description=Pi Bot server and Linux desktop
After=network.target

[Service]
Type=simple
WorkingDirectory="$PWD"
Environment="PATH=$(dirname "$runtime_node"):/usr/local/bin:/usr/bin:/bin"
ExecStart=/bin/bash "$PWD/scripts/linux-runtime.sh"
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now pi-bot-runtime.service
printf '%s\n' 'Service installed for this user. Enable linger to keep it running after logout: sudo loginctl enable-linger "$(whoami)"'
