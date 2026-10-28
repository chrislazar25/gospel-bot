# Greptile fixes for human review

No merge, deployment, cloud provisioning, secret mutation, or live provider call is authorized by this repair pass. The result is a new open PR for the user's review.

## Checklist

- [x] Reproduce or confirm the nine reported mechanisms from current source.
- [x] Separate runtime, cloud workflow, and local tooling ownership into worktrees.
- [x] Add behavioral regression coverage for the flagged paths, with live-auth limits stated below.
- [x] Repair the first incorrect decision in each path.
- [x] Verify runtime behavior on the CLI/database surface and workflow behavior with offline command stubs.
- [x] Independently review the combined diff and run the local checks listed below.
- [x] Prepare an unmerged PR with every finding mapped to its fix and evidence.

## Findings and fixes

All findings remain present on master until this repair PR is reviewed and merged. The original review threads are historical evidence, not a record of fixes already deployed.

| Finding | Fix | Behavioral evidence |
| --- | --- | --- |
| [PR 4: Chrome startup cleanup](https://github.com/chrislazar25/gospel-bot/pull/4#discussion_r4394192334) | Await spawn inside cleanup scope and wait for close. | `whiteboard-startup.test.mjs` proves missing and non-executable Chrome paths fail without leaked profiles. Normal desktop/mobile verification also passes. |
| [PR 6: Approved content breaks CI](https://github.com/chrislazar25/gospel-bot/pull/6#discussion_r4394649232) | Mount separate empty and valid fourteen-day fixtures. | `verify-image.mjs` rejects the empty fixture and accepts the valid fixture using the actual runtime image. |
| [PR 6: Receipt backlog starvation](https://github.com/chrislazar25/gospel-bot/pull/6#discussion_r4394649242) | Record every receipt poll in existing durable evidence and prioritize least recently active accepted records. | `runtime.integration.test.ts` creates 51 accepted rows. Two batches using separate service instances confirm row 51 despite older unavailable or sent receipts, with zero sends. The regression failed against the old selector before the fix. |
| [PR 6: Wrong group masks missing delivery](https://github.com/chrislazar25/gospel-bot/pull/6#discussion_r4394649258) | Filter checker reads by Green API and configured target. Supply TARGET_CHAT_ID to the check job. | `verify-image.mjs` seeds a different confirmed group and asserts the configured missing group produces a delivery problem and nonzero exit. |
| [PR 6: Content blocks reconciliation](https://github.com/chrislazar25/gospel-bot/pull/6#discussion_r4394649272) | Load content inside the send callback, not when constructing the receipt service. | The image's reconcile CLI starts with a nonexistent content directory and no accepted rows. Actual receipt requests are covered separately by production-schema integration tests. |
| [PR 6: Early deadline alerts](https://github.com/chrislazar25/gospel-bot/pull/6#discussion_r4394649283) | Gate deadline alerts on the sender's first eligible date. | `verify-image.mjs` asserts enabled sending with a future start date reports held, succeeds, and emits no missing-delivery problem. |
| [PR 7: WIF ID-token authentication](https://github.com/chrislazar25/gospel-bot/pull/7#discussion_r4394678516) | Request an ID token through the auth action for the deployed URL, then pass it to `smoke.sh`. | `verify-workflows.mjs` checks deployment URL output and supplied-token smoke behavior. The unsupported gcloud command is removed. Live WIF exchange remains untested. |
| [PR 7: Interrupted role grants](https://github.com/chrislazar25/gospel-bot/pull/7#discussion_r4394678529) | Reconcile each role's password and grants in one SQL transaction. | `neon-role.test.mjs` uses actual isolated PostgreSQL for SQL-error rollback, terminated-connection rollback, concurrent reads, repeated restricted grants, and read-only status defaults. |
| [PR 7: Untested production promotion](https://github.com/chrislazar25/gospel-bot/pull/7#discussion_r4394678536) | Extract `promote.sh` and call it from the production workflow and tests. | The shared executable accepts tested staging evidence and rejects failed runs, wrong commits, candidate-only runs, missing artifacts, wrong event/branch/workflow/environment, and invalid digests. |

## Verification

Run these commands from the repository root. They use local containers or command stubs and make no cloud or live provider changes.

```sh
npm ci --prefix local-lab
npm run check --prefix local-lab
node local-lab/verify.mjs all
node local-lab/verify-lifecycle.mjs
node local-lab/verify-runtime.mjs
node local-lab/verify-image.mjs
node --test local-lab/whiteboard-cdp.test.mjs local-lab/whiteboard-startup.test.mjs
node local-lab/verify-whiteboard.mjs
node scripts/cloud/verify-workflows.mjs
actionlint .github/workflows/*.yml
shellcheck scripts/cloud/*.sh
terraform fmt -check -recursive infra
git diff --check
```

Local results are 34 simulator assertions, a passing helper lifecycle regression, 19 runtime/database tests, 15 runtime-image checks with cleanup, six browser protocol/startup tests, and 21 offline workflow scenarios. Browser visual checks cover desktop and mobile with no page errors or external requests. Terraform init with backend disabled and validate check both modules without applying resources. CI runs the SQL role tests through the isolated runtime verification image and the Chrome startup tests in Delivery lab. The Infrastructure validation job runs the promotion scenarios.

An [independent same-model reviewer](greptile-fixes-review.md) found no blockers in the combined diff, including the final CI/test-image wiring. It independently ran the offline workflow and Chrome startup tests and inspected the supplied database log. It did not independently rerun the Docker suites. Cross-family review is unavailable under the configured model preference. Manual style and comment review replaced the unavailable Cursor-only review plugins.

## Fresh review follow-up

Greptile's [PR 8 midnight finding](https://github.com/chrislazar25/gospel-bot/pull/8#discussion_r4395311396) identified a real race in the image harness. Fixtures captured today's date while later runtime containers read the wall clock again. Crossing IST midnight could invalidate the fourteen-day horizon or turn tomorrow's first send date into today.

The harness now fixes both fixtures and runtime containers at `2026-01-15T18:29:59.900Z`, one tenth of a second before IST midnight. A locally generated, read-only Node test-clock module loads through NODE_OPTIONS in those test containers. `/status` must report that exact fixed date. The clock module is not included in the published image, and production code and time handling are unchanged.

To reproduce the mismatch, the previous harness ran with its host Date shifted one day behind the containers. Its valid-content check failed. The revised harness ran under the same host shift and passed all 15 image checks plus cleanup. A [focused independent review](greptile-midnight-review.md) covers this follow-up; its evidence and narrower scope supplement the combined review above.

## Review limits and reading order

Read `local-lab/src/delivery.ts`, then `local-lab/src/runtime.ts` and `status.ts`. For release/setup, read `.github/workflows/release.yml`, `scripts/cloud/promote.sh`, `smoke.sh`, and `neon-role.mjs`. Test helpers contain synthetic inputs only.

The receipt ordering reuses the existing evidence schema so existing lab volumes and migration history remain compatible. Each poll appends evidence and the selector aggregates its history. This adds database work; no throughput or latency improvement is claimed. Concurrent workers may repeat receipt reads, but reconciliation never submits another message.

The missing-content CLI test has no accepted rows. The backlog test recreates the service rather than killing a worker mid-batch. Workflow stubs do not execute GitHub's auth action or prove live IAM behavior. Neon API provisioning, Green API delivery, production promotion on GitHub, and monitoring/alert routing remain unverified live. No cloud resources, secrets, schedules, or provider instances were changed by this repair pass.

## Data and ownership

Daily identity remains channel, chat target, and IST date. Provider acceptance remains distinct from delivery. Existing delivery evidence will record each receipt-check attempt, including unavailable receipts. Reconciliation orders accepted rows by their latest evidence activity so later rows eventually receive a turn without changing the immutable daily payload or migration history.

Monitoring reads the configured destination, and uses the sender's first eligible date before deciding a daily message is overdue. Receipt polling consumes stored IDs and provider configuration only; it must not load message content.

Cloud repair separates deployment from the authenticated smoke check. The workflow requests an ID token with the service URL as audience. Production promotion is one executable gate used by both the workflow and its failure-case tests. SQL role changes are one transaction per role.

Image checks use separate empty and valid content fixtures. Browser startup is awaited, and cleanup waits for close even when no child process started.

## Throughput checkpoint

Runtime changes and real Postgres regressions run first. Cloud and tooling fixes are built in separate worktrees. Integrate their commits only after inspecting their diffs. Run the original simulator suite, production schema/role tests, actual TLS image checks, browser cleanup/normal behavior, workflow scenarios, and syntax validation once the combined unit is ready. Push only after these pass; leave all merges and cloud operations to explicit user approval.
