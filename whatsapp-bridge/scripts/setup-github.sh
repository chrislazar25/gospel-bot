#!/bin/bash
# One-time, idempotent: creates the benny labels and the benny-media branch the bridge uploads photos to.
set -euo pipefail
repo="${GITHUB_REPO:-chrislazar25/gospel-bot}"
cd "$(dirname "$0")/.."
npx tsc
labels=$(node --input-type=module -e "
import { TABLE, REPORT_LABEL } from './dist/states.js';
console.log([REPORT_LABEL, 'benny:triage-again', ...Object.values(TABLE).map((r) => r.label).filter(Boolean)].join('\n'));")
while read -r label; do
  gh label create "$label" --repo "$repo" --color 5319e7 --force >/dev/null
  echo "label $label"
done <<< "$labels"

if gh api "repos/$repo/git/ref/heads/benny-media" >/dev/null 2>&1; then
  echo "branch benny-media exists"
else
  blob=$(gh api "repos/$repo/git/blobs" -f encoding=utf-8 -f content=$'Photos from WhatsApp reports, uploaded by whatsapp-bridge.\n' --jq .sha)
  tree=$(gh api "repos/$repo/git/trees" -f 'tree[][path]=README.md' -f 'tree[][mode]=100644' -f 'tree[][type]=blob' -f "tree[][sha]=$blob" --jq .sha)
  commit=$(gh api "repos/$repo/git/commits" -f message='chore: start benny-media branch for report photos' -f "tree=$tree" --jq .sha)
  gh api "repos/$repo/git/refs" -f ref=refs/heads/benny-media -f "sha=$commit" >/dev/null
  echo "branch benny-media created"
fi
