# Production

Every command here only reads. Use `gcloud` signed in as an operator. Set `P=gospel-bot-493719` and `R=us-central1`.

## Sub-features

- Read today's delivery state from the status service.
- Read job logs for a send, a receipt, or a problem.
- Confirm schedules, the running image, and alert policies.

## Driving it

Read the delivery state. Anonymous requests must return 403, and your identity must return 200.

```sh
URL=$(gcloud run services describe gospel-production-status --region $R --project $P --format='value(status.url)')
curl -s -o /dev/null -w '%{http_code}\n' "$URL/status"
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/status"
```

Read the structured logs.

```sh
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name=~"^gospel-production-" AND jsonPayload.event:*' \
  --project $P --freshness 3h --limit 30 --format='value(timestamp,resource.labels.job_name,jsonPayload)'
```

A good send shows `delivery_attempt` with status `accepted`, and a later `reconciliation_complete` with `confirmed` at 1. `check` then logs `delivery_check` with status `confirmed`.

Confirm the schedules and the running image. The image digest must be the same for every production job.

```sh
gcloud scheduler jobs list --location $R --project $P
for job in send reconcile check migrate; do gcloud run jobs describe gospel-production-$job --region $R --project $P --format='value(spec.template.spec.template.spec.containers[0].image)'; done
```

Read the alert policies through the Monitoring API, because `gcloud monitoring` needs the alpha component.

```sh
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" "https://monitoring.googleapis.com/v3/projects/$P/alertPolicies" | jq -r '.alertPolicies[] | "\(.displayName) \(.enabled)"'
```

## Gotchas

Do not run `gcloud run jobs execute` to verify. A run of `gospel-production-send` inside the window sends to the family group. `docs/operations.md` covers the cases where a person runs it on purpose.

Do not connect to the database to verify. The status service and the logs answer the same questions, and a connection wakes Neon, which uses compute.

The first `delivery_problem` email is the only proof that alert delivery works. An enabled policy does not prove it.
