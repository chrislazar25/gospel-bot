# Cloud foundation work

## Done predicate

CI executes the existing real Docker/Postgres delivery checks. The same delivery core supports an IST clock, approved dated content, Green API submission and receipt reconciliation, a bounded job, and an authenticated HTTP service. Infrastructure and release workflows validate locally and define separate staging and production resources with sending held by default. Live provisioning is verified only when account access and actual cloud outputs are available.

## Checklist

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Add CI and verify against the existing lab.
- [x] Ground, sketch two architectures, cross-judge, and synthesize.
- [x] Implement production runtime and Green API adapter with real Postgres verification.
- [x] Implement content validation and deployable image.
- [x] Implement infrastructure, bootstrap, release, and monitoring workflows.
- [x] Verify workflow syntax, Terraform, image, behavior, and cloud access prerequisites. Cloud execution remains unverified.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back.

## Scope and gates

Four delivery units: CI, shared runtime, content release, and cloud infrastructure/workflows. Delivery changes receive real Postgres and failure-boundary checks. Infrastructure receives format, provider validation, and workflow linting. No production messages are used as tests. Production activation requires reconciliation and shutdown of the old sender. Cloud provisioning requires the intended project and account access, which were not available at framing.

## Throughput checkpoint

Start with CI on the existing verified lab. Compare two architecture sketches while CI is checked. Choose one shared contract before delegating infrastructure work. Give runtime and infrastructure separate owned paths. Verify each unit before committing it. Stop dependent cloud writes when identifiers or credentials are unavailable, while completing all local code and workflows.

## Monitoring scope

Use a Gospel dashboard inside Google Cloud Monitoring, structured logs, alert policies, and an optional external heartbeat. A bespoke status website is excluded. Business delivery facts still need application instrumentation.

## Checkpoints

CI PR #5 passed on GitHub's Linux runner. The extracted shared core passed all 34 existing Docker/Postgres checks. Production-schema and Green-shaped HTTP verification passed 17 tests, including runtime-role restrictions. The content validator rejects BOM-prefixed files before decoding can strip bytes. The service listens during bootstrap but returns HTTP 503 until its schema is migrated.

No matching deslop or comment-sicko plugin was installed. Independent reviewers inspected the diff, comments, and suppressions manually. No scoped comments or TypeScript suppressions required removal. Configured pstack models are all GPT-6.1 Sol. Independent reviews therefore use the same model family; the requested cross-family trail review is unavailable and is not claimed.

Cloud provisioning remains blocked by missing project selection and account authorization. The user has no Neon account or separate Green API test instance yet. The next operator step is identifying the existing GCP project's ID. The project, Neon account, provider isolation, fourteen approved content dates, and notification routing must be established before cloud or live-provider verification can be reported.

The actual production image passed local TLS verification through the committed image harness. It rejects an untrusted database certificate, migrates twice, changes health from503 to200 after migration, listens on port9127, refuses HTTP mutation, and holds sends without provider configuration. All owned Docker resources and test private keys were removed.

Infrastructure checkpoint: Terraform provider validation passed for bootstrap and environment modules, actionlint passed all workflows, every Bash file passed syntax checks and ShellCheck, and seven fake-command build/release scenarios passed. These scenarios test control flow only. No GCP or Neon API provisioning ran. Secret references are numeric versions; schedules, sending, and alert policies start disabled. Alerts require a recurring check sample and verified notification routing before activation.

Same-model audit review found an unfinished checklist and an evidence path tied to the implementation worktree. This update completes the local checklist and stores a sanitized image report at `.audit/evidence/runtime-image.json`. The remaining attention items are cloud account setup, approved content, and actual provider verification. Deslop plugin and cross-family review remain unavailable.
