# Gospel Bot WhatsApp bridge

This bridge turns problem reports from one WhatsApp group into GitHub issues. It then mirrors each issue's status back to WhatsApp.

## What it does

The bridge links to a WhatsApp number as a linked device using Baileys. It watches one group. Each text message becomes an issue in the GitHub repo, labelled `benny:report` and `benny:new`. The bridge reacts to the message with 👀.

A photo is uploaded to the `benny-media` branch of the repo under `reports/` and embedded in the issue. Photos over 10 MB are noted instead of uploaded. The bridge downloads a photo only from an `https` host under `whatsapp.net`. A photo that points anywhere else is treated like a voice note, and the bridge logs `media_url_rejected`. Voice notes and videos without text get a 🤔 and a reply asking for a typed description. They do not become issues. View-once photos and videos get the same reply even with a caption. The bridge never downloads or uploads them, because the sender asked for them not to be kept. The token needs contents write access for the upload.

When someone quote-replies to a report or to one of the bridge's replies, the message becomes a comment on the same issue marked `<!-- wa-followup -->`. The bridge reacts with 👀. If the issue is in the `no-repro` state, it also adds the `benny:triage-again` label so the workflow triages it again. The bridge keeps the ids of its own replies in `reports.json` so this survives a restart.

Every poll it reads each open report's issue and derives a state from its labels. When the state changes, it reacts to the original message with the state's emoji. Some states also get a short reply that quotes the message. A closed issue with state reason `completed` counts as merged. Any other closed issue counts as closed. The bridge replies once and then stops tracking it. A stored report from a group other than `REPORT_GROUP_JID`, left over from a test group, is dropped without sending anything to that group, and the bridge logs `stale_group`.

States, labels, emojis and replies live in one table in `src/states.ts`. Every bot reply starts with "🤖 ".

Phone-like numbers are removed from issue titles, bodies and comments, including numbers written with non-breaking spaces, Unicode dashes or fullwidth digits. The sender's WhatsApp ID stays in `$BRIDGE_HOME/reports.json` and never goes to GitHub.

## Environment variables

- `GITHUB_TOKEN` is required. It needs permission to create and read issues and to write contents on the `benny-media` branch.
- `GITHUB_REPO` defaults to `chrislazar25/gospel-bot`.
- `REPORT_GROUP_JID` is required to run. Find it with `--list-groups`.
- `BRIDGE_HOME` defaults to `~/.gospel-bridge`. It holds the WhatsApp session in `auth/`, the report map in `reports.json`, and the single-instance lock in `bridge.lock`.
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

## Create the report group

```sh
npm run build
node dist/main.js --create-group "Gospel Bot help"
```

This creates a group with only you in it and prints its JID and subject. If WhatsApp rejects a group with no other participants, the command prints the reason and exits with code 2. Create the group in WhatsApp instead, then use `--list-groups`.

## Run

```sh
GITHUB_TOKEN=... REPORT_GROUP_JID=...@g.us npm start
```

The bridge logs one JSON object per line. It never logs tokens or message text. A `heartbeat` line appears every `POLL_SECONDS`.

The bridge is safe to run on a personal number. It never marks the owner online, never sends read receipts and does not sync message history. In run mode it never shows a QR code or pairing code. If the session is not linked or WhatsApp logs the device out, it logs `not_linked` or `wa_logged_out` and exits with code 3. Run `npm run link` to recover.

It also exits with code 3 instead of reconnecting when WhatsApp reports that another session replaced this one (`wa_replaced`), refused the device (`wa_forbidden`) or found a multi-device mismatch (`wa_multidevice_mismatch`). Reconnecting there would make two clients fight over the owner's account. Find the other bridge or linked device before you start it again.

Only one bridge process runs per `BRIDGE_HOME`. Every mode takes `$BRIDGE_HOME/bridge.lock`, which holds the process id. If a live process already holds it, the new one logs `already_running` and exits with code 2. That includes `--link`, `--list-groups` and `--create-group`, so stop the service first:

```sh
launchctl bootout gui/$(id -u)/com.chrislazar.gospel-bridge
```

A lock left by a process that died, or by a run before the last reboot, is replaced. The lock is removed when the process exits.

Exit codes:

- 0 means the bridge stopped cleanly.
- 1 means it crashed. Restart it.
- 2 means bad config, a failed `--create-group`, or another bridge already running on this `BRIDGE_HOME`.
- 3 means the number needs linking again, or another session took over the account. Do not restart until you have fixed that.

## Develop

```sh
npm run check
npm test
```
