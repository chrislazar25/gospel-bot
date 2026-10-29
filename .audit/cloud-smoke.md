# Cloud smoke verification

## Definition of done

A separate branch contains atomic changes and one open PR. An isolated Cloud Run execution submits synthetic message text through the shared delivery code to a simulated provider, proves a single submission despite repeat/concurrent calls, and records a correlated delivered receipt. Its logs identify the tested source and image. Production, real WhatsApp credentials, and real groups remain untouched. Missing Neon/provider access is reported separately from this cloud proof.

## Checklist

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame.
- [ ] Phase B: Design the workflow.
- [ ] Phase C: Run the loop.
- [ ] Verify accessible accounts and existing cloud resources.
- [ ] Compare two isolated cloud verification designs and select one.
- [ ] Implement and locally verify the repeatable synthetic-send harness.
- [ ] Provision and execute isolated staging smoke resources.
- [ ] Add the reviewed GitHub Actions path and verify its boundaries.
- [ ] Commit atomic units and open one PR.
- [ ] Inspect one Greptile review and fix supported findings.
- [ ] Phase D: Keep the audit trail.
- [ ] Phase E: Verify and hand back.

## Throughput checkpoint

Resolve cloud access and deployment blockers before editing. Ground the existing release path while checking GCP and GitHub account metadata. Compare two verification shapes before implementation. Reuse the shared delivery code and run the harness locally before paying for cloud execution. Keep test resources separate from staging/production app resources. Verify and commit each unit before the next. Open the PR only when the initial implementation and cloud evidence are ready, so Greptile reviews a complete change.

## Scope

One isolated cloud smoke test, its infrastructure/workflow path, and a short operator guide. This is not production activation or proof of Neon/real WhatsApp delivery. Normal releases still require fourteen approved content dates and configured Neon/provider secrets. Existing GCP authentication is available; no Neon API key or Green API secret is configured in the GitHub environments.

## Design phases

- [x] Ground.
- [ ] Sketch two candidates.
- [ ] Agree. Default to the reviewed isolated design without a user checkpoint.
- [ ] Implement.
- [ ] Scrap if verified assumptions fail.

## Arena phases

- [x] Frame. Grade safety, fidelity to production code, reproducibility, and simplicity.
- [ ] Fan out.
- [ ] Cross-judge.
- [ ] Pick.
- [ ] Graft.
- [ ] Verify.

## Design decision

The selected shape is one test-only derivative of the unchanged runtime image. It owns disposable loopback TLS Postgres and a strict local HTTP provider fixture. A preload redirects only the fixed synthetic Green API origin and freezes one captured clock across CLI subprocesses. The real runtime, content validator, Green adapter, schema, role reconciler, and delivery logic are reused.

Two independent design candidates compared this against a Postgres sidecar. The judge selected the single-container design because it avoids shared readiness markers, certificate timing, and multiple image lifecycles. The sidecar candidate contributed the explicit intermediate `sent` receipt test. Both preserve protected-master WIF. The initial authorized branch execution uses administrator credentials; the reviewed future path uses existing Infrastructure and Release workflow identities.

Safety and fidelity both scored 5/5 for the selected design. The simpler lifecycle scored 4/5 against 2/5 for the sidecar. These are design judgments, not runtime measurements. Full candidate notes are local `/tmp/gospel-smoke-design-a.md` and `/tmp/gospel-smoke-design-b.md`; the rationale above is the durable summary.

## Coverage ownership

The parent owns the smoke image, transport, CLI scenario, and actual cloud evidence. A separate worktree owns the Terraform root, wrapper, workflow wiring, and command-boundary tests. Source writes are separated and their outputs are integrated only after verification.
