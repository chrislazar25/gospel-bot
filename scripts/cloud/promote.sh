#!/usr/bin/env bash
set -euo pipefail
: "${STAGING_RUN:?}"
: "${GH_REPO:?}"
: "${GITHUB_SHA:?}"
: "${GCP_PROJECT_ID:?}"
REGION="${REGION:-us-central1}"
[[ "$STAGING_RUN" =~ ^[0-9]+$ ]] || exit 1
PROMOTION_DIR=$(mktemp -d)
trap 'rm -rf "$PROMOTION_DIR"' EXIT
gh api "repos/$GH_REPO/actions/runs/$STAGING_RUN" > "$PROMOTION_DIR/run.json"
jq -e --arg sha "$GITHUB_SHA" '.conclusion == "success" and .event == "workflow_dispatch" and .head_branch == "master" and .head_sha == $sha and .path == ".github/workflows/release.yml"' "$PROMOTION_DIR/run.json"
gh run download "$STAGING_RUN" --repo "$GH_REPO" --name tested-staging-image --dir "$PROMOTION_DIR/artifact"
[[ $(cat "$PROMOTION_DIR/artifact/environment.txt") == staging ]] || exit 1
IMAGE=$(cat "$PROMOTION_DIR/artifact/image.txt")
[[ "$IMAGE" =~ ^$REGION-docker\.pkg\.dev/$GCP_PROJECT_ID/gospel/runtime@sha256:[a-f0-9]{64}$ ]] || exit 1
printf '%s\n' "$IMAGE" > image.txt
