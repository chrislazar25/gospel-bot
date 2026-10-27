terraform {
  required_version = ">= 1.6, < 2"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}
variable "project_id" { type = string }
variable "region" { default = "us-central1" }
variable "github_repository" { default = "chrislazar25/gospel-bot" }
variable "github_repository_id" { type = string }
variable "github_owner_id" { type = string }
provider "google" { project = var.project_id }
resource "google_project_service" "api" {
  for_each           = toset(["iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", "artifactregistry.googleapis.com", "run.googleapis.com", "cloudscheduler.googleapis.com", "secretmanager.googleapis.com", "monitoring.googleapis.com", "logging.googleapis.com", "storage.googleapis.com", "cloudresourcemanager.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}
resource "google_storage_bucket" "state" {
  name                        = "${var.project_id}-gospel-tfstate"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.api]
}
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "gospel"
  format        = "DOCKER"
  docker_config { immutable_tags = true }
  depends_on = [google_project_service.api]
}
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "gospel-github"
  depends_on                = [google_project_service.api]
}
resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"       = "assertion.sub + ':' + assertion.workflow_ref.extract('.github/workflows/{file}@')"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.repository_id == '${var.github_repository_id}' && assertion.repository_owner_id == '${var.github_owner_id}' && assertion.ref == 'refs/heads/master' && assertion.ref_protected == 'true'"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}
locals {
  identities  = toset(["infra-staging", "infra-production", "release-staging", "release-production", "neon-staging", "neon-production"])
  infra_roles = toset(["roles/run.admin", "roles/iam.serviceAccountAdmin", "roles/iam.serviceAccountUser", "roles/secretmanager.admin", "roles/cloudscheduler.admin", "roles/monitoring.admin", "roles/logging.configWriter", "roles/resourcemanager.projectIamAdmin", "roles/serviceusage.serviceUsageConsumer"])
}
resource "google_service_account" "workflow" {
  for_each   = local.identities
  account_id = "gospel-${each.key}"
  depends_on = [google_project_service.api]
}
resource "google_service_account_iam_member" "github" {
  for_each           = local.identities
  service_account_id = google_service_account.workflow[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/repo:${var.github_repository}:environment:${endswith(each.key, "production") ? "production" : "staging"}:${startswith(each.key, "infra") ? "infrastructure" : startswith(each.key, "neon") ? "neon" : "release"}.yml"
}
resource "google_storage_bucket_iam_member" "state" {
  for_each = toset(["staging", "production"])
  bucket   = google_storage_bucket.state.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.workflow["infra-${each.key}"].email}"
  condition {
    title      = "environment_state"
    expression = "resource.name == 'projects/_/buckets/${google_storage_bucket.state.name}' || resource.name.startsWith('projects/_/buckets/${google_storage_bucket.state.name}/objects/${each.key}/')"
  }
}
resource "google_project_iam_member" "infra" {
  for_each = { for pair in setproduct(["staging", "production"], local.infra_roles) : "${pair[0]}-${pair[1]}" => pair }
  project  = var.project_id
  role     = each.value[1]
  member   = "serviceAccount:${google_service_account.workflow["infra-${each.value[0]}"].email}"
}
resource "google_artifact_registry_repository_iam_member" "release" {
  for_each   = toset(["staging", "production"])
  location   = var.region
  repository = google_artifact_registry_repository.images.name
  role       = each.key == "staging" ? "roles/artifactregistry.writer" : "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.workflow["release-${each.key}"].email}"
}
output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "state_bucket" { value = google_storage_bucket.state.name }

resource "google_project_iam_member" "release_scheduler_viewer" {
  for_each = toset(["staging", "production"])
  project  = var.project_id
  role     = "roles/cloudscheduler.viewer"
  member   = "serviceAccount:${google_service_account.workflow["release-${each.key}"].email}"
}
resource "google_artifact_registry_repository_iam_member" "infra" {
  for_each   = toset(["staging", "production"])
  location   = var.region
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.workflow["infra-${each.key}"].email}"
}
