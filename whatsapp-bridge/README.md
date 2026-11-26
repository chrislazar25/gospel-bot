# Gospel Bot WhatsApp bridge

This bridge turns problem reports from one WhatsApp group into GitHub issues. It then mirrors each issue's status back to WhatsApp.

## What it does

The bridge links to a WhatsApp number as a linked device using Baileys. It watches one group. Each text message becomes an issue in the GitHub repo, labelled `benny:report` and `benny:new`. The bridge reacts to the message with 👀.

A photo is uploaded to the `benny-media` branch of the repo under `reports/` and embedded in the issue. Photos over 10 MB are noted instead of uploaded. Voice notes and videos without text get a 🤔 and a reply asking for a typed description. They do not become issues. The token needs contents write access for the upload.

Every poll it reads each open report's issue and derives a state from its labels. When the state changes, it reacts to the original message with the state's emoji. Some states also get a short reply that quotes the message. A closed issue with state reason `completed` counts as merged. Any other closed issue counts as closed. The bridge replies once and then stops tracking it.

States, labels, emojis and replies live in one table in `src/states.ts`. Every bot reply starts with "🤖 ".

Phone-like numbers are removed from issue text. The sender's WhatsApp ID stays in `$BRIDGE_HOME/reports.json` and never goes to GitHub.

## Environment variables

- `GITHUB_TOKEN` is required. It needs permission to create and read issues and to write contents on the `benny-media` branch.
- `GITHUB_REPO` defaults to `chrislazar25/gospel-bot`.
- `REPORT_GROUP_JID` is required to run. Find it with `--list-groups`.
- `BRIDGE_HOME` defaults to `~/.gospel-bridge`. It holds the WhatsApp session in `auth/` and the report map in `reports.json`.
- `PAIR_PHONE` is optional. Digits only, with country code. When set, linking uses a pairing code instead of a QR.
- `POLL_SECONDS` defaults to 60. It sets the poll interval and the heartbeat interval.

## Link the number

```sh
npm ci
npm run link
```

Scan the QR code in WhatsApp under Linked devices. Or set `PAIR_PHONE` and enter the printed code. The command prints `linked` and exits.

## List groups

```sh
npm run build
node dist/main.js --list-groups
```

This prints each group's JID and subject. Copy the JID of the report group into `REPORT_GROUP_JID`.

## Run

```sh
GITHUB_TOKEN=... REPORT_GROUP_JID=...@g.us npm start
```

The bridge logs one JSON object per line. It never logs tokens or message text. A `heartbeat` line appears every `POLL_SECONDS`. If WhatsApp logs the device out, the bridge exits with code 1. Link again to recover.

## Develop

```sh
npm run check
npm test
```
