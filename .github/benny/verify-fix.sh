#!/usr/bin/env bash
set -euo pipefail

dir="$RUNNER_TEMP/benny"
[[ "$(jq -r .outcome "$dir/fix-result.json")" == pr ]] || exit 0

git add -A
while IFS= read -r -d '' path; do
  case "$path" in
    .github/*|.opencode/*|infra/*|scripts/cloud/*|local-lab/migrations/*)
      echo "::error::The proposed fix touches a protected path."
      exit 1
      ;;
  esac
done < <(git diff --cached --name-only -z --no-renames)

git diff --cached --quiet && exit 0
verify() {
  node --test tests/content.test.js || return
  if ! git diff --cached --quiet -- whatsapp-bridge/; then
    npm ci --prefix whatsapp-bridge && npm run check --prefix whatsapp-bridge && npm test --prefix whatsapp-bridge || return
  fi
  if ! git diff --cached --quiet -- local-lab/; then
    npm run check --prefix local-lab && node local-lab/verify-runtime.mjs || return
    if ! git diff --cached --quiet -- local-lab/src/delivery.ts; then
      node local-lab/verify.mjs all || return
    fi
    if ! git diff --cached --quiet -- local-lab/src/runtime.ts local-lab/src/green-api.ts local-lab/src/status.ts; then
      node local-lab/verify-image.mjs || return
    fi
  fi
}
if ! verify > "$dir/fix-checks.log" 2>&1; then
  echo "::error::The proposed fix did not pass verification."
  exit 1
fi
echo "Benny fix verification passed."
