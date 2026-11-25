# One private staging canary

The canary sends a fixed marked test message to the private chat stored in the
GitHub staging environment's `CANARY_TARGET_CHAT_ID`. It requires no approved
Bible content. Daily Gospel delivery remains disabled. This unit creates two
Cloud Run jobs and two service accounts. It creates no application services,
schedulers, notification channels, or new database tables.

The payload is exactly:

> Gospel Bot staging test. This is a single test message. Daily Gospel delivery remains disabled.

`runCanary` reuses migration 001 and the `green-api` delivery channel. Each
attempt records under a reserved 1970 ledger date: attempt 1 is `1970-01-01`,
attempt 2 is `1970-01-02`, and so on up to 365. The staging `CANARY_ATTEMPT`
variable sets the attempt. One attempt allows at most one provider submission
for an unchanged recipient. It does not guarantee exactly once delivery. A crash
after the database claim may consume the attempt without sending anything. A
lost HTTP response may leave delivery unknown permanently. Unknown and failed
deliveries must be investigated, never reset or retried. To send again after an
investigation, raise `CANARY_ATTEMPT` by one and repeat plan, apply and execute.
Earlier attempts keep their rows. Changing the recipient also permits another
message and requires a separate human review.

An accepted response is not proof of delivery. The job checks at most twelve
receipts, with five seconds between checks. Only a correlated `delivered` or
`read` receipt produces confirmation. Keep the Green API instance setting
`outgoingWebhook` at `yes`. With it off, the first staging attempt stayed `sent`
after the recipient received it. Accepted reruns only reconcile the existing
provider ID. Confirmed reruns report `priorConfirmation: true` without sending.
Mismatched stored payload bytes or hashes fail before any provider submission.
Concurrent insert races are also checked at the provider boundary.

The job starts the existing status HTTP server on loopback using the separate
`gospel_status` credential. It checks `/health` and `/get-status/{deliveryId}`.
This verifies HTTP inside the job. It does not test an externally deployed
private Cloud Run status service. The canary account cannot access the migration
owner credential. Only the infrastructure workflow can act as and execute the
separate migration job. Release receives update and invoke permissions on the
canary job alone.

## Reviewed rollout

Do not execute cloud commands from the feature branch. A human reviews and merges
the PR first. The existing protected `infrastructure.yml` and `release.yml`
master-only WIF subjects remain the authentication boundary. The canary script
also requires a master `workflow_dispatch` in the exact Release workflow's
`canary` job. Local publication and execution are rejected.

The GitHub staging environment needs the existing GCP project, region, state
bucket and WIF settings, the assigned `GREEN_API_URL`, numeric `GREEN_API_ID`,
`CANARY_ATTEMPT`, and `SECRET_VERSIONS_JSON` as variables, and `CANARY_TARGET_CHAT_ID` as an
environment secret so that logs mask it. Pin numeric versions
for the four existing `gospel-staging-{database,status-database,migration-database,green-token}`
secrets. No credential value belongs in GitHub variables or this document.
Runtime and status URLs must select the same host/database, the `gospel_runtime`
and `gospel_status` users respectively, and include passwords. Both connections
use the existing TLS helper with certificate verification enabled. Only strict
HTTPS origins under `api.greenapi.com` or `api.green-api.com` are accepted.
Credentials, explicit ports, paths, queries and fragments in provider origins
are rejected.

1. On merged master, dispatch Release with `environment=staging` and
   `canary=publish`. Leave `build_only` and `smoke_only` false and
   `staging_run_id` empty. This builds the normal runtime Dockerfile into the
   separate `/gospel/canary` repository image with a canary purpose label and
   source revision. It does not execute the message or apply infrastructure.
   An existing source-SHA image is reused only after its labels are checked.
   Build and push explicitly target `linux/amd64`. The normal release's content
   coverage check still applies to normal runtime releases.
2. Review the `canary-evidence` artifact. Set staging `CANARY_IMAGE` to its
   `canary-image.txt` digest and `CANARY_REVISION` to its
   `canary-revision.txt` source SHA. These are canary artifacts, not the normal
   `image.txt` or `tested-staging-image` promotion proof.
3. Dispatch Infrastructure with `environment=staging` and
   `operation=canary-plan`. Review the isolated plan. Its state prefix is
   `staging/canary`, separate from application and cloud-smoke state.
4. Dispatch Infrastructure with `operation=canary-apply`. After applying the
   resources, the infrastructure identity executes
   `gospel-staging-canary-migrate` and waits for migration 001 to complete.
   The migration job receives only the pinned migration database secret.
   This apply also sets the canary's expected revision. Repeat plan and apply
   after every new image/revision before attempting execution.
5. On the same reviewed master revision, dispatch Release with
   `environment=staging` and `canary=execute`. It checks the pinned digest,
   purpose and source revision, updates only `gospel-staging-canary`, executes
   it with no automatic retries, and polls for at most five minutes. It fails
   unless the job completes successfully. Runtime exit zero requires a
   confirmed receipt and successful loopback HTTP assertions. This can report
   an existing confirmation; it does not imply a fresh send.

Publication and execution are deliberately separate dispatches. A different
master revision requires a newly published and reviewed image and infrastructure
apply. Canary options conflict with all normal release or smoke options and with
production before authentication. The canary image is never normal runtime
promotion evidence.

## Evidence and recovery

The Release artifact contains only allowlisted execution metadata, including
execution ID, image digest, revision, completion conditions and success/failure
counts. It excludes raw execution configuration, recipient, credentials and CLI
error text. A successful artifact proves job completion under the guarded
runtime contract. It is not a downloaded provider receipt or runtime event.

An operator with existing authorized Cloud Logging read access can inspect the
specific execution's structured `canary_verified`, `canary_requires_attention`,
or `canary_failed` event in Cloud Run logs. Filter by the execution ID from the
artifact and preserve only the event, revision, delivery ID, status, attempts,
payload hash, `priorConfirmation` and `statusHttp` fields. No new broad logging
permission is granted to Release. The event contains no full recipient, provider
token, database URL or raw provider error. If status is unknown, failed or still
accepted, preserve the evidence for investigation. Do not clear its ledger row or
change the permanent identity to force another attempt.

## Local verification

These checks use fake commands or an isolated Postgres container and fake Green
HTTP server. They require no cloud credentials and send no real messages.

```sh
npm --prefix local-lab run check
node local-lab/verify-runtime.mjs
node scripts/cloud/canary.test.mjs
terraform -chdir=infra/canary init -backend=false
terraform -chdir=infra/canary validate
terraform -chdir=infra/canary test
terraform fmt -check -recursive infra
actionlint .github/workflows/infrastructure.yml .github/workflows/release.yml
```

The runtime Docker test command runs existing runtime and Neon role checks,
then canary boundary and integration tests, then existing-project Neon SQL
preflight checks. Canary tests use a separate temporary database and clean up
their role before later tests. They cover concurrent claims, next-day reruns,
unknown claims before HTTP, lost responses, acceptance bookkeeping crashes,
frozen payload mismatch, competing inserts, prior confirmation, receipt identity,
read-only status access, and rejected group/production configuration. Terraform
mock tests check both provider domains, adversarial origins, pinned images and
secrets, separate migration access, and staging/private-only boundaries.
