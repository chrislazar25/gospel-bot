resource "google_monitoring_notification_channel" "email" {
  display_name = "${local.prefix} operator"
  type         = "email"
  labels       = { email_address = var.notification_email }
  lifecycle {
    precondition {
      condition     = var.notification_email != null
      error_message = "Monitoring notification channel requires notification_email."
    }
  }
}
resource "google_logging_metric" "event" {
  for_each = toset(["delivery_check", "delivery_problem", "content_warning"])
  name     = "${local.prefix}-${each.key}"
  filter   = "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${local.prefix}-check\" AND jsonPayload.event=\"${each.key}\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}
resource "google_monitoring_alert_policy" "problem" {
  enabled               = var.monitoring_enabled
  display_name          = "${local.prefix} delivery or content problem"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email.name]
  conditions {
    display_name = "Delivery check reports a problem"
    condition_matched_log { filter = "resource.type=\"cloud_run_job\" AND resource.labels.job_name=(\"${local.prefix}-check\" OR \"${local.prefix}-send\" OR \"${local.prefix}-reconcile\") AND (jsonPayload.event=\"delivery_problem\" OR jsonPayload.event=\"content_warning\")" }
  }
  alert_strategy {
    notification_rate_limit { period = "3600s" }
    auto_close = "86400s"
  }
}
resource "google_monitoring_alert_policy" "missing_check" {
  enabled               = var.monitoring_enabled
  display_name          = "${local.prefix} delivery evidence missing"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email.name]
  conditions {
    display_name = "No delivery_check in 2 hours"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.event["delivery_check"].name}\" AND resource.type=\"cloud_run_job\""
      duration = "7200s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }
}
resource "google_monitoring_dashboard" "delivery" {
  dashboard_json = jsonencode({
    displayName = "${local.prefix} delivery"
    gridLayout = { columns = 2, widgets = concat([{
      title = "Delivery state and remaining content. Open the latest delivery_check payload."
      logsPanel = {
        filter        = google_logging_metric.event["delivery_check"].filter
        resourceNames = ["projects/${var.project_id}"]
      }
      }], [for event in ["delivery_check", "delivery_problem", "content_warning"] : {
      title = replace(event, "_", " ")
      xyChart = {
        dataSets = [{ timeSeriesQuery = { timeSeriesFilter = {
          filter      = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.event[event].name}\" AND resource.type=\"cloud_run_job\""
          aggregation = { alignmentPeriod = "86400s", perSeriesAligner = "ALIGN_SUM", crossSeriesReducer = "REDUCE_SUM" }
        } }, plotType = "STACKED_BAR" }]
      }
    }]) }
  })
}
