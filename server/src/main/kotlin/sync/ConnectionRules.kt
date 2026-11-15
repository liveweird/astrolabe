package ch.nokillswit.sync

import io.ktor.server.plugins.BadRequestException

/**
 * What both connection registries (`jira/JiraConnection.kt`, `flow/FlowConnection.kt`) share of their request rules: the polling bound
 * and the presence of the write-only credential. Each connector keeps its own default interval and its own token shape.
 */
const val MIN_POLL_INTERVAL_MINUTES = 5
const val MAX_POLL_INTERVAL_MINUTES = 1440

/** An interval is null (manual only, Refresh now) or within [MIN_POLL_INTERVAL_MINUTES]..[MAX_POLL_INTERVAL_MINUTES]; else a `400`. */
fun requirePollInterval(minutes: Int?) {
    if (minutes != null && minutes !in MIN_POLL_INTERVAL_MINUTES..MAX_POLL_INTERVAL_MINUTES) {
        throw BadRequestException(
            "Polling interval must be between $MIN_POLL_INTERVAL_MINUTES and $MAX_POLL_INTERVAL_MINUTES minutes, or null for manual only",
        )
    }
}

/**
 * The write-only credential [field] is required on create ([required]); an update may omit it to keep the stored one. The field is
 * NAMED by the caller: `sync/` never names the credential column (`CredentialPathTest`, security.md "Encryption at rest"). The message
 * never quotes the value.
 */
fun requireSecret(value: String?, required: Boolean, field: String) {
    if (required && value.isNullOrBlank()) throw BadRequestException("$field is required")
}
