terraform {
  required_version = ">= 1.6, < 2"
  backend "gcs" {}
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}
variable "project_id" { type = string }
variable "region" { default = "us-central1" }
variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Use staging or production."
  }
}
variable "image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Use an immutable Artifact Registry image digest."
  }
}
variable "green_api_url" {
  type = string
  validation {
    condition     = can(regex("^https://[a-zA-Z0-9-]+\\.api\\.green-api\\.com$", var.green_api_url))
    error_message = "Use the instance assigned HTTPS api.green-api.com host."
  }
}
variable "green_api_id" { type = string }
variable "target_chat_id" { type = string }
variable "notification_email" { type = string }
variable "monitoring_enabled" {
  type    = bool
  default = false
}
variable "secret_versions" {
  type = map(string)
  validation {
    condition     = length(var.secret_versions) == 4 && alltrue([for name in ["database", "migration-database", "status-database", "green-token"] : can(regex("^[1-9][0-9]*$", var.secret_versions[name]))])
    error_message = "Pin numeric versions for database, migration-database, status-database, and green-token."
  }
}
variable "status_invokers" {
  type = set(string)
  validation {
    condition     = alltrue([for member in var.status_invokers : can(regex("^(user|group|serviceAccount):.+$", member))])
    error_message = "Status invokers must be named users, groups, or service accounts. Public access is forbidden."
  }
}
provider "google" {
  project = var.project_id
  region  = var.region
}
locals {
  prefix = "gospel-${var.environment}"
  jobs = {
    send      = { database = "database", green = true, cron = "0 7 * * *" }
    reconcile = { database = "database", green = true, cron = "*/10 * * * *" }
    check     = { database = "status-database", green = false, cron = "*/10 * * * *" }
    migrate   = { database = "migration-database", green = false, cron = "" }
  }
  secrets    = toset(["database", "migration-database", "status-database", "green-token"])
  common_env = { APP_ENV = var.environment, CONTENT_DIR = "/app/content", SENDING_ENABLED = "false", SEND_WINDOW_START_MINUTE = "420", SEND_WINDOW_END_MINUTE = "480", DELIVERY_DEADLINE_MINUTE = "450" }
  green_env  = { GREEN_API_URL = var.green_api_url, GREEN_API_ID = var.green_api_id, TARGET_CHAT_ID = var.target_chat_id }
  release    = "serviceAccount:gospel-release-${var.environment}@${var.project_id}.iam.gserviceaccount.com"
  neon       = "serviceAccount:gospel-neon-${var.environment}@${var.project_id}.iam.gserviceaccount.com"
}
resource "google_secret_manager_secret" "secret" {
  for_each  = local.secrets
  secret_id = "${local.prefix}-${each.key}"
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
}
resource "google_secret_manager_secret_iam_member" "neon_write" {
  for_each  = setsubtract(local.secrets, ["green-token"])
  secret_id = google_secret_manager_secret.secret[each.key].id
  role      = "roles/secretmanager.secretVersionManager"
  member    = local.neon
}
resource "google_secret_manager_secret_iam_member" "neon_read" {
  for_each  = setsubtract(local.secrets, ["green-token"])
  secret_id = google_secret_manager_secret.secret[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.neon
}
resource "google_service_account" "runtime" {
  for_each   = toset(concat(keys(local.jobs), ["status", "scheduler"]))
  account_id = "${local.prefix}-${each.key}"
}
resource "google_service_account_iam_member" "release" {
  for_each           = { for k, v in google_service_account.runtime : k => v if k != "scheduler" }
  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.release
}
locals {
  access = merge({ for name, job in local.jobs : "${name}-db" => { who = name, secret = job.database }
    }, { status = { who = "status", secret = "status-database" }
    }, { for name in ["send", "reconcile"] : "${name}-green" => { who = name, secret = "green-token" }
  })
}
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.access
  secret_id = google_secret_manager_secret.secret[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.who].email}"
}
resource "google_cloud_run_v2_job" "job" {
  for_each            = local.jobs
  name                = "${local.prefix}-${each.key}"
  location            = var.region
  deletion_protection = var.environment == "production"
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.runtime[each.key].email
      max_retries     = 0
      timeout         = "300s"
      containers {
        image   = var.image
        command = ["node"]
        args    = ["dist/runtime.js", each.key]
        resources {
          limits = { cpu = "1", memory = "512Mi" }
        }
        dynamic "env" {
          for_each = merge(local.common_env, each.value.green ? local.green_env : {})
          content {
            name  = env.key
            value = env.value
          }
        }
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secret[each.value.database].secret_id
              version = var.secret_versions[each.value.database]
            }
          }
        }
        dynamic "env" {
          for_each = each.value.green ? [1] : []
          content {
            name = "GREEN_API_TOKEN"
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.secret["green-token"].secret_id
                version = var.secret_versions["green-token"]
              }
            }
          }
        }
      }
    }
  }
  lifecycle { ignore_changes = [template[0].template[0].containers[0].image] }
  depends_on = [google_secret_manager_secret_iam_member.runtime]
}
resource "google_cloud_run_v2_job_iam_member" "release" {
  for_each = local.jobs
  name     = google_cloud_run_v2_job.job[each.key].name
  location = var.region
  role     = "roles/run.developer"
  member   = local.release
}
resource "google_cloud_run_v2_job_iam_member" "execute" {
  for_each = local.jobs
  name     = google_cloud_run_v2_job.job[each.key].name
  location = var.region
  role     = "roles/run.invoker"
  member   = local.release
}
resource "google_cloud_run_v2_service" "status" {
  name                = "${local.prefix}-status"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.environment == "production"
  template {
    service_account = google_service_account.runtime["status"].email
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers {
      image   = var.image
      command = ["node"]
      args    = ["dist/runtime.js", "service"]
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["status-database"].secret_id
            version = var.secret_versions["status-database"]
          }
        }
      }
    }
  }
  lifecycle { ignore_changes = [template[0].containers[0].image] }
  depends_on = [google_secret_manager_secret_iam_member.runtime]
}
resource "google_cloud_run_v2_service_iam_member" "viewer" {
  for_each = setunion(var.status_invokers, [local.release])
  name     = google_cloud_run_v2_service.status.name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.value
}
resource "google_cloud_run_v2_service_iam_member" "release" {
  name     = google_cloud_run_v2_service.status.name
  location = var.region
  role     = "roles/run.developer"
  member   = local.release
}
resource "google_cloud_run_v2_job_iam_member" "scheduler" {
  for_each = { for k, v in local.jobs : k => v if v.cron != "" }
  name     = google_cloud_run_v2_job.job[each.key].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.runtime["scheduler"].email}"
}
resource "google_cloud_scheduler_job" "job" {
  for_each         = { for k, v in local.jobs : k => v if v.cron != "" }
  name             = "${local.prefix}-${each.key}"
  region           = var.region
  schedule         = each.value.cron
  time_zone        = "Asia/Kolkata"
  paused           = true
  attempt_deadline = "60s"
  retry_config { retry_count = 0 }
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.job[each.key].name}:run"
    body        = base64encode("{}")
    headers     = { "Content-Type" = "application/json" }
    oauth_token { service_account_email = google_service_account.runtime["scheduler"].email }
  }
}
output "status_url" { value = google_cloud_run_v2_service.status.uri }
