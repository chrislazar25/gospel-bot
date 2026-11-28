#!/usr/bin/env bash
set -euo pipefail

dir="$RUNNER_TEMP/benny"
[[ "$(jq -r .outcome "$dir/fix-result.json")" == pr ]] || exit 0

git add -A
if [[ "${DELIVERY_REPRO:-false}" != true ]] &&
  git diff --cached --quiet -- local-lab/src/{delivery,runtime,green-api,content,status}.ts local-lab/schema.sql local-lab/migrations local-lab/config local-lab/compose.yaml; then
  exit 0
fi

probe="$PWD/local-lab/benny-repros/$ISSUE.mjs"
[[ -f "$probe" && ! -L "$probe" ]] || {
  echo "::error::A delivery draft needs a local-lab reproduction for issue #$ISSUE."
  exit 1
}

scratch=$(mktemp -d "$RUNNER_TEMP/benny-delivery.XXXXXX")
baseline="$scratch/baseline"
trap 'git worktree remove --force "$baseline" >/dev/null 2>&1 || true' EXIT
git worktree add --quiet --detach "$baseline" HEAD
cp "$probe" "$scratch/repro.mjs"

run_probe() (
  cd "$1"
  export LAB_RUN_STATE="$scratch/$2.json"
  trap 'node local-lab/verify.mjs cleanup' EXIT
  node local-lab/verify.mjs launch
  node local-lab/verify.mjs doctor
  status=0
  node "$scratch/repro.mjs" "$LAB_RUN_STATE" || status=$?
  node local-lab/verify.mjs cleanup
  trap - EXIT
  if [[ "$status" != "$3" ]]; then
    echo "::error::Delivery reproduction $2 expected exit $3, got $status."
    exit 1
  fi
  echo "Delivery reproduction $2: exit $status as expected."
)

run_probe "$baseline" baseline 42
run_probe "$PWD" proposed 0
