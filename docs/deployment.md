# Set up staging and production

This guide creates two Neon projects and disabled Cloud Run deployments in one billed GCP project. It does not activate delivery. No cloud resources have been provisioned by the local validation.

## Prepare the accounts

1. Create or select a GCP project with billing enabled. Record its project ID.
2. Create a Neon account and organization in the [Neon console](https://console.neon.tech). Create an organization API key. The script cannot create your account or accept billing terms.
3. Install Terraform 1.14, the Google Cloud CLI, and GitHub CLI on your computer. Authenticate Google Cloud CLI and Application Default Credentials as an administrator. The bootstrap script uses existing credentials and never opens a login.
4. Protect the GitHub `master` branch. Require pull requests, CI, and review. Disable force pushes. WIF rejects unprotected refs and all branches other than `master`.
5. Create GitHub environments named `staging` and `production`. Restrict both to `master`. Require an independent production reviewer and prevent self-review. Add a staging reviewer if desired.
6. Record the numeric GitHub repository ID and owner ID using `gh api repos/chrislazar25/gospel-bot --jq '{repository_id: .id, owner_id: .owner.id}'`.

## Bootstrap GCP once

Run from the repository root after reviewing `infra/bootstrap/main.tf`.

```sh
export GCP_PROJECT_ID=your-project
export GITHUB_REPOSITORY_ID=123456
export GITHUB_OWNER_ID=123456
scripts/cloud/bootstrap.sh
terraform -chdir=infra/bootstrap output
```

The script plans and applies the account foundation. It creates APIs, a versioned state bucket, an immutable Artifact Registry repository, and six workflow service accounts. Keep `infra/bootstrap/terraform.tfstate` in a secure administrator backup. It contains infrastructure metadata, not application secret values. Bootstrap state remains local because the bucket does not exist before this step. Do not commit state or credential files.

Workload Identity Federation requires the exact repository name, numeric repository and owner IDs, protected `master`, matching GitHub environment, and the expected workflow filename. No service account keys are created.

Infrastructure accounts need project-wide IAM and resource administration to create the application resources. Treat Infrastructure approvals as administrator approvals. Release and Neon accounts receive resource-level access. Infrastructure state uses separate `staging` and `production` prefixes with object access constrained to each prefix. Bucket listing can reveal state object names.

## Set GitHub environment values

Add these variables to each GitHub environment. Use the same GCP project, WIF provider, bucket, and registry region for both environments. Set the chat and provider values to the intended instance. This setup does not assume a second GREEN-API instance exists.

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | Your billed project ID |
| `GCP_REGION` | `us-central1` unless you changed bootstrap |
| `WIF_PROVIDER` | Bootstrap `workload_identity_provider` output |
| `TF_STATE_BUCKET` | Bootstrap `state_bucket` output |
| `NEON_ORG_ID` | Neon organization ID |
| `NEON_REGION` | `aws-us-east-2` or a supported nearby Neon region |
| `GREEN_API_URL` | Instance-assigned `https://HOST.api.green-api.com` URL |
| `GREEN_API_ID` | Instance ID |
| `TARGET_CHAT_ID` | Approved WhatsApp chat ID |
| `NOTIFICATION_EMAIL` | Address that receives operational alerts |
| `STATUS_INVOKERS_JSON` | JSON array such as `["user:you@example.com"]` |
| `SECRET_VERSIONS_JSON` | Numeric secret versions as JSON, initially `{"database":"1","migration-database":"1","status-database":"1","green-token":"1"}` |
| `MONITORING_ENABLED` | Leave unset or `false` until the separate activation task validates recurring checks and notification delivery |
| `INITIAL_IMAGE` | Immutable image reference from the next step |

Add `NEON_API_KEY` as an environment secret. Do not add database passwords, connection URLs, or the GREEN-API token as Terraform variables.

## Build the initial image and create secrets

Approved content must contain at least 14 consecutive dates starting today in `Asia/Kolkata`. The repository intentionally starts without approved production content. The container's `content-check` command blocks image publication until that content exists. Review and merge the content before proceeding. Docker builds use repository-root context and `local-lab/Dockerfile.runtime`.

Run **Release** on `master` with environment `staging` and `build_only` checked. This publishes the image through WIF without requiring existing Cloud Run resources. It uploads `candidate-image` containing `image.txt`. Download that artifact and set `INITIAL_IMAGE` in both environments to the digest reference in `image.txt`.

Candidate builds cannot run for production. Their artifacts are not promotion evidence. After the resources exist, a normal staging release must pass migrations, authenticated health, and the read-only check before production can consume its `tested-staging-image`.
Cloud workflows share one concurrency group per environment so infrastructure, Neon provisioning, and release cannot overlap. For each environment, run the following GitHub Actions in order on `master`.

1. Run **Infrastructure** with operation `secrets`. This creates empty secret containers and Neon account permissions. It deliberately targets only these prerequisites.
2. Run **Neon databases**. The script finds or creates `gospel-staging` or `gospel-production` in the specified organization. It saves the owner URL, creates separate application and status SQL roles, and writes their URLs directly to Secret Manager. It does not print the URLs or run schema migrations. Reruns preserve application passwords and reconcile grants. If project creation succeeds but a later step fails, the next run finds the project by name. Duplicate names fail for manual review. Do not rename these projects outside this workflow.
3. Enter the GREEN-API token into the environment's `gospel-ENV-green-token` secret using the GCP Secret Manager console. Avoid shell history and logs. Routine provisioning preserves role passwords and existing version values. Coordinate any deliberate rotation with a reviewed numeric-version update before reenabling schedules. Keep earlier versions enabled for rollback. Image rollback alone does not change pinned secret versions. The four IDs are `gospel-ENV-database`, `gospel-ENV-migration-database`, `gospel-ENV-status-database`, and `gospel-ENV-green-token`.
4. Check each secret's numeric version in Secret Manager and update `SECRET_VERSIONS_JSON` to those versions. Cloud Run pins these values and never resolves `latest`. Run **Infrastructure** with operation `plan`. Review the plan. Run it again with operation `apply` after review. The apply run prints a fresh plan before applying that exact saved plan. GitHub environment approval gates the job before it obtains cloud credentials.
5. Verify the Cloud Scheduler jobs remain paused and every Cloud Run task has `SENDING_ENABLED=false`.

A full apply before secret versions exist fails. The initial status revision starts before the first migration and reports unready with HTTP 503 until the release applies the schema. Keep the documented order. The status service requires authentication and has no `allUsers` binding. Only the configured invokers and release identity can call it. Status and check can read only the status database secret. They have no GREEN-API token.

## Release staging and promote the same image

Run **Release** on `master` with environment `staging` and `build_only` unchecked. It builds a Linux AMD64 image once, validates content, and pushes an immutable commit tag. It deploys by digest. It migrates with the separate owner secret before updating other jobs or the status service. It checks authenticated `/health` and runs the read-only check job. The image embeds its source commit through the `RELEASE_SHA` build argument. The successful run uploads `tested-staging-image` with its digest and environment evidence.

For production, run **Release** on the same commit with environment `production` and the successful staging Release run ID. Leave `build_only` unchecked. The workflow verifies the run's repository, workflow path, event, branch, successful conclusion, and exact commit. It downloads the staging artifact and rechecks current content coverage before deploying its digest. It never accepts an arbitrary image input. Expired artifacts or an intervening commit require a new staging release.

Both releases reject active schedules and deploy with sending disabled. They do not set `FIRST_SEND_DATE`, execute `send`, or perform a live canary. A failed migration stops deployment. A later failure can leave components on different image digests while schedules stay paused. Inspect job executions and retry the release after correcting the cause. Database changes must remain compatible with the previous image. Rolling back an image does not reverse migrations.

## Inspect status and monitoring

In GCP Monitoring, open the `gospel-ENV delivery` dashboard. Its log panel shows the latest structured `delivery_check`, including date, delivery status, and `contentDaysRemaining`. Expand the latest payload and check its timestamp. The charts show daily check, problem, and content-warning log counts. Both alert policies are disabled by default while schedules are paused. Once explicitly enabled, delivery problems and content warnings send email alerts. The missing-evidence policy alerts after 30 minutes without a `delivery_check` event from the check job. Monitoring absence policies need an initial observed time series. Verify the first successful check and the notification channel before relying on absence detection. Email verification may require a confirmation in GCP Monitoring. Keep `MONITORING_ENABLED=false` throughout initial setup. During the separate activation task, first update the reviewed scheduler configuration so recurring checks remain enabled across Terraform applies. Confirm the first sample, recurring executions, and notification delivery, then enable monitoring in a reviewed apply. The dashboard remains available when alerts are disabled.

Read the authenticated status endpoint using an authorized account. The release itself checks `/health`; an IAM failure returns an HTTP error. There is no custom status UI. Use Cloud Run logs, execution history, the private JSON endpoint, and GCP Monitoring.

The configured send window is 07:00 to 08:00 IST, with a 07:30 IST delivery deadline. Check and reconciliation run every ten minutes. All three schedules remain paused. Alerts can identify a stopped check only after it has emitted evidence at least once. Content coverage appears in structured `delivery_check.contentDaysRemaining` logs, and overdue or failed delivery appears as `delivery_problem` with `ERROR` severity.

## Keep delivery disabled until activation is reviewed

Activation is a separate task. It requires approved live content, an authorized chat, a verified provider instance, the first send date, a reviewed delivery window, and an explicit live canary decision. This repository provides no activation workflow. Keep both environments disabled while there is only one provider instance and chat unless their live use has been explicitly authorized.

## Validate changes locally

```sh
terraform fmt -check -recursive infra
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/environment init -backend=false
terraform -chdir=infra/environment validate
actionlint .github/workflows/infrastructure.yml .github/workflows/neon.yml .github/workflows/release.yml
bash -n scripts/cloud/bootstrap.sh scripts/cloud/build.sh scripts/cloud/release.sh
node --check scripts/cloud/neon.mjs
```

These checks validate syntax and provider schemas without provisioning. They do not prove IAM, Neon API permissions, database connectivity, alert delivery, or cloud executions. Confirm those during the disabled staging setup.

The implementation follows the official [Cloud Run job scheduling guide](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule), [Neon project API](https://neon.com/docs/reference/api/projects/create-project), and [Monitoring alert policy schema](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/monitoring_alert_policy).
