# Shared delivery runtime

The existing lab freezes a daily payload and commits an unknown attempt in Postgres before submitting HTTP. Competing replicas can claim a pending row only once. Exact simulator rejection permits another claim. Uncertain outcomes remain held. Status inspection confirms only a correlated receipt. The legacy root sender has process-local scheduling and file state, so the new runtime never imports it.

## Architecture decision

Two candidates were compared. Candidate A promotes the lab's delivery core through small clock, content, and provider boundaries. Candidate B creates an independent production package. An independent judge selected A because the failure suite then exercises the deployed claim policy. B's duplicated ledger was rejected. Its terminal failed state, read-only status, and scheduled reconciliation were retained. Both candidates' unsolicited Cloud SQL suggestion was rejected in favor of the selected Neon database.

`local-lab/src/delivery.ts` owns daily identity and state transitions. The lab's `core.ts` composes it with the existing fake provider and fixed clock. `runtime.ts` composes the same service with a real IST clock, reviewed content, and `green-api.ts`. The runtime image excludes all lab entry points and test code.

## Runtime commands

Build from the repository root with `docker build -f local-lab/Dockerfile.runtime -t gospel-runtime .`.

- `service` listens on `PORT`, default 8080. GET `/health` checks the schema. GET `/status` and `/get-status/{id}` read persisted state. Cloud Run IAM controls access. The service has read-only database credentials and no Green API token. A fresh service listens before migrations but returns 503 until its schema exists.
- `migrate` applies the checksum-tracked migration transactionally under a Postgres advisory lock. Use the separate owner credential.
- `send` requires `SENDING_ENABLED=true`, `FIRST_SEND_DATE`, a valid IST sending window, approved content for today, and Green API configuration. It makes at most one submission per daily record. Deployment keeps it disabled.
- `reconcile` polls a bounded batch of accepted records using the stored provider ID. It never submits a message.
- `check` emits structured delivery evidence for Cloud Monitoring. Held environments do not alert for an intentionally absent send. Unknown and failed records require attention. An enabled environment checks the daily delivery deadline.
- `content-check` requires fourteen consecutive approved dates beginning on the current IST date. It needs no database or provider credentials.

Database commands require `DATABASE_URL`. Connections validate TLS certificates. `APP_ENV` is staging or production. `CONTENT_DIR` defaults to `/app/content`. The image carries its source revision through the `RELEASE_SHA` build argument. Green commands use `GREEN_API_URL`, `GREEN_API_ID`, `GREEN_API_TOKEN`, and `TARGET_CHAT_ID`. The destination is fixed at process startup and cannot be supplied through an HTTP request.

## Evidence and limits

The production schema permits pending, unknown, accepted, confirmed, and failed states. It forbids returning to pending after a production attempt. Provider IDs are immutable strings. Runtime database rights cannot delete deliveries, edit payloads, change migration history, or rewrite recorded evidence. Initial evidence records the source revision and payload hash.

Green API acceptance proves queueing, not delivery. GetMessage must match the exact outgoing provider ID and chat before delivered or read confirms. A failed receipt is terminal. A timeout, malformed acceptance, failed bookkeeping, or lost response stays unknown. Unknown attempts cannot be correlated by guessing from text or time. The provider can send queued messages later. A hold cannot recall those messages or stop requests already in flight.

GetMessage history can lag and requires the appropriate outgoing-status settings. Configure these during isolated account setup. A dedicated test instance and a group with multiple participants are needed to establish actual group receipt behavior. Local contract fixtures do not establish live provider behavior.

Production activation is separate from provisioning. First verify staging, reconcile the old sender and provider queue, stop every old sending path, and choose the next eligible IST date. The new database cannot coordinate an old sender that does not use it. Rollback preserves delivery evidence and never resets an unknown attempt.

Run `node local-lab/verify.mjs all` for the simulator scenarios. Run `node local-lab/verify-runtime.mjs` for the actual production schema, restricted roles, content rules, and Green-shaped HTTP fixtures in an isolated Docker network. These checks never import the old sender or use real provider credentials.

Run `node local-lab/verify-image.mjs` to build and execute the production image with a private test CA and isolated TLS Postgres. It verifies certificate rejection, migrations, a nondefault port, status routes, and disabled startup without provider credentials. Docker resources and test private keys are removed; evidence stays under the ignored local-lab evidence directory. OpenSSL and Docker Compose are required.
