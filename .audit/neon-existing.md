# Use the existing Neon project

## Target and done predicate

Select the user-supplied organization, project, branch, and database explicitly. A default inspection performs only Neon metadata GET requests, emits no credentials, and touches neither GCP nor SQL. An explicitly requested provisioning operation verifies that same target and existing secret ownership before writing restricted role credentials. It never creates a second project, assumes a default branch, overwrites another target's secrets, or runs schema migrations. Deliver atomic commits in a separate unmerged PR with local proof; actual Neon execution waits for the reviewed workflow on protected master.

## Feature checklist

- [x] 1. how over the affected subsystem.
- [x] 2. architect for parallel design exploration. Two candidates and an independent judge selected one operation module with a capability-limited metadata inspector.
- [x] 3. Write the throughput checkpoint as four todo items.
- [x] 4. Delegate code-writing to a subagent using your configured feature model. One owner wrote the coupled implementation; the parent and a fresh reviewer inspected it.
- [x] 5. Verify on the matching surface. The real CLI, disposable Postgres, and workflow checks passed. Live Neon execution remains unverified.
- [x] 6. Rebase into small, ordered commits. Stack follow-ups. One coherent implementation commit and one evidence commit use the current master base; no rebase is needed.
- [x] 7. If the design is contested, interrogate before shipping. Skip: design candidates and judge agreed. Independent review still found and closed a shared-secret race.
- [ ] 8. Run Opening a PR. The ready PR is the delivery step after this evidence commit. Human review and merge remain required.

## Throughput checkpoint

- [x] Blocking first steps. Verify secret metadata and configure the nonsecret org ID. Ground targeting, role, and Secret Manager assumptions before implementation.
- [x] Independent workstreams. Compare two read-only design candidates. One code owner implements the coupled API, workflow, tests, and docs after selection.
- [x] Shared mutable state. The user secret stays in GitHub. Local tests use synthetic API and secret adapters. Mutating CLI execution requires the exact master Neon dispatch job. Existing per-environment workflow concurrency serializes the secret prefix; a session database lock spans credential reads and both role transactions.
- [x] Smallest safe decomposition. One owner avoids competing edits to the same provisioning sequence. Parent reviews and records evidence separately.

## Known facts

The supplied project is patient-field-91651977, branch br-wandering-water-b45z70rz, database neondb, organization org-wispy-art-72697362. GitHub staging contains a NEON_API_KEY secret; only its name/presence was checked. The API key's validity and real database contents are not yet verified. There is no local Neon key or authenticated CLI profile. Both official Neon skills were installed globally for Codex without app repository changes.

The old provisioner discovers or creates gospel-staging, assumes gospel/gospel_owner, omits branch_id, writes the migration secret before detecting other target mismatches, and can adopt an existing managed-role name without proof it belongs to this app. We must replace that implicit path for this selected project.

Staging branch restrictions and WIF permit master only. The owner previously rejected unreviewed merges. New setup code must remain in a PR until human review and merge; no temporary branch exceptions, secret extraction, or browser login is needed.

## Decisions and review

Candidate A kept the operation and adapters in one importable module. Candidate B isolated metadata inspection more strongly but added unnecessary branding and report interfaces. The judge chose A with B's capability-limited inspector and endpoint validation. These were independent same-model reviews, not a cross-provider review.

Boundary Discipline shaped the metadata-only inspector and sanitized adapter failures. Model the Domain shaped the explicit selection and verified endpoint data. Make Operations Idempotent shaped stored-password reuse and persistence before SQL. Separate Before Serializing Shared State shaped workflow-only mutation after review exposed a race across different database targets sharing one environment prefix. Prove It Works required actual CLI execution and real catalog/password checks.

The fresh reviewer reproduced mixed-target secret writes from two local provisioners with distinct database locks. The final CLI rejects provisioning outside the exact master dispatch job before any API request. This removes those unsupported writers; existing workflow concurrency serializes the supported writers. Environment variables are an accident-prevention check, not an authentication substitute. GitHub environment policy and WIF remain the authorization boundary. Database roles are branch-wide, so environments require clean separate branches or projects. Cloning a branch after app roles exist intentionally fails the unknown-role collision check without matching saved credentials.

The configured Codex environment has neither Comment Sicko nor the deslop/control CLI plugins. A fresh same-model reviewer performed the comment and abstraction review; the parent inspected the actual CLI. The bundled GitHub watcher needs unavailable Bun. PR checks use GitHub CLI with an explicit merge-state and review-thread readback instead. These fallbacks do not count as the unavailable tools.

## Verification

- Parent ran `node --test scripts/cloud/neon-operation.test.mjs`: 113 tests passed, zero failed. Cases cover metadata-only defaults, target mismatches, all stored URLs, missing containers, collisions, crashes, overlapping same-database runs, redaction, and the real local CLI refusing mutation before fetch.
- Owner ran `node local-lab/verify-runtime.mjs`: 19 baseline runtime tests and three new real-Postgres proofs passed. The new proofs accept an empty schema, accept the checked-in migration catalog with reusable authenticating passwords, and reject a conflicting column without secret writes. [Runtime output](evidence/neon-existing/runtime.tap) is retained. Neon metadata and Secret Manager remain synthetic in this proof.
- Actionlint, TypeScript checks, module and shell syntax, workflow release simulations, and `git diff --check` passed. The parent independently repeated actionlint and all 22 workflow simulation checks after reviewing the final implementation.
- Parent read back all four Neon staging variables and the `NEON_API_KEY` secret name. Staging permits only the `master` branch. The key value was never read or printed.

No authenticated Neon call, real database query, GCP secret write, app deployment, or WhatsApp send ran for this change. The existing secret containers and scoped IAM grants remain prerequisites for provisioning. Default inspection needs no GCP credentials or approved content. After review and merge, run staging inspection first, then provision only after its report and secret prerequisites are verified. Production configuration and the separate reviewed 14-day content publication work remain outstanding.
