#!/bin/bash
set -u
home="${BRIDGE_HOME:-$HOME/.gospel-bridge}"
[ -f "$home/bridge.env" ] && set -a && . "$home/bridge.env" && set +a
GITHUB_TOKEN="$(security find-generic-password -s gospel-bridge-github -a "$USER" -w)" || { echo '{"event":"fatal","error":"keychain token missing"}'; exit 2; }
export GITHUB_TOKEN BRIDGE_HOME="$home"
node "$home/app/dist/main.js"
code=$?
# 3 means WhatsApp logged the bridge out or another session took over. Restarting would fight
# for the account, so stop cleanly and tell Chris; the last log line says which.
if [ "$code" -eq 3 ]; then
  reason=$(grep -oE '"event":"wa_[a-z_]+"|"event":"not_linked"' "$home/bridge.log" | tail -1 | cut -d'"' -f4)
  osascript -e "display notification \"Stopped ($reason). See ~/.gospel-bridge/bridge.log\" with title \"Gospel bridge stopped\""
  exit 0
fi
exit "$code"
