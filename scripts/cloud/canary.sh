#!/usr/bin/env bash
set -euo pipefail
MODE="${1:?Use validate, publish, or execute}"
[[ $# == 1 || ( $# == 2 && "$MODE" == validate ) ]] || exit 1
if [[ "$MODE" == validate ]]; then
  ACTION="${2:?Choose publish or execute}"
else
  ACTION="$MODE"
fi
[[ "$ACTION" == publish || "$ACTION" == execute ]] || exit 1
[[ "${APP_ENV:-}" == staging ]] || { echo 'Canary requires staging' >&2; exit 1; }
[[ "${BUILD_ONLY:-false}" == false && "${SMOKE_ONLY:-false}" == false && -z "${STAGING_RUN:-}" ]] || { echo 'Conflicting release options' >&2; exit 1; }
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_REF:-}" == refs/heads/master && "${GITHUB_JOB:-}" == canary ]] || exit 1
[[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 1
[[ "${GITHUB_WORKFLOW_REF:-}" == "$GITHUB_REPOSITORY/.github/workflows/release.yml@refs/heads/master" ]] || exit 1
REGION="${REGION:-us-central1}"
: "${GCP_PROJECT_ID:?Set the staging GCP project ID}"
[[ "$GCP_PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ && "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || exit 1
SHA=$(git rev-parse HEAD)
[[ "$SHA" =~ ^[a-f0-9]{40}$ && "${GITHUB_SHA:-$SHA}" == "$SHA" ]] || exit 1
REPOSITORY="$REGION-docker.pkg.dev/$GCP_PROJECT_ID/gospel/canary"
if [[ "$ACTION" == execute ]]; then
  [[ "${CANARY_REVISION:-}" == "$SHA" ]] || { echo 'Canary revision must match the reviewed checkout' >&2; exit 1; }
  IMAGE="${CANARY_IMAGE:?Set the reviewed CANARY_IMAGE digest}"
  [[ "$IMAGE" == "$REPOSITORY@"* ]] || exit 1
  DIGEST="${IMAGE#"$REPOSITORY@"}"
  [[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
fi
[[ "$MODE" != validate ]] || exit 0
EVIDENCE=canary-evidence
JOB=gospel-staging-canary
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail() { echo 'Canary command failed; review the scoped execution with an authorized operator' >&2; exit 1; }
inspect_image() {
  docker pull --platform linux/amd64 "$1" >"$WORK/pull.log" 2>&1 || fail
  docker image inspect --format '{{json .Config.Labels}}' "$1" >"$WORK/labels.json" 2>"$WORK/error" || fail
  jq -e --arg sha "$SHA" '.["org.opencontainers.image.revision"] == $sha and .["io.gospel.image-purpose"] == "canary"' "$WORK/labels.json" >/dev/null || fail
}
if [[ "$ACTION" == publish && -n "$(git status --porcelain)" ]]; then
  echo 'Commit source changes before publishing' >&2; exit 1
fi
mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE/success.json" "$EVIDENCE/execution.json" "$EVIDENCE/publication.json" "$EVIDENCE/canary-image.txt" "$EVIDENCE/canary-revision.txt"
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >"$WORK/auth.log" 2>&1 || fail
if [[ "$ACTION" == publish ]]; then
  if DIGEST=$(gcloud artifacts docker images describe "$REPOSITORY:$SHA" --project="$GCP_PROJECT_ID" --format='value(image_summary.digest)' 2>"$WORK/error"); then
    [[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || fail
  else
    grep -Eq 'NOT_FOUND|Image not found\.' "$WORK/error" || fail
    docker build --platform linux/amd64 --build-arg "RELEASE_SHA=$SHA" --label io.gospel.image-purpose=canary -f local-lab/Dockerfile.runtime -t "$REPOSITORY:$SHA" . >"$WORK/build.log" 2>&1 || fail
    docker push --platform linux/amd64 "$REPOSITORY:$SHA" >"$WORK/push.log" 2>&1 || fail
    DIGEST=$(gcloud artifacts docker images describe "$REPOSITORY:$SHA" --project="$GCP_PROJECT_ID" --format='value(image_summary.digest)' 2>"$WORK/error") || fail
  fi
  [[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || fail
  IMAGE="$REPOSITORY@$DIGEST"
  inspect_image "$IMAGE"
  mkdir -p "$EVIDENCE"
  printf '%s\n' "$IMAGE" > "$EVIDENCE/canary-image.txt"
  printf '%s\n' "$SHA" > "$EVIDENCE/canary-revision.txt"
  jq -n --arg image "$IMAGE" --arg revision "$SHA" '{event:"canary_published",image:$image,revision:$revision}' > "$EVIDENCE/publication.json"
  cat "$EVIDENCE/publication.json"
  exit
fi
inspect_image "$IMAGE"
gcloud run jobs update "$JOB" --image="$IMAGE" --command=node --args=dist/canary.js --region="$REGION" --project="$GCP_PROJECT_ID" --quiet >"$WORK/update.log" 2>&1 || fail
EXECUTION=$(gcloud run jobs execute "$JOB" --async --region="$REGION" --project="$GCP_PROJECT_ID" --format='value(metadata.name)' 2>"$WORK/error") || fail
[[ "$EXECUTION" =~ ^gospel-staging-canary-[a-z0-9]+$ ]] || fail
for ((attempt=0; attempt<60; attempt++)); do
  gcloud run jobs executions describe "$EXECUTION" --region="$REGION" --project="$GCP_PROJECT_ID" --format=json > "$WORK/execution.json" 2>"$WORK/error" || fail
  jq --arg execution "$EXECUTION" --arg image "$IMAGE" --arg revision "$SHA" '{execution:$execution,image:$image,revision:$revision,succeeded:(.status.succeededCount // 0),failed:(.status.failedCount // 0),cancelled:(.status.cancelledCount // 0),conditions:[.status.conditions[]? | {type,status}]}' "$WORK/execution.json" > "$EVIDENCE/execution.json" || fail
  if jq -e 'any(.status.conditions[]?; .type == "Completed" and (.status == "True" or .status == "False"))' "$WORK/execution.json" >/dev/null; then break; fi
  sleep 5
done
jq -e --arg image "$IMAGE" --arg execution "$EXECUTION" --arg job "$JOB" '
  .metadata.name == $execution and .metadata.labels["run.googleapis.com/job"] == $job and
  .spec.taskCount == 1 and (.spec.template.spec.containers | length) == 1 and
  .spec.template.spec.containers[0].image == $image and
  .spec.template.spec.containers[0].command == ["node"] and .spec.template.spec.containers[0].args == ["dist/canary.js"] and
  .status.succeededCount == 1 and (.status.failedCount // 0) == 0 and (.status.cancelledCount // 0) == 0 and
  any(.status.conditions[]; .type == "Completed" and .status == "True")
' "$WORK/execution.json" >/dev/null || fail
jq -n --arg execution "$EXECUTION" --arg image "$IMAGE" --arg revision "$SHA" '{event:"canary_execution_succeeded",execution:$execution,image:$image,revision:$revision,success:true}' > "$EVIDENCE/success.json"
cat "$EVIDENCE/success.json"
