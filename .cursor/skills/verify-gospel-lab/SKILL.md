---
name: verify-gospel-lab
description: Launch and drive the Gospel local delivery API with Docker, real Postgres, and a fake WhatsApp boundary. Use to verify daily send safety, status, retries, and restart behavior. Does not verify production Green API or deploy GCP.
---

# Verify the Gospel local lab

Run from the repository root with Docker Desktop running and host Node 22 or newer. The application is in `local-lab/`. Never import the legacy root `app.js` or supply production credentials.

## Launch

Use a separate state path for every verification session. Keep the variable in the same shell for all stages.

```sh
export LAB_RUN_STATE="$(mktemp -d /tmp/gospel-verify.XXXXXX)/state.json"
node local-lab/verify.mjs launch
```

The helper builds the real image, starts a unique Compose project with random loopback ports and an empty database volume, and initializes the schema and synthetic content. Ready means both application replicas and the fake provider pass health checks against the initialized database. Read the assigned URLs and evidence directory from `$LAB_RUN_STATE`. Do not assume ports 3101 through 3103 belong to this session.

An unfinished selected run blocks another launch. Clean it up first, or select a different state path for an independent session.

## Doctor

```sh
node local-lab/verify.mjs doctor
```

Require the owned-project readiness message. A prerequisites-only result means there is no active session to drive. Stop and inspect the selected state file, Compose logs, and Docker status. Do not drive another project's ports.

## Drive

```sh
node local-lab/verify.mjs drive
```

Drive once against a fresh launch. The helper calls the public `POST /send-todays-message` and `GET /get-status/{id}` endpoints. Consult [the feature map](features/README.md) for the observable proofs. Repeating POST uses the same daily ID. GET can inspect receipts but cannot submit messages.

The fake provider is the isolated external boundary. Its administrative controls create failures and its acceptance log proves external side effects. The sender must never consume that log to recover a lost provider ID. A simulator rejection is not proof that a real provider's HTTP error permits retry.

## Evidence

The selected state file names `directory`. Keep its `report.json`, `state.json`, and `compose.log` under `local-lab/evidence/gospel-lab-*/`. Evidence is ignored by Git. Require successful checks, the action's returned delivery ID and resulting state, and the independent fake-provider acceptance count. A compiler pass or a final status alone does not prove delivery behavior.

## Cleanup

Run after success and after a failed iteration.

```sh
node local-lab/verify.mjs cleanup
node -e 'const f=require("node:fs");const s=JSON.parse(f.readFileSync(process.env.LAB_RUN_STATE));const r=JSON.parse(f.readFileSync(s.directory+"/report.json"));if(!s.cleaned||!r.startedAt)process.exit(1);console.log(s.directory)'
```

After a successful drive, confirm that the report still contains all checks and no error. A launch that fails before the drive can leave a report with zero checks.

Cleanup removes only the helper's unique Compose project and disposable volume. It preserves the report and logs. Do not run a global Docker prune or remove the developer's normal Compose volume. If cleanup fails, report the exact project and failure before another attempt.

Repeating cleanup on a cleaned run leaves its saved logs, report, and state unchanged.

## Helpers

`node local-lab/verify.mjs all` runs an isolated launch, drive, and cleanup in one process. Use the staged commands above to prove this skill itself. Concurrent sessions require distinct `LAB_RUN_STATE` paths. All paths and ports are local. This verifies a local stand-in only. GCP identities, secrets, scheduler, real provider receipt correlation, editorial approval, and production cutover remain unverified.

Run `node local-lab/verify-lifecycle.mjs` to check launch refusal, ownership preservation, repeated cleanup, and reuse after cleanup through the real CLI and Docker. Its logs and report stay in `local-lab/evidence/lifecycle-*/`.

Use `pstack:maintain-verification-skill` when routes or behavior change to keep this map aligned.
