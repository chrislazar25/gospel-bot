# Run an isolated staging smoke job

Run these commands from the repository root. The smoke image extends the normal runtime image with disposable PostgreSQL, a strict fake GREEN-API server, and verification fixtures. It runs the runtime CLI inside one container. Each execution creates its own database and uses loopback connections. No real WhatsApp credentials or application database secrets enter the image or job.

## Verify locally

Install Docker and run the smoke command.

```sh
scripts/cloud/cloud-smoke.sh local
```

The command builds Linux AMD64 images and runs the smoke image with `--network none`. It saves output in `cloud-smoke-evidence/local.jsonl`. CI runs the same command without a cloud identity and uploads `cloud-smoke-local-evidence`.

## Create the initial smoke job

Complete the GCP foundation in [Set up staging and production](deployment.md#bootstrap-gcp-once). Use an existing administrator session for the initial branch deployment after reviewing the Terraform plan. This setup does not require Neon projects, application secrets, approved live content, or an application deployment.

1. Commit the source changes. Publishing rejects a dirty checkout or a mismatched `GITHUB_SHA`.
2. Set the billed project and registry region, then publish the verified smoke image.

```sh
export APP_ENV=staging
export GCP_PROJECT_ID=your-project
export REGION=us-central1
scripts/cloud/cloud-smoke.sh publish
```

An existing immutable commit tag is reused after the command pulls and verifies that published image in another isolated local run.

3. Initialize separate smoke state, review the plan, and apply that saved plan.

```sh
export TF_VAR_project_id="$GCP_PROJECT_ID"
export TF_VAR_region="$REGION"
export TF_VAR_image="$(cat smoke-image.txt)"
export STATE_BUCKET=your-project-gospel-tfstate
terraform -chdir=infra/smoke init -backend-config="bucket=$STATE_BUCKET" -backend-config="prefix=staging/cloud-smoke"
terraform -chdir=infra/smoke plan -out=deployment.plan
terraform -chdir=infra/smoke apply deployment.plan
```

The module creates `gospel-staging-cloud-smoke`, its service account, and resource-level release permissions. The runtime service account receives no IAM roles. The job runs one task with two CPUs, 2 GiB of memory, no retries, and a 300-second timeout. Terraform preserves release-owned image updates. It creates no Scheduler jobs, Neon databases, application secrets, status services, or monitoring resources.

4. Execute the precreated job using the pinned image file.

```sh
scripts/cloud/cloud-smoke.sh execute
```

The command updates only `gospel-staging-cloud-smoke`. It rejects production and digests outside the configured project's `gospel/cloud-smoke` repository before cloud mutation. It waits for completion and saves execution metadata in `cloud-smoke-evidence/execution.json`. A successful result requires one successful task, a completed condition, no failed or cancelled tasks, the fixed job name, and the exact image digest. `success.json` records that execution and the checked-out revision. Publishing records the build revision separately in `release-sha.txt`.

## Run from GitHub Actions after merge

Keep WIF restricted to protected `master` and the existing workflow filenames. After review and merge, set `SMOKE_IMAGE` in the GitHub `staging` environment to the initial digest. The smoke infrastructure path needs only `GCP_PROJECT_ID`, `GCP_REGION`, `WIF_PROVIDER`, `TF_STATE_BUCKET`, and `SMOKE_IMAGE`.

Run **Infrastructure** on `master` with environment `staging` and operation `smoke-plan` to review changes. Use `smoke-apply` to apply a fresh saved plan. These operations use state prefix `staging/cloud-smoke` and the existing staging infrastructure identity.

Run **Release** on `master` with environment `staging`, `smoke_only` checked, and `build_only` unchecked. The separate smoke job uses the existing staging release identity. It publishes the locally verified derivative, updates the precreated smoke job by digest, and uploads `cloud-smoke-evidence`. The smoke artifact cannot promote an application release. Normal release and content checks remain in place.

The release identity has no Logs Viewer role. An administrator can collect logs for the execution named in `success.json`. Confirm that the harness output contains the same `CLOUD_RUN_EXECUTION` and the published `RELEASE_SHA`. Save those logs with the execution metadata when recording cloud proof.

This smoke run verifies the container and runtime workflow on Cloud Run with disposable dependencies. It does not verify Neon connectivity, live WhatsApp delivery, or database persistence between executions.
