#!/usr/bin/env bash
set -euo pipefail
MODE="${1:?Use local, publish, or execute}"
[[ "$MODE" == local || "$MODE" == publish || "$MODE" == execute ]] || exit 1
APP_ENV="${APP_ENV:-staging}"
[[ "$APP_ENV" == staging ]] || { echo 'Cloud smoke requires APP_ENV=staging' >&2; exit 1; }
REGION="${REGION:-us-central1}"
SHA=$(git rev-parse HEAD)
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || exit 1
EVIDENCE=cloud-smoke-evidence
JOB=gospel-staging-cloud-smoke

verify_local_proof() {
  jq -se --arg sha "$SHA" '
    map(select(.event == "cloud_smoke_verified")) |
    length == 1 and .[0].revision == $sha and .[0].execution == null and
    .[0].provider == "loopback-simulator" and .[0].submissions == 1 and
    .[0].attempts == 1 and .[0].status == "confirmed" and .[0].cleanup == true
  ' "$1" >/dev/null
}

local_proof() {
  mkdir -p "$EVIDENCE"
  rm -f "$EVIDENCE/success.json" "$EVIDENCE/execution.json"
  docker build --platform linux/amd64 --build-arg "RELEASE_SHA=$SHA" -f local-lab/Dockerfile.runtime -t "gospel-cloud-smoke-runtime:$SHA" .
  docker build --platform linux/amd64 --build-arg "RUNTIME_IMAGE=gospel-cloud-smoke-runtime:$SHA" -f local-lab/cloud-smoke/Dockerfile -t "gospel-cloud-smoke:$SHA" .
  docker run --rm --network none -e APP_ENV=staging "gospel-cloud-smoke:$SHA" | tee "$EVIDENCE/local.jsonl"
  verify_local_proof "$EVIDENCE/local.jsonl"
}

if [[ "$MODE" == local ]]; then
  local_proof
  exit
fi
: "${GCP_PROJECT_ID:?Set the staging GCP project ID}"
[[ "$GCP_PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || exit 1
[[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || exit 1
REPOSITORY="$REGION-docker.pkg.dev/$GCP_PROJECT_ID/gospel/cloud-smoke"

if [[ "$MODE" == publish ]]; then
  [[ -z "$(git status --porcelain)" ]] || { echo 'Commit source changes before publishing' >&2; exit 1; }
  [[ "${GITHUB_SHA:-$SHA}" == "$SHA" ]] || { echo 'GITHUB_SHA differs from the checked out source' >&2; exit 1; }
  local_proof
  gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
  ERROR_FILE=$(mktemp)
  trap 'rm -f "$ERROR_FILE"' EXIT
  if DIGEST=$(gcloud artifacts docker images describe "$REPOSITORY:$SHA" --project="$GCP_PROJECT_ID" --format='value(image_summary.digest)' 2>"$ERROR_FILE"); then
    [[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
    docker pull "$REPOSITORY@$DIGEST"
    docker run --rm --network none -e APP_ENV=staging "$REPOSITORY@$DIGEST" | tee "$EVIDENCE/published.jsonl"
    verify_local_proof "$EVIDENCE/published.jsonl"
  else
    grep -Eq 'NOT_FOUND|Image not found\.' "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
    docker tag "gospel-cloud-smoke:$SHA" "$REPOSITORY:$SHA"
    docker push "$REPOSITORY:$SHA"
    DIGEST=$(gcloud artifacts docker images describe "$REPOSITORY:$SHA" --project="$GCP_PROJECT_ID" --format='value(image_summary.digest)')
  fi
  [[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
  printf '%s@%s\n' "$REPOSITORY" "$DIGEST" > smoke-image.txt
  cp smoke-image.txt "$EVIDENCE/smoke-image.txt"
  printf '%s\n' "$SHA" > "$EVIDENCE/release-sha.txt"
  exit
fi
mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE/success.json" "$EVIDENCE/execution.json"
IMAGE=$(cat smoke-image.txt)
[[ "$IMAGE" == "$REPOSITORY@"* ]] || exit 1
DIGEST="${IMAGE#"$REPOSITORY@"}"
[[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
cp smoke-image.txt "$EVIDENCE/smoke-image.txt"
docker pull "$IMAGE"
docker image inspect --format '{{json .Config.Labels}}' "$IMAGE" > "$EVIDENCE/image-labels.json"
jq -e --arg sha "$SHA" '.["org.opencontainers.image.revision"] == $sha and .["io.gospel.image-purpose"] == "cloud-smoke"' "$EVIDENCE/image-labels.json" >/dev/null
gcloud run jobs update "$JOB" --image="$IMAGE" --command=node --args=/verification/run.mjs --region="$REGION" --project="$GCP_PROJECT_ID" --quiet
EXECUTION=$(gcloud run jobs execute "$JOB" --async --region="$REGION" --project="$GCP_PROJECT_ID" --format='value(metadata.name)' 2> "$EVIDENCE/launch.log")
[[ "$EXECUTION" =~ ^gospel-staging-cloud-smoke-[a-z0-9]+$ ]] || exit 1
for ((attempt=0; attempt<60; attempt++)); do
  gcloud run jobs executions describe "$EXECUTION" --region="$REGION" --project="$GCP_PROJECT_ID" --format=json > "$EVIDENCE/execution.json"
  if jq -e 'any(.status.conditions[]?; .type == "Completed" and (.status == "True" or .status == "False"))' "$EVIDENCE/execution.json" >/dev/null; then
    break
  fi
  sleep 5
done
jq -e --arg image "$IMAGE" --arg execution "$EXECUTION" --arg job "$JOB" '
  .metadata.name == $execution and
  .metadata.labels["run.googleapis.com/job"] == $job and
  .spec.taskCount == 1 and
  .spec.template.spec.containers[0].image == $image and
  .spec.template.spec.containers[0].command == ["node"] and
  .spec.template.spec.containers[0].args == ["/verification/run.mjs"] and
  (.spec.template.spec.containers | length) == 1 and
  .status.succeededCount == 1 and
  (.status.failedCount // 0) == 0 and
  (.status.cancelledCount // 0) == 0 and
  any(.status.conditions[]; .type == "Completed" and .status == "True")
' "$EVIDENCE/execution.json" >/dev/null
jq -n --arg execution "$EXECUTION" --arg image "$IMAGE" --arg sha "$SHA" \
  '{execution: $execution, image: $image, checkout_revision: $sha, success: true}' > "$EVIDENCE/success.json"
cat "$EVIDENCE/success.json"
