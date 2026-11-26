#!/bin/bash
set -u
home="${BRIDGE_HOME:-$HOME/.gospel-bridge}"
[ -f "$home/bridge.env" ] && set -a && . "$home/bridge.env" && set +a
GITHUB_TOKEN="$(security find-generic-password -s gospel-bridge-github -a "$USER" -w)" || { echo '{"event":"fatal","error":"keychain token missing"}'; exit 2; }
export GITHUB_TOKEN BRIDGE_HOME="$home"
node "$home/app/dist/main.js"
code=$?
# 3 means WhatsApp needs relinking. Restarting cannot fix that, so stop cleanly and tell Chris.
if [ "$code" -eq 3 ]; then
  osascript -e 'display notification "Relink it: npm run link in whatsapp-bridge" with title "Gospel bridge stopped"'
  exit 0
fi
exit "$code"
