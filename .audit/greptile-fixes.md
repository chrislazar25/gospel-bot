# Greptile fixes for human review

No merge, deployment, cloud provisioning, secret mutation, or live provider call is authorized by this repair pass. The result is a new open PR for the user's review.

## Checklist

- [x] Reproduce or confirm the nine reported mechanisms from current source.
- [x] Separate runtime, cloud workflow, and local tooling ownership into worktrees.
- [ ] Add failing behavioral regressions for each finding.
- [ ] Repair the first incorrect decision in each path.
- [ ] Verify on the same CLI/database surface.
- [ ] Review the combined diff and run required checks.
- [ ] Open an unmerged PR with every finding mapped to its fix and evidence.

## Data and ownership

Daily identity remains channel, chat target, and IST date. Provider acceptance remains distinct from delivery. Existing delivery evidence will record each receipt-check attempt, including unavailable receipts. Reconciliation orders accepted rows by their latest evidence activity so later rows eventually receive a turn without changing the immutable daily payload or migration history.

Monitoring reads the configured destination, and uses the sender's first eligible date before deciding a daily message is overdue. Receipt polling consumes stored IDs and provider configuration only; it must not load message content.

Cloud repair separates deployment from the authenticated smoke check. The workflow requests an ID token with the service URL as audience. Production promotion is one executable gate used by both the workflow and its failure-case tests. SQL role changes are one transaction per role.

Image checks use separate empty and valid content fixtures. Browser startup is awaited, and cleanup waits for close even when no child process started.

## Throughput checkpoint

Runtime changes and real Postgres regressions run first. Cloud and tooling fixes are built in separate worktrees. Integrate their commits only after inspecting their diffs. Run the original simulator suite, production schema/role tests, actual TLS image checks, browser cleanup/normal behavior, workflow scenarios, and syntax validation once the combined unit is ready. Push only after these pass; leave all merges and cloud operations to explicit user approval.
