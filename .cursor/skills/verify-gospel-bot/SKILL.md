---
name: verify-gospel-bot
description: Prove a Gospel Bot change before it ships, and read production state without changing it. Covers the local delivery lab, the production runtime and image, the content pipeline, workflows and Terraform, and read-only production checks. Use when adding a feature, fixing a bug, or reviewing a change in this repository.
---

# Verify Gospel Bot

Run from the repository root with host Node 22 or newer. Run `npm ci --prefix local-lab` once in a fresh checkout. Docker, Terraform 1.14, and actionlint are required for some checks.

## Pick the checks for your change

The [feature map](features/README.md) lists each feature and the commands that prove it.

| You changed | Run |
| --- | --- |
| `local-lab/src/delivery.ts` or the send path | The [lab drive](#drive-the-lab), then `node local-lab/verify-runtime.mjs` |
| `local-lab/src/runtime.ts`, `green-api.ts`, `status.ts`, or `migrations/` | `node local-lab/verify-runtime.mjs`, then `node local-lab/verify-image.mjs` |
| `content/`, `scripts/`, `gospel_matcher.js`, or `parse_gospel.js` | `node --test tests/content.test.js` |
| `infra/` or a workflow | The commands in [cloud checks](features/cloud-checks.md) |
| `scripts/cloud/` | The commands in [cloud checks](features/cloud-checks.md) |

The lab and production differ in three ways. Only the runtime suite proves production behavior.

- The lab loads `local-lab/schema.sql`. Production loads `local-lab/migrations/`, which forbids `unknown` returning to `pending`. A lab pass does not prove production state transitions.
- The lab sends through `POST /send-todays-message`, and its `GET /get-status/{id}` checks receipts. Production sends through the `send` job, and its status service only reads.
- The lab's fake provider can reject a message. The Green API provider never reports a rejection, so production uses `ready()` before the claim instead.

## Drive the lab

Use a separate state path for every session. Keep the variable in the same shell for all stages. Never import or run old sender code from Git history, and never supply production credentials.

```sh
export LAB_RUN_STATE="$(mktemp -d /tmp/gospel-verify.XXXXXX)/state.json"
node local-lab/verify.mjs launch
node local-lab/verify.mjs doctor
node local-lab/verify.mjs drive
```

The launch builds the real image and starts a unique Compose project with random loopback ports and an empty database volume. Read the assigned URLs and the evidence directory from `$LAB_RUN_STATE`. Do not assume ports 3101 through 3103 belong to this session. An unfinished selected run blocks another launch. Clean it up first, or select a different state path.

Doctor must print the owned-project readiness message. A prerequisites-only result means there is no active session to drive. Stop and inspect the selected state file, Compose logs, and Docker status. Do not drive another project's ports.

Drive once against a fresh launch. The helper uses the public routes, the fake provider's controls, and direct test setup: it rewrites the clock and fixture files, truncates tables, and injects a failing trigger through `psql`. It refuses to truncate outside a `gospel-lab-*` project.

A simulator rejection is not proof that a real provider's HTTP error permits a retry. The sender must never use the fake provider's log to recover a lost provider ID.

## Keep the evidence

The state file names `directory`. Keep its `report.json`, `state.json`, and `compose.log` under `local-lab/evidence/gospel-lab-*/`. Git ignores evidence. Require successful checks, the returned delivery ID and state, and the independent fake-provider acceptance count. A compiler pass or a final status alone does not prove delivery behavior.

## Clean up

Run this after success and after a failed iteration.

```sh
node local-lab/verify.mjs cleanup
node -e 'const f=require("node:fs");const s=JSON.parse(f.readFileSync(process.env.LAB_RUN_STATE));const r=JSON.parse(f.readFileSync(s.directory+"/report.json"));if(!s.cleaned||!r.startedAt)process.exit(1);console.log(s.directory)'
```

After a successful drive, confirm that the report contains all checks and no error. A launch that fails before the drive can leave a report with zero checks.

Cleanup removes only the helper's unique Compose project and disposable volume. It preserves the report and logs. Do not run a global Docker prune or remove the developer's normal Compose volume. If cleanup fails, report the exact project and failure before another attempt. Repeating cleanup on a cleaned run leaves its files unchanged.

## Use the helpers

- `node local-lab/verify.mjs all` runs an isolated launch, drive, and cleanup in one process. CI uses it.
- `node local-lab/verify-lifecycle.mjs` checks launch refusal, ownership preservation, repeated cleanup, and reuse after cleanup through the real CLI and Docker.

## Read production

[Production](features/production.md) lists read-only checks. Run them after a release and when something looks wrong. Never run a production job, a release, or an Infrastructure apply as part of verification. Those steps need the operator's approval and are in `docs/operations.md`.

## What stays unproven

No local check proves IAM, Neon permissions, real WhatsApp receipts, or alert email delivery. The staging canary and cloud smoke are live checks in `docs/staging-canary.md` and `docs/cloud-smoke.md`. They run only through their workflows on `master`.

Use `pstack:maintain-verification-skill` when routes or behavior change to keep this map aligned.
