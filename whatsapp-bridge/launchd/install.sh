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
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed; logs: $home/bridge.log"
