# Gospel Bot WhatsApp bridge

This bridge turns problem reports from one WhatsApp group into GitHub issues. It then mirrors each issue's status back to WhatsApp.

## What it does

The bridge links to a WhatsApp number as a linked device using Baileys. It watches one group. Messages sent while the Mac was offline arrive when it reconnects. The bridge records when it was last connected in `$BRIDGE_HOME/last-seen.json`, on every message it takes and every heartbeat. On reconnect it takes messages sent since 10 minutes before that time, or in the last 24 hours if that reaches further back, and never any older than 14 days. It applies the same group, bot-reply and ledger checks as live messages. Each text message becomes an issue in the GitHub repo, labelled `benny:report` and `benny:new`. The bridge reacts to the message with 👀.

A photo is uploaded to the `benny-media` branch of the repo under `reports/` and embedded in the issue. Photos over 10 MB are noted instead of uploaded. The bridge downloads a photo only from an `https` host under `whatsapp.net`. A photo that points anywhere else is treated like a voice note, and the bridge logs `media_url_rejected`. The bridge fetches the photo itself rather than through Baileys, because Baileys follows redirects to any host. It refuses redirects, gives up after 60 seconds, and decrypts the photo the way Baileys does. Voice notes and videos without text get a 🤔 and a reply asking for a typed description. They do not become issues. View-once photos and videos get the same reply even with a caption. The bridge never downloads or uploads them, because the sender asked for them not to be kept. The token needs contents write access for the upload.

When someone quote-replies to a report or to one of the bridge's replies, the message becomes a comment on the same issue marked `<!-- wa-followup:<message id> -->`. The bridge reacts with 👀. If the issue is in the `no-repro` state, it also adds the `benny:triage-again` label so the workflow triages it again. The bridge keeps the ids of its own replies in `reports.json` so this survives a restart. The bridge records a follow-up as pending in the ledger before it posts the comment, and as done once GitHub confirms it. If the response is lost, the next poll or a redelivery lists the issue's comments and adopts the one carrying that message id instead of posting again. A pending follow-up is forgotten on the same terms as a pending report. If adding the `benny:triage-again` label fails, the bridge records that the issue still owes a re-triage and retries every poll until GitHub accepts it.

Every poll it reads each open report's issue and derives a state from its labels. When the state changes, it reacts to the original message with the state's emoji. Some states also get a short reply that quotes the message. A closed issue with state reason `completed` counts as merged. Any other closed issue counts as closed. The bridge replies once and then stops tracking it. Every reaction and reply goes through one check that refuses any chat other than `REPORT_GROUP_JID`. At start the bridge drops stored reports from another group, left over from a test group, and marks that group's pending messages done without looking for their issues. It sends nothing to that group and logs `stale_group`.

Each status reply gets a message id derived from the issue, the state and the number of earlier replies, in the same `3EB0...` shape Baileys generates. The bridge saves the id and the new state before it sends. If the send times out or the bridge exits before confirming, the next poll sends the reply again with the same id. Unverified: we expect WhatsApp to treat a resend with an id it already accepted as the same message, but we have not confirmed that against a live account.

`reports.json` also keeps a ledger of the last 1000 WhatsApp message ids the bridge has handled, so a redelivered message never becomes a second issue. Eviction never drops a pending message or the message of a report the bridge still tracks, and a message whose id belongs to a tracked report counts as handled even without a ledger entry. Before creating an issue the bridge records the message as pending. If the create response is lost or the bridge crashes before saving the issue, each poll looks for the issue by its `<!-- wa-message:... -->` marker and adopts it. The lookup pages through every `benny:report` issue created since 5 minutes before the message was first recorded. A create can land on GitHub after its request timed out, so one miss proves nothing. The bridge forgets the message only after two misses at least 2 minutes apart, and never within 10 minutes of first recording it. A redelivery after that can report it again. A `reports.json` written before the ledger existed is read and rewritten in the new shape.

States, labels, emojis and replies live in one table in `src/states.ts`. Every bot reply starts with "🤖 ".

Phone-like numbers are removed from issue titles, bodies and comments, including numbers written with non-breaking spaces, Unicode dashes or fullwidth digits, and numbers with invisible format characters such as direction marks, isolates, a byte order mark or a soft hyphen between the digits. The sender's WhatsApp ID stays in `$BRIDGE_HOME/reports.json` and never goes to GitHub.

## Environment variables

- `GITHUB_TOKEN` is required. It needs permission to create and read issues and to write contents on the `benny-media` branch.
- `GITHUB_REPO` defaults to `chrislazar25/gospel-bot`.
- `REPORT_GROUP_JID` is required to run. Find it with `--list-groups`.
- `BRIDGE_HOME` defaults to `~/.gospel-bridge`. It holds the WhatsApp session in `auth/`, the report map and message ledger in `reports.json`, the time the bridge was last connected in `last-seen.json`, and the single-instance lock in `bridge.lock`.
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

A lock left by a process that died, or by a run before the last reboot, is replaced. The bridge moves the stale lock aside with one atomic rename and checks that the file it moved is the one it judged stale. If two bridges find the same stale lock at once, only one of them takes it. The lock is removed when the process exits.

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
