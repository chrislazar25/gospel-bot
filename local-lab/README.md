# Run the local delivery lab

Open [the whiteboard](WHITEBOARD.html) in your browser to see the components and failure behavior.

Start the lab from this directory with Docker Desktop running.

```sh
docker compose up --build -d
curl --fail --retry 30 --retry-connrefused --retry-all-errors \
  --retry-delay 1 --max-time 2 http://127.0.0.1:3101/health
curl -X POST http://127.0.0.1:3101/send-todays-message \
  -H 'Content-Type: application/json' -d '{}'
```

Use the returned application `id` with `GET http://127.0.0.1:3102/get-status/{id}`. Both app instances share the same database. Repeating the POST returns the same daily delivery. The fake provider is at `http://127.0.0.1:3103`.

The test clock is fixed in `config/clock.json`. Three dated files contain synthetic messages. They are not editorially approved Gospel content. No scheduler runs. Ports are bound to localhost. The app, fake, and database stay on an internal network. A local proxy exposes their test routes.

Postgres stores the frozen payload, daily delivery ID, attempts, and evidence. Its volume survives app restarts. Stop this developer stack without removing its data.

```sh
docker compose down
```

## Run the delivery checks

From the repository root, use host Node 22 or newer.

```sh
node local-lab/verify.mjs all
```

This creates a separate stack with random ports and an empty disposable volume. It exercises the real API against Postgres and the fake provider, keeps reports in `local-lab/evidence/`, and removes its own stack. It does not reset your developer stack. For the staged launch, doctor, drive, and cleanup workflow, use [verify-gospel-lab](../.cursor/skills/verify-gospel-lab/SKILL.md).

Run `node local-lab/verify-lifecycle.mjs` to check that a second launch preserves an unfinished run and repeated cleanup preserves its evidence.

The checks cover competing replicas, rejection and retry, accepted requests with lost responses, timeouts, malformed responses, generic server errors, failed database bookkeeping after acceptance, delayed receipts, database-only restarts, and IST midnight.

## Interpret the result

`pending` permits a claim. The app commits `unknown` before submitting HTTP. A proven simulator rejection permits a later retry. A valid acceptance becomes `accepted`. Only a delivered or read receipt becomes `confirmed`.

Unknown attempts stay held across retries and restarts. A lost response can leave a message unknown even if the fake provider's log shows acceptance. The application cannot use that administrative log to invent provider correlation. A crash after claiming but before sending can leave a day unsent.

This is a local simulation contract. Real Green API integration, editorial Git approval, AI ops, GCP deployment, and production cutover are separate milestones.

## Check the diagram

On macOS with Google Chrome installed, run `node local-lab/verify-whiteboard.mjs` from the repository root. It checks desktop and mobile layouts, every scenario button, and JavaScript errors. Screenshots and results stay in `local-lab/evidence/`.
