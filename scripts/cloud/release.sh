#!/usr/bin/env bash
set -euo pipefail
: "${GCP_PROJECT_ID:?}"
: "${APP_ENV:?}"
[[ "$APP_ENV" == staging || "$APP_ENV" == production ]]
REGION="${REGION:-us-central1}"
IMAGE=$(cat image.txt)
[[ "$IMAGE" =~ ^$REGION-docker\.pkg\.dev/$GCP_PROJECT_ID/gospel/runtime@sha256:[a-f0-9]{64}$ ]]
PREFIX="gospel-$APP_ENV"
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
docker pull "$IMAGE"
docker run --rm -e APP_ENV "$IMAGE" node dist/runtime.js content-check
# Reassert the deployment gate even if an operator previously enabled a job.
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
TOKEN=$(gcloud auth print-identity-token --audiences="$URL")
printf '::add-mask::%s\n' "$TOKEN"
curl --fail --silent --show-error --retry 3 --retry-all-errors -H "Authorization: Bearer $TOKEN" "$URL/health"
gcloud run jobs execute "$PREFIX-check" --wait --region="$REGION" --project="$GCP_PROJECT_ID" --quiet
