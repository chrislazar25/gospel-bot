# Cloud smoke verification

## Definition of done

A separate branch contains atomic changes and one open PR. An isolated Cloud Run execution submits synthetic message text through the shared delivery code to a simulated provider, proves a single submission despite repeat/concurrent calls, and records a correlated delivered receipt. Its logs identify the tested source and image. Production, real WhatsApp credentials, and real groups remain untouched. Missing Neon/provider access is reported separately from this cloud proof.

## Checklist

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Verify accessible accounts and existing cloud resources.
- [x] Compare two isolated cloud verification designs and select one.
- [x] Implement and locally verify the repeatable synthetic-send harness.
- [x] Provision and execute isolated staging smoke resources.
- [x] Add the reviewed GitHub Actions path and verify its boundaries.
- [ ] Commit atomic units and open one PR.
- [ ] Inspect one Greptile review and fix supported findings.
- [x] Phase D: Keep the audit trail.
- [ ] Phase E: Verify and hand back.

## Throughput checkpoint

Resolve cloud access and deployment blockers before editing. Ground the existing release path while checking GCP and GitHub account metadata. Compare two verification shapes before implementation. Reuse the shared delivery code and run the harness locally before paying for cloud execution. Keep test resources separate from staging/production app resources. Verify and commit each unit before the next. Open the PR only when the initial implementation and cloud evidence are ready, so Greptile reviews a complete change.

## Scope

One isolated cloud smoke test, its infrastructure/workflow path, and a short operator guide. This is not production activation or proof of Neon/real WhatsApp delivery. Normal releases still require fourteen approved content dates and configured Neon/provider secrets. Existing GCP authentication is available; no Neon API key or Green API secret is configured in the GitHub environments.

## Design phases

- [x] Ground.
- [x] Sketch two candidates.
- [x] Agree. Default to the reviewed isolated design without a user checkpoint.
- [x] Implement.
- [x] Scrap if verified assumptions fail. Not needed. Fixture and command fixes fit the selected design.

## Arena phases

- [x] Frame. Grade safety, fidelity to production code, reproducibility, and simplicity.
- [x] Fan out.
- [x] Cross-judge.
- [x] Pick.
- [x] Graft.
- [x] Verify.

## Design decision

The selected shape is one test-only derivative of the unchanged runtime image. It owns disposable loopback TLS Postgres and a strict local HTTP provider fixture. A preload redirects only the fixed synthetic Green API origin and freezes one captured clock across CLI subprocesses. The real runtime, content validator, Green adapter, schema, role reconciler, and delivery logic are reused.

Two independent design candidates compared this against a Postgres sidecar. The judge selected the single-container design because it avoids shared readiness markers, certificate timing, and multiple image lifecycles. The sidecar candidate contributed the explicit intermediate `sent` receipt test. Both preserve protected-master WIF. The initial authorized branch execution uses administrator credentials; the reviewed future path uses existing Infrastructure and Release workflow identities.

Safety and fidelity both scored 5/5 for the selected design. The simpler lifecycle scored 4/5 against 2/5 for the sidecar. These are design judgments, not runtime measurements. Full candidate notes are local `/tmp/gospel-smoke-design-a.md` and `/tmp/gospel-smoke-design-b.md`; the rationale above is the durable summary.

## Coverage ownership

The parent owns the smoke image, transport, CLI scenario, and actual cloud evidence. A separate worktree owns the Terraform root, wrapper, workflow wiring, and command-boundary tests. Source writes are separated and their outputs are integrated only after verification.

## Cloud result

The authorized administrator branch run applied five isolated smoke resources and executed `gospel-staging-cloud-smoke-j5g6q` successfully. The logs prove thirteen checks, exactly one synthetic submission and one attempt, a matching delivered receipt, confirmed SQL state, HTTP health/status reads, and cleanup. The source revision is `30cb745d03790b7c8495107aa57cbc195c174ba0`. The pinned image and execution record are in `.audit/evidence/cloud-smoke/cloud-result.json`. Execution metadata omits creator annotations.

[Open the actual Cloud Run execution](https://console.cloud.google.com/run/jobs/executions/details/us-central1/gospel-staging-cloud-smoke-j5g6q?project=864310543997).

The initial local prototype predates the harness commit and therefore reports the baseline revision. It is not the final source attestation. The committed cloud proof and execution bind the final tested code revision, digest, execution name, and received payload.

## Review and corrections

Independent same-model reviewers caught two receipt fixtures that could pass for the wrong reason, incomplete interruption cleanup, retained job-command overrides, and lost metadata on failed executions. The delivered wrong-group fixture now fails when the adapter's group check is removed. SIGTERM produces a failed result and removes temporary keys and database files. The wrapper forces and verifies the harness command, captures the execution identity before waiting, and retains terminal failure metadata.

Actual publication exposed two issues that command stubs had missed. The installed CLI reports missing images as `Image not found.`. Both publishers now accept that specific response as well as `NOT_FOUND`. Docker Desktop initially associated the immutable tag with an attestation manifest. A fresh single-platform push succeeded. Both publishers now push the Linux AMD64 manifest explicitly. The failed tag is preserved and is not a release candidate.

## Verification limits

The real cloud proof uses an ephemeral local PostgreSQL database and simulated Green transport. It does not prove Neon connectivity, real Green API authorization, WhatsApp delivery, persistence across cloud executions, private Cloud Run service IAM, alert routing, or GitHub WIF execution of the new workflow branches. WIF remains restricted to protected master. The first branch run used existing administrator authentication. Future smoke Actions become available after human review and merge.

The status routes ran inside the smoke job. There is no persistent application status service yet. No production resources, real provider secrets, real group identifiers, approved content, or schedules changed. Only the staging `SMOKE_IMAGE` GitHub variable was added.

The installed harness has no deslop or Comment Sicko plugin. Independent manual comment/prose checks found no comments or suppressions to remove. Configured reviewers all use GPT-6.1 Sol, so cross-family review is unavailable. No exported transcript path was provided for an independent transcript audit; the decision trail is checked against the command evidence and committed artifacts instead.
