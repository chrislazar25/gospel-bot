mock_provider "google" {}

variables {
  project_id  = "gospel-bot-493719"
  environment = "staging"
}

run "secrets_without_app_configuration" {
  command = plan
  plan_options {
    target = [google_secret_manager_secret.secret, google_secret_manager_secret_iam_member.neon_write, google_secret_manager_secret_iam_member.neon_read]
  }
  assert {
    condition     = length(google_secret_manager_secret.secret) == 4 && length(google_secret_manager_secret_iam_member.neon_write) == 3 && length(google_secret_manager_secret_iam_member.neon_read) == 3
    error_message = "Bootstrap requires exactly four empty containers and six scoped Neon IAM grants."
  }
  assert {
    condition     = !contains(keys(google_secret_manager_secret_iam_member.neon_write), "green-token") && !contains(keys(google_secret_manager_secret_iam_member.neon_read), "green-token")
    error_message = "Neon must have no access to the provider token."
  }
}

run "full_plan_requires_app_configuration" {
  command = plan
  expect_failures = [
    google_cloud_run_v2_job.job,
    google_cloud_run_v2_service.status,
    google_monitoring_notification_channel.email,
  ]
}

run "configured_application" {
  command = plan
  variables {
    image              = "us-central1-docker.pkg.dev/test-project/gospel/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    green_api_url      = "https://instance.api.green-api.com"
    green_api_id       = "synthetic-instance"
    target_chat_id     = "synthetic-chat"
    notification_email = "operator@example.invalid"
    secret_versions    = { database = "2", migration-database = "3", status-database = "4", green-token = "5" }
    status_invokers    = ["user:operator@example.invalid"]
  }
  assert {
    condition     = length(google_cloud_run_v2_job.job) == 4 && google_cloud_run_v2_job.job["send"].template[0].template[0].containers[0].image == var.image
    error_message = "Keep all four application job addresses and the selected digest."
  }
  assert {
    condition = alltrue([for key, job in google_cloud_run_v2_job.job : alltrue([
      for env in job.template[0].template[0].containers[0].env :
      env.name != "DATABASE_URL" ? true : env.value_source[0].secret_key_ref[0].version == var.secret_versions[key == "check" ? "status-database" : key == "migrate" ? "migration-database" : "database"]
    ])])
    error_message = "Jobs must retain their numeric database secret pins."
  }
  assert {
    condition = alltrue([for env in google_cloud_run_v2_service.status.template[0].containers[0].env :
      env.name != "DATABASE_URL" ? true : env.value_source[0].secret_key_ref[0].version == "4"
    ])
    error_message = "Status must retain its numeric secret pin."
  }
  assert {
    condition     = alltrue([for job in google_cloud_scheduler_job.job : job.paused]) && alltrue([for env in google_cloud_run_v2_job.job["send"].template[0].template[0].containers[0].env : env.name != "FIRST_SEND_DATE" && (env.name != "SENDING_ENABLED" || env.value == "false")])
    error_message = "Without a first send date, sending stays disabled and every schedule stays paused."
  }
}

run "activated_application" {
  command = plan
  variables {
    image              = "us-central1-docker.pkg.dev/test-project/gospel/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    green_api_url      = "https://instance.api.green-api.com"
    green_api_id       = "synthetic-instance"
    target_chat_id     = "synthetic-chat"
    notification_email = "operator@example.invalid"
    secret_versions    = { database = "2", migration-database = "3", status-database = "4", green-token = "5" }
    status_invokers    = ["user:operator@example.invalid"]
    first_send_date    = "2026-10-31"
  }
  assert {
    condition     = alltrue([for job in google_cloud_scheduler_job.job : !job.paused]) && google_cloud_scheduler_job.job["send"].schedule == "30,45 0 * * *"
    error_message = "A first send date unpauses every schedule and sends at 00:30 IST with one retry at 00:45 IST."
  }
  assert {
    condition     = google_cloud_scheduler_job.job["reconcile"].schedule == "*/10 0-1 * * *" && google_cloud_scheduler_job.job["check"].schedule == "5 * * * *"
    error_message = "Receipts are polled for two hours after the send, and the check runs hourly so the database can suspend."
  }
  assert {
    condition = alltrue([for job in google_cloud_run_v2_job.job : length([
      for env in job.template[0].template[0].containers[0].env : env
      if(env.name == "SENDING_ENABLED" && env.value == "true") || (env.name == "FIRST_SEND_DATE" && env.value == "2026-10-31")
    ]) == 2])
    error_message = "Every job enables sending from the first send date."
  }
}

run "malformed_first_send_date_is_rejected" {
  command = plan
  variables {
    image              = "us-central1-docker.pkg.dev/test-project/gospel/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    green_api_url      = "https://instance.api.green-api.com"
    green_api_id       = "synthetic-instance"
    target_chat_id     = "synthetic-chat"
    notification_email = "operator@example.invalid"
    secret_versions    = { database = "2", migration-database = "3", status-database = "4", green-token = "5" }
    status_invokers    = ["user:operator@example.invalid"]
    first_send_date    = "31-10-2026"
  }
  expect_failures = [var.first_send_date]
}

run "impossible_first_send_date_is_rejected" {
  command = plan
  variables {
    image              = "us-central1-docker.pkg.dev/test-project/gospel/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    green_api_url      = "https://instance.api.green-api.com"
    green_api_id       = "synthetic-instance"
    target_chat_id     = "synthetic-chat"
    notification_email = "operator@example.invalid"
    secret_versions    = { database = "2", migration-database = "3", status-database = "4", green-token = "5" }
    status_invokers    = ["user:operator@example.invalid"]
    first_send_date    = "2026-02-31"
  }
  expect_failures = [var.first_send_date]
}

run "malformed_application_is_rejected" {
  command = plan
  variables {
    green_api_id       = "synthetic-instance"
    target_chat_id     = "synthetic-chat"
    notification_email = "operator@example.invalid"
    image              = "runtime:latest"
    green_api_url      = "http://untrusted.invalid"
    secret_versions    = { database = "latest" }
    status_invokers    = ["allUsers"]
  }
  expect_failures = [var.image, var.green_api_url, var.secret_versions, var.status_invokers]
}
