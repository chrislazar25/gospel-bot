# Production runtime

## Sub-features

- Run one of six commands: `service`, `send`, `reconcile`, `check`, `migrate`, and `content-check`.
- Check Green API state before claiming the day. If the instance is not ready, no attempt starts and the day stays `pending`.
- Allow one attempt per day. An uncertain attempt stays `unknown` and is never retried.
- Confirm delivery only from a receipt that matches the provider ID and the chat.
- Refuse to send outside the window, before `FIRST_SEND_DATE`, or with `SENDING_ENABLED=false`.

## How to get to it (user POV)

Cloud Scheduler starts each job. An operator can run a job by hand, as `docs/operations.md` describes. `local-lab/src/runtime.ts` is the entry point.

## Driving it

```sh
node local-lab/verify-runtime.mjs
node local-lab/verify-image.mjs
```

`verify-runtime.mjs` runs the unit and integration suites in Docker against real Postgres, the production migration, the restricted database roles, and Green-shaped HTTP fixtures. Require `# fail 0` for each suite. `verify-image.mjs` builds the production image and runs it with a private test CA and TLS Postgres. It checks certificate rejection, migrations, a nondefault port, status routes, and disabled startup.

To change delivery behavior, add a case to `local-lab/src/runtime.integration.test.ts`. Its `mode` variable selects the provider behavior.

## Gotchas

`send` exits 0 after `sending_held`, including the reason `provider_not_ready`. The hourly `check` raises the alert after the 01:00 IST deadline. The check and status jobs have no Green API token by design.

Green API acceptance is not delivery. These fixtures do not prove live provider behavior. The canary and production logs do.
