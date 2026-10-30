# Gospel Bot

Gospel Bot posts one reviewed Gospel message to the family WhatsApp group each day. The messages come from an archive of notes written over many years. A person approves every message in a pull request before it can send.

## What happens each day

All times are in `Asia/Kolkata` (IST). 00:30 IST is 14:00 in US Central daylight time and 13:00 in US Central standard time.

| Time | Job | What it does |
| --- | --- | --- |
| 00:30 | `send` | Sends the approved message for that date through Green API. |
| 00:45 | `send` | Retries if the first run could not start the attempt. It never sends a second message. |
| 00:00 to 01:50, every 10 minutes | `reconcile` | Asks Green API whether the message reached the group. |
| 01:00 | | Delivery deadline. A message that is not confirmed by the next check raises an alert. |
| 01:30 | | The send window closes. |
| 5 minutes past each hour | `check` | Logs delivery state and the number of approved days left. |
| 09:00 | `Content batch` workflow | Opens a review PR when fewer than 21 approved days remain. |

Alerts go by email from Google Cloud Monitoring.

## How it runs

The jobs run on Cloud Run with Cloud Scheduler. A Neon Postgres table holds one row per group per day, and that row stops a message from sending twice. Approved messages are files in `content/messages/`, and the release image contains them. To change a message that has reached production, you release a new image.

GitHub Actions builds, tests, and releases. Terraform owns the cloud resources. Production runs the same image that passed staging.

## Where things live

| Path | Contents |
| --- | --- |
| `local-lab/src/` | The delivery code. `runtime.ts` is the production entry point. `delivery.ts` owns the daily state. |
| `local-lab/migrations/` | The production database schema. |
| `content/messages/` | Approved messages, one file per IST date. |
| `gospel_messages.json` | The parsed archive. `scripts/open-batch.js` drafts batches from it. |
| `parse_gospel.js`, `gospel_matcher.js` | The archive importer and the citation matcher. |
| `infra/` | Terraform for bootstrap, environments, the smoke job, and the canary. |
| `scripts/cloud/` | Build, release, Neon, smoke, and canary scripts. |
| `.github/workflows/` | CI, Content batch, Infrastructure, Neon databases, and Release. |

The directory is named `local-lab` because the code started as a local simulator. The production image is built from it.

## Read next

- [Run production](docs/operations.md) covers alert emails, status checks, content and code releases, and switching delivery off.
- [Review a content batch](docs/content-review.md) covers message approval.
- [Set up an environment](docs/deployment.md) covers a first-time build.
- [Shared delivery runtime](docs/runtime-design.md) explains the delivery states.
- [Staging canary](docs/staging-canary.md) and [cloud smoke](docs/cloud-smoke.md) explain the two live checks.

## Change the code

To verify a change, follow the `verify-gospel-bot` skill in `.claude/skills/`. It maps each feature to the commands that prove it. These commands cover most changes.

```sh
npm ci --prefix local-lab
node --test tests/content.test.js
node local-lab/verify.mjs all
node local-lab/verify-runtime.mjs
```

Merging to `master` deploys nothing. A release is a separate manual step in [Run production](docs/operations.md).

## Credits

- Daily readings come from [cpbjr/catholic-readings-api](https://github.com/cpbjr/catholic-readings-api).
- WhatsApp delivery uses [Green API](https://green-api.com/).
