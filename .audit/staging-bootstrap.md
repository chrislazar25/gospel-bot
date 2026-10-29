# Prepare isolated staging through CI

## Scope and current evidence

The user merged PR #10 and authorized live inspection and setup. [Neon inspection 40817535667](https://github.com/chrislazar25/gospel-bot/actions/runs/40817535667) succeeded on master e81a75c. The staging key can read organization org-wispy-art-72697362, project patient-field-91651977 named gospel-bot, branch br-wandering-water-b45z70rz named production, database neondb, owner neondb_owner, and the enabled direct endpoint. This was API metadata only, not a SQL or credential test.

The user explicitly chose a separate staging branch and reserved the existing production branch. The durable staging variable NEON_PARENT_BRANCH_ID now identifies that original branch. NEON_BRANCH_ID still identifies the original branch until a verified child exists. No branch creation or database-role provisioning has run.

GCP has no staging app secret containers. The current secrets-only workflow cannot bootstrap without unrelated app configuration. A real Terraform test against a copy of the checked-in root failed with `Error: No value for required variable` for image, Green API, target, notification, secret-version, and status inputs. Targeting secret resources does not make these mandatory root inputs optional.

## Plan and throughput

- [x] Ground the current workflow, Terraform input contract, and branch API in source and official documentation.
- [x] Reproduce the targeted plan failure before implementation.
- [x] Compare two architectural candidates and obtain an independent judgment.
- [x] Delegate the coupled workflow, operation, tests, and deployment instructions to one code owner.
- [x] Independently inspect the diff and reproduce the fixed plan with minimal real GCP inputs.
- [ ] Open one unmerged PR, check CI and the first Greptile review, and fix supported findings.

Blocking first steps were the live metadata inspection, environment decision, and Terraform reproduction. Branch preparation and secret planning have independent external targets, but one owner edits their shared workflow/configuration instructions. The parent owns this audit. Existing cloud-staging concurrency serializes actual workflow operations. No work is split across writers of one file or branch.

Data shapes are BranchPreparation with organizationId, projectId, immutable parentBranchId, databaseName, and fixed branchName gospel-staging; and the existing verified target with endpoint and actual owner metadata. Preparation reports metadata only. Secret bootstrap requires project, environment, and region; full application deployment retains its own required configuration.

## Chosen design

Candidate A extends the existing operation boundary and adds preconditions at existing Terraform consumers. Candidate B uses a separate CLI and a configuration-gate resource. The judge chose A to avoid duplicate transport/configuration logic and new state objects. B contributed explicit report filtering and failure-order coverage.

The root, state prefix, and resource addresses stay unchanged. Nullable app-only inputs and null-safe validation permit the prerequisite graph; blocking consumer preconditions preserve full-plan rejection. The secrets operation removes unused app variable exports. It never invents an app image, provider configuration, chat, or secret version.

Preparation requires the exact master staging dispatch job before API access. It verifies the selected parent, exhausts bounded branch pagination, reuses only a matching child, and otherwise attempts one creation with an explicit parent and read/write endpoint. The raw creation response is discarded because Neon can include credentials. GET reconciliation handles ambiguous outcomes; no blind POST retry, deletion, or repair occurs. [Neon branch naming requirements](https://neon.com/docs/manage/branches) specify unique branch names within a project.

Laziness Protocol shaped reuse of the root and operation module. Boundary Discipline shaped context validation and metadata reports. Make Operations Idempotent shaped read-before-create and ambiguous-outcome reconciliation. Prove It Works requires the real targeted plan and missing/full application configuration checks.

## Execution boundary

The new workflow must be reviewed and merged by the user before execution because staging permits only master and the user requires review before merges. Do not merge it on the user's behalf or weaken the branch policy. After merge, prepare the child, read its verified ID, update staging NEON_BRANCH_ID, inspect it, create empty secret containers through Infrastructure secrets, and provision database roles through Neon provision-existing. The production branch remains reserved. Message sending and application deployment are outside this bootstrap change.

## Verification results

The regression test landed before its fix. The same Terraform target now succeeds. Terraform 1.14.0, matching CI, passed all four mock-provider runs: minimal bootstrap, rejected incomplete application, configured application with numeric secret pins, and rejected malformed configuration. The parent downloaded the pinned binary and verified its official SHA256 checksum.

The parent then used the real GCP backend with only project and environment inputs. The saved, unapplied plan contains exactly four new secret containers and six new IAM bindings, all scoped to the three database secrets and the staging Neon identity. It contains no application or secret-version resources. The parent checked every resource address, action, secret name, role, and member. [Plan summary](evidence/staging-bootstrap/secrets-plan-summary.json) records the allowlisted result. No apply occurred.

Both Neon test files passed 145 tests, including first creation, zero-write reuse, fixed ancestry, pagination limits, ambiguous POST reconciliation, initialization bounds, credential redaction, and actual CLI rejection of unsupported contexts. A fresh same-model reviewer independently repeated those tests and found no issues. Actionlint, the 22 existing workflow simulations, and diff checks passed. Comment Sicko and deslop are unavailable; manual comment and abstraction review served as the fallback.

The implementation owner completed the Terraform commits and most branch preparation before reaching its usage limit. The parent reviewed and finished CI wiring and deployment instructions. No claim of live branch creation or database connectivity follows from these tests. Only the earlier metadata inspection has run against Neon.
