terraform {
  required_version = ">= 1.9, < 2"
  backend "gcs" {}
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}
variable "project_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use the staging GCP project ID."
  }
}
variable "region" {
  default = "us-central1"
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "Use a GCP region."
  }
}
variable "environment" {
  type    = string
  default = "staging"
  validation {
    condition     = var.environment == "staging"
    error_message = "Canary infrastructure is staging only."
  }
}
variable "image" {
  type = string
  validation {
    condition     = can(regex("^${var.region}-docker\\.pkg\\.dev/${var.project_id}/gospel/canary@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Pin a canary digest in this project's gospel repository."
  }
}
variable "revision" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.revision))
    error_message = "Pin the reviewed image source SHA."
  }
}
variable "target_chat_id" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[0-9]{7,15}@c\\.us$", var.target_chat_id))
    error_message = "Use the authorized private test chat. Groups are forbidden."
  }
}
variable "attempt" {
  type = number
  validation {
    condition     = var.attempt == floor(var.attempt) && var.attempt >= 1 && var.attempt <= 365
    error_message = "Use a whole canary attempt number from 1 to 365. Raise it only to send a new reviewed attempt."
  }
}
variable "green_api_url" {
  type = string
  validation {
    condition     = can(regex("^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)?api\\.green-?api\\.com/?$", var.green_api_url))
    error_message = "Use the assigned HTTPS Green API origin."
  }
}
variable "green_api_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]+$", var.green_api_id))
    error_message = "Use the numeric Green API instance ID."
  }
}
variable "secret_versions" {
  type = map(string)
  validation {
    condition     = length(var.secret_versions) == 4 && alltrue([for key in ["database", "status-database", "migration-database", "green-token"] : can(regex("^[1-9][0-9]*$", var.secret_versions[key]))])
    error_message = "Pin all four existing staging secret versions numerically."
  }
}
provider "google" {
  project = var.project_id
  region  = var.region
}
locals {
  name    = "gospel-staging-canary"
  release = "serviceAccount:gospel-release-staging@${var.project_id}.iam.gserviceaccount.com"
  infra   = "serviceAccount:gospel-infra-staging@${var.project_id}.iam.gserviceaccount.com"
  jobs    = toset(["canary", "migrate"])
  access = {
    runtime = { who = "canary", secret = "database" }
    status  = { who = "canary", secret = "status-database" }
    green   = { who = "canary", secret = "green-token" }
    owner   = { who = "migrate", secret = "migration-database" }
  }
  env = {
    APP_ENV                  = "staging"
    CANARY_CONFIRMATION      = "send-one-marked-private-staging-test"
    CANARY_TARGET_CHAT_ID    = var.target_chat_id
    CANARY_ATTEMPT           = tostring(var.attempt)
    CANARY_EXPECTED_REVISION = var.revision
    GREEN_API_URL            = var.green_api_url
    GREEN_API_ID             = var.green_api_id
  }
  secrets = {
    DATABASE_URL        = "database"
    STATUS_DATABASE_URL = "status-database"
    GREEN_API_TOKEN     = "green-token"
  }
}
resource "google_service_account" "job" {
  for_each   = local.jobs
  account_id = each.key == "canary" ? local.name : "${local.name}-migrate"
}
resource "google_service_account_iam_member" "act_as" {
  for_each           = local.jobs
  service_account_id = google_service_account.job[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = each.key == "canary" ? local.release : local.infra
}
resource "google_secret_manager_secret_iam_member" "job" {
  for_each  = local.access
  secret_id = "gospel-staging-${each.value.secret}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job[each.value.who].email}"
}
resource "google_cloud_run_v2_job" "job" {
  for_each            = local.jobs
  name                = each.key == "canary" ? local.name : "${local.name}-migrate"
  location            = var.region
  deletion_protection = false
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.job[each.key].email
      max_retries     = 0
      timeout         = "300s"
      containers {
        image   = var.image
        command = ["node"]
        args    = each.key == "canary" ? ["dist/canary.js"] : ["dist/runtime.js", "migrate"]
        resources {
          limits = { cpu = "1", memory = "512Mi" }
        }
        dynamic "env" {
          for_each = each.key == "canary" ? local.env : { APP_ENV = "staging" }
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = each.key == "canary" ? local.secrets : { DATABASE_URL = "migration-database" }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = "gospel-staging-${env.value}"
                version = var.secret_versions[env.value]
              }
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.job]
}
resource "google_cloud_run_v2_job_iam_member" "release" {
  for_each = toset(["roles/run.developer", "roles/run.invoker"])
  name     = google_cloud_run_v2_job.job["canary"].name
  location = var.region
  role     = each.value
  member   = local.release
}
resource "google_cloud_run_v2_job_iam_member" "migration" {
  name     = google_cloud_run_v2_job.job["migrate"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = local.infra
}
output "job_name" { value = google_cloud_run_v2_job.job["canary"].name }
output "migration_job_name" { value = google_cloud_run_v2_job.job["migrate"].name }
