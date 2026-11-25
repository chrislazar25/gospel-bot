# Run production

Use this guide when an alert email arrives, when you want to see today's delivery, or when you release new content or code. Commands assume `gcloud` is signed in as an operator.

```sh
export GCP_PROJECT_ID=gospel-bot-493719
export REGION=us-central1
```

## Check today's delivery

The fastest check is the WhatsApp group itself. For the recorded state, read the status service. It requires your Google identity and rejects anonymous requests.

```sh
URL=$(gcloud run services describe gospel-production-status --region "$REGION" --project "$GCP_PROJECT_ID" --format='value(status.url)')
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/status"
```

An empty `deliveries` list means no send has started for today's IST date. Each status has one meaning.

| Status | Meaning |
| --- | --- |
| `pending` | The day exists and no message has left. A later send can claim it. |
| `unknown` | An attempt started and its result is not known. The system never retries it, because a retry could post the message twice. |
| `accepted` | Green API accepted the message. Delivery is not confirmed yet. |
| `confirmed` | WhatsApp reported the message as delivered or read. |
| `failed` | WhatsApp reported a failure. The system never retries it. |

To read the job logs, run this command.

```sh
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name=~"^gospel-production-" AND jsonPayload.event:*' \
  --project "$GCP_PROJECT_ID" --freshness 3h --limit 30 --format='value(timestamp,resource.labels.job_name,jsonPayload)'
```

## Respond to an alert email

Alerts come from `alerting-noreply@google.com`. First, look in the WhatsApp group. If the message is there, the alert is about tracking, and the group needs no action.

### Delivery or content problem

Read the status, and then follow the row that matches.

| You see | Do this |
| --- | --- |
| No row or `pending`, and the time is before 01:30 IST | Fix the cause, then run the send job. The steps are below. |
| No row or `pending`, and the time is after 01:30 IST | Post the message by hand. The job refuses to send outside the window. |
| `unknown` | Read the Green API queue and history, as described below. Green API can still hold the message and deliver it later. If it has neither, post the message by hand. |
| `failed` | Read the Green API history. If the message did not reach the group, post it by hand. |
| `accepted`, and the message is in the group | Take no action. Green API has not reported delivery yet. Reconcile runs can confirm it until 01:50 IST. After that, the alert can repeat hourly until the next IST day. |
| `accepted`, and the message is not in the group | Read the Green API queue. The phone may be offline or WhatsApp may be logged out. Fix that, and the queued message sends without a new attempt. Do not post by hand while the message is queued. |
| A `content_warning` log | Merge the open content batch and release it. Fewer than seven approved days remain. |

The next IST day starts a new row, so a bad day does not block the next one. The message for today is in `content/messages/YYYY-MM-DD.txt`.

If you post by hand, a message that Green API still holds can also arrive, and the group sees it twice. For a family group, one duplicate costs less than a missed day, but read the queue first.

To read the queue and the recent history, run these commands. They change nothing. An empty queue is `[]`.

```sh
GREEN_URL=$(gh variable get GREEN_API_URL --env production)
GREEN_ID=$(gh variable get GREEN_API_ID --env production)
GREEN_TOKEN=$(gcloud secrets versions access 1 --secret gospel-production-green-token --project "$GCP_PROJECT_ID")
curl -s "$GREEN_URL/waInstance$GREEN_ID/showMessagesQueue/$GREEN_TOKEN"
curl -s "$GREEN_URL/waInstance$GREEN_ID/lastOutgoingMessages/$GREEN_TOKEN" | jq '.[0:3] | map({timestamp, statusMessage, idMessage})'
```

To run the send job by hand, use this command. It is safe to repeat, because the daily row allows one attempt.

```sh
gcloud run jobs execute gospel-production-send --region "$REGION" --project "$GCP_PROJECT_ID" --wait
```

If the job logs `sending_held` with the reason `provider_not_ready`, the WhatsApp session is logged out or Green API is down. Open the [Green API console](https://console.green-api.com), scan the QR code if it asks, and run the job again.

### Delivery evidence missing

The hourly check has not reported for two hours. Delivery can still work. Open **Cloud Run jobs** and **Cloud Scheduler** in the console, and read the last `gospel-production-check` execution. A failed execution usually means the database is unavailable. Neon suspends a Free plan project when it uses up its monthly compute, so check the project in the [Neon console](https://console.neon.tech).

## Publish new content or code

A release refuses to run while schedules are active, and it deploys with sending off. Do these steps outside 00:30 to 01:30 IST, which is 14:00 to 15:00 in US Central daylight time and 13:00 to 14:00 in standard time.

1. Merge the content or code PR.
2. Delete the `FIRST_SEND_DATE` variable from the `production` environment.

   ```sh
   gh variable delete FIRST_SEND_DATE --env production
   ```

3. Run **Infrastructure** on `master` for `production` with operation `apply`. Every schedule pauses.
4. Run **Release** on `master` for `staging`. Record the run ID.
5. Run **Release** on `master` for `production` with that run ID as `staging_run_id`.
6. Set `FIRST_SEND_DATE` again with its earlier value. Days that already have a row do not send again.

   ```sh
   gh variable set FIRST_SEND_DATE --env production --body 2026-10-31
   ```

7. Run **Infrastructure** on `master` for `production` with operation `apply`. Schedules resume and sending turns on.
8. Confirm that all three production schedules show `ENABLED`.

   ```sh
   gcloud scheduler jobs list --location "$REGION" --project "$GCP_PROJECT_ID"
   ```

While the variable is deleted, nothing sends. The check job also pauses, so the missing-evidence alert emails you after two hours. A normal release finishes before that. Do not leave production in that state across 00:30 IST.

## Switch delivery off

To stop sending, follow steps 2 and 3 of the release procedure. Queued provider messages and requests already in flight cannot be recalled.

For a shutdown longer than two hours, set the `MONITORING_ENABLED` variable to `false` before step 3, so that the missing-evidence alert stays quiet. Set it back to `true` in the apply that turns delivery on.
