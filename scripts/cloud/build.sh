#!/usr/bin/env bash
set -euo pipefail
: "${GCP_PROJECT_ID:?}"
: "${APP_ENV:?Set staging or production}"
[[ "$APP_ENV" == staging || "$APP_ENV" == production ]] || exit 1
: "${GITHUB_SHA:=$(git rev-parse HEAD)}"
REGION="${REGION:-us-central1}"
IMAGE="$REGION-docker.pkg.dev/$GCP_PROJECT_ID/gospel/runtime"
ERROR_FILE=$(mktemp)
trap 'rm -f "$ERROR_FILE"' EXIT
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
if DIGEST=$(gcloud artifacts docker images describe "$IMAGE:$GITHUB_SHA" --format='value(image_summary.digest)' 2>"$ERROR_FILE"); then
  docker pull "$IMAGE@$DIGEST"
  docker run --rm -e APP_ENV "$IMAGE@$DIGEST" node dist/runtime.js content-check
else
  grep -Eq 'NOT_FOUND|Image not found\.' "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
  docker build --platform linux/amd64 --build-arg "RELEASE_SHA=$GITHUB_SHA" -f local-lab/Dockerfile.runtime -t "$IMAGE:$GITHUB_SHA" .
  docker run --rm -e APP_ENV "$IMAGE:$GITHUB_SHA" node dist/runtime.js content-check
  docker push "$IMAGE:$GITHUB_SHA"
  DIGEST=$(gcloud artifacts docker images describe "$IMAGE:$GITHUB_SHA" --format='value(image_summary.digest)')
fi
[[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
printf '%s@%s\n' "$IMAGE" "$DIGEST" > image.txt
