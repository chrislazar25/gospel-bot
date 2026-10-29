terraform {
  required_version = ">= 1.9, < 2"
  backend "gcs" {}
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}
variable "project_id" { type = string }
variable "region" { default = "us-central1" }
variable "image" {
  type = string
  validation {
    condition     = can(regex("^${var.region}-docker\\.pkg\\.dev/${var.project_id}/gospel/cloud-smoke@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Use a pinned cloud-smoke digest from this project's gospel repository."
  }
}
provider "google" {
  project = var.project_id
  region  = var.region
}
locals {
  name    = "gospel-staging-cloud-smoke"
  release = "serviceAccount:gospel-release-staging@${var.project_id}.iam.gserviceaccount.com"
}
resource "google_service_account" "smoke" {
  account_id = local.name
}
resource "google_service_account_iam_member" "release" {
  service_account_id = google_service_account.smoke.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.release
}
resource "google_cloud_run_v2_job" "smoke" {
  name                = local.name
  location            = var.region
  deletion_protection = false
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.smoke.email
      max_retries     = 0
      timeout         = "300s"
      containers {
        image = var.image
        resources {
          limits = { cpu = "2", memory = "2Gi" }
        }
        env {
          name  = "APP_ENV"
          value = "staging"
        }
      }
    }
  }
  lifecycle { ignore_changes = [template[0].template[0].containers[0].image] }
}
resource "google_cloud_run_v2_job_iam_member" "release" {
  for_each = toset(["roles/run.developer", "roles/run.invoker"])
  name     = google_cloud_run_v2_job.smoke.name
  location = var.region
  role     = each.value
  member   = local.release
}
output "job_name" { value = google_cloud_run_v2_job.smoke.name }
