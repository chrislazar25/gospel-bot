#!/usr/bin/env bash
set -euo pipefail
: "${GCP_PROJECT_ID:?}"
: "${APP_ENV:?}"
: "${STATUS_URL:?}"
: "${ID_TOKEN:?}"
[[ "$APP_ENV" == staging || "$APP_ENV" == production ]] || exit 1
[[ "$STATUS_URL" =~ ^https://[a-zA-Z0-9.-]+$ ]] || exit 1
REGION="${REGION:-us-central1}"
UNAUTHENTICATED=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$STATUS_URL/health")
[[ "$UNAUTHENTICATED" == 401 || "$UNAUTHENTICATED" == 403 ]] || exit 1
curl --fail --silent --show-error --retry 3 --retry-all-errors -H "Authorization: Bearer $ID_TOKEN" "$STATUS_URL/health"
gcloud run jobs execute "gospel-$APP_ENV-check" --wait --region="$REGION" --project="$GCP_PROJECT_ID" --quiet
