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
}
