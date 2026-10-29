mock_provider "google" {}
variables {
  project_id      = "test-project"
  image           = "us-central1-docker.pkg.dev/test-project/gospel/canary@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  revision        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  target_chat_id  = "15555550123@c.us"
  green_api_url   = "https://7107.api.greenapi.com"
  green_api_id    = "1234"
  secret_versions = { database = "1", status-database = "1", migration-database = "1", green-token = "1" }
}
run "isolated_jobs_and_least_privilege" {
  command = plan
  assert {
    condition     = length(google_cloud_run_v2_job.job) == 2 && length(google_service_account.job) == 2 && length(google_secret_manager_secret_iam_member.job) == 4
    error_message = "Only two isolated jobs and four existing-secret grants are allowed."
  }
  assert {
    condition     = alltrue([for grant in google_cloud_run_v2_job_iam_member.release : grant.name == "gospel-staging-canary" && grant.member == local.release]) && google_cloud_run_v2_job_iam_member.migration.member == local.infra
    error_message = "Release must have no migration job permissions."
  }
  assert {
    condition     = google_service_account_iam_member.act_as["canary"].member == local.release && google_service_account_iam_member.act_as["migrate"].member == local.infra
    error_message = "Release must have no act-as grant on the migration owner."
  }
  assert {
    condition = alltrue([for key, job in google_cloud_run_v2_job.job : job.template[0].template[0].max_retries == 0 && job.template[0].task_count == 1 && alltrue([
      for env in job.template[0].template[0].containers[0].env : length(env.value_source) == 0 ? true : env.value_source[0].secret_key_ref[0].version == "1" && (key == "canary" ? env.value_source[0].secret_key_ref[0].secret != "gospel-staging-migration-database" : env.value_source[0].secret_key_ref[0].secret == "gospel-staging-migration-database")
    ])])
    error_message = "Canary cannot receive the owner secret; migration gets only the owner secret. Retries stay disabled."
  }
  assert {
    condition     = google_cloud_run_v2_job.job["canary"].template[0].template[0].containers[0].args == tolist(["dist/canary.js"]) && google_cloud_run_v2_job.job["migrate"].template[0].template[0].containers[0].args == tolist(["dist/runtime.js", "migrate"])
    error_message = "Keep the guarded canary and standard migration entry points."
  }
}
run "hyphenated_provider_origin" {
  command = plan
  variables { green_api_url = "https://7103.api.green-api.com" }
}
run "reject_production" {
  command = plan
  variables { environment = "production" }
  expect_failures = [var.environment]
}
run "reject_group" {
  command = plan
  variables { target_chat_id = "120363000000000000@g.us" }
  expect_failures = [var.target_chat_id]
}
run "reject_normal_image" {
  command = plan
  variables { image = "us-central1-docker.pkg.dev/test-project/gospel/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  expect_failures = [var.image]
}
run "reject_mutable_image" {
  command = plan
  variables { image = "us-central1-docker.pkg.dev/test-project/gospel/canary:latest" }
  expect_failures = [var.image]
}
run "reject_missing_pins" {
  command = plan
  variables { secret_versions = { database = "latest" } }
  expect_failures = [var.secret_versions]
}
run "reject_origin_path" {
  command = plan
  variables { green_api_url = "https://7107.api.greenapi.com/path" }
  expect_failures = [var.green_api_url]
}
run "reject_origin_port" {
  command = plan
  variables { green_api_url = "https://7107.api.greenapi.com:443" }
  expect_failures = [var.green_api_url]
}
run "reject_origin_credentials" {
  command = plan
  variables { green_api_url = "https://token@7107.api.greenapi.com" }
  expect_failures = [var.green_api_url]
}
run "reject_origin_query" {
  command = plan
  variables { green_api_url = "https://7107.api.greenapi.com?secret=x" }
  expect_failures = [var.green_api_url]
}
run "reject_origin_fragment" {
  command = plan
  variables { green_api_url = "https://7107.api.greenapi.com#fragment" }
  expect_failures = [var.green_api_url]
}
run "reject_origin_suffix" {
  command = plan
  variables { green_api_url = "https://7107.api.greenapi.com.evil.example" }
  expect_failures = [var.green_api_url]
}
run "reject_http" {
  command = plan
  variables { green_api_url = "http://7107.api.greenapi.com" }
  expect_failures = [var.green_api_url]
}
run "reject_wrong_project_image" {
  command = plan
  variables { image = "us-central1-docker.pkg.dev/other-project/gospel/canary@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  expect_failures = [var.image]
}
run "reject_wrong_region_image" {
  command = plan
  variables { image = "europe-west1-docker.pkg.dev/test-project/gospel/canary@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  expect_failures = [var.image]
}
run "reject_unreviewed_revision" {
  command = plan
  variables { revision = "unreleased" }
  expect_failures = [var.revision]
}
run "reject_non_numeric_instance" {
  command = plan
  variables { green_api_id = "instance-token" }
  expect_failures = [var.green_api_id]
}
