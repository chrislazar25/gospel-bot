#!/usr/bin/env bash
set -euo pipefail
: "${GCP_PROJECT_ID:?}"
: "${APP_ENV:?}"
[[ "$APP_ENV" == staging || "$APP_ENV" == production ]] || exit 1
REGION="${REGION:-us-central1}"
IMAGE=$(cat image.txt)
[[ "$IMAGE" =~ ^$REGION-docker\.pkg\.dev/$GCP_PROJECT_ID/gospel/runtime@sha256:[a-f0-9]{64}$ ]] || exit 1
PREFIX="gospel-$APP_ENV"
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
docker pull "$IMAGE"
docker run --rm -e APP_ENV "$IMAGE" node dist/runtime.js content-check
for task in send reconcile check; do
  gcloud scheduler jobs describe "$PREFIX-$task" --location="$REGION" --project="$GCP_PROJECT_ID" --format='value(state)' | grep -qx PAUSED
done
gcloud run jobs update "$PREFIX-migrate" --image="$IMAGE" --region="$REGION" --project="$GCP_PROJECT_ID" --update-env-vars=SENDING_ENABLED=false --quiet
gcloud run jobs execute "$PREFIX-migrate" --wait --region="$REGION" --project="$GCP_PROJECT_ID" --quiet
for task in send reconcile check; do
  gcloud run jobs update "$PREFIX-$task" --image="$IMAGE" --region="$REGION" --project="$GCP_PROJECT_ID" --update-env-vars=SENDING_ENABLED=false --quiet
done
gcloud run services update "$PREFIX-status" --image="$IMAGE" --region="$REGION" --project="$GCP_PROJECT_ID" --update-env-vars=SENDING_ENABLED=false --quiet
URL=$(gcloud run services describe "$PREFIX-status" --region="$REGION" --project="$GCP_PROJECT_ID" --format='value(status.url)')
[[ "$URL" =~ ^https://[a-zA-Z0-9.-]+$ ]] || exit 1
printf 'status_url=%s\n' "$URL" >> "${GITHUB_OUTPUT:?}"
