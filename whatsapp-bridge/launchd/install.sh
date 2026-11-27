#!/bin/bash
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)"
home="${BRIDGE_HOME:-$HOME/.gospel-bridge}"
label=com.chrislazar.gospel-bridge
plist="$HOME/Library/LaunchAgents/$label.plist"
[ -f "$home/bridge.env" ] || { echo "missing $home/bridge.env (REPORT_GROUP_JID=...)"; exit 2; }
[ -f "$home/auth/creds.json" ] || { echo "not linked: run npm run link first"; exit 2; }

(cd "$src" && npm ci --silent && npx tsc)
mkdir -p "$home/app"
rsync -a --delete "$src/dist" "$src/package.json" "$src/package-lock.json" "$src/launchd/run.sh" "$home/app/"
(cd "$home/app" && npm ci --omit=dev --silent)
chmod 700 "$home" "$home/app"

sed "s#__HOME__#$home#g" "$src/launchd/$label.plist" > "$plist"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
# bootout returns before the old bridge exits; starting early would find its port held and exit.
for _ in $(seq 1 30); do pgrep -f "$home/app/dist/main.js" >/dev/null || break; sleep 1; done
if pgrep -f "$home/app/dist/main.js" >/dev/null; then
  echo "the old bridge is still running after 30 s; not starting the new one. Stop it (pkill -f $home/app/dist/main.js), then rerun install.sh." >&2
  exit 1
fi
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed; logs: $home/bridge.log"
