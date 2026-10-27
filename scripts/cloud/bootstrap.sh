#!/usr/bin/env bash
set -euo pipefail
: "${GCP_PROJECT_ID:?Set the billed GCP project ID}"
: "${GITHUB_REPOSITORY_ID:?Set GitHub numeric repository ID}"
: "${GITHUB_OWNER_ID:?Set GitHub numeric owner ID}"
command -v gcloud >/dev/null
command -v terraform >/dev/null
# Uses the operator's existing ADC. It never starts a login or creates credentials.
export TF_VAR_project_id="$GCP_PROJECT_ID"
export TF_VAR_github_repository_id="$GITHUB_REPOSITORY_ID"
export TF_VAR_github_owner_id="$GITHUB_OWNER_ID"
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap plan -out=bootstrap.plan
terraform -chdir=infra/bootstrap apply bootstrap.plan
rm infra/bootstrap/bootstrap.plan
