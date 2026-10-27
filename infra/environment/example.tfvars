project_id         = "your-gcp-project"
environment        = "staging"
region             = "us-central1"
image              = "us-central1-docker.pkg.dev/your-gcp-project/gospel/runtime@sha256:REPLACE_WITH_BUILT_DIGEST"
green_api_url      = "https://REPLACE.api.green-api.com"
green_api_id       = "REPLACE"
target_chat_id     = "REPLACE@g.us"
notification_email = "REPLACE@example.com"
status_invokers    = ["user:REPLACE@example.com"]

secret_versions = { database = "1", migration-database = "1", status-database = "1", green-token = "1" }

monitoring_enabled = false
