package ch.nokillswit.jira

import ch.nokillswit.infra.maskedSecret
import ch.nokillswit.infra.outbound.ATLASSIAN_RESERVED_SITE_LABELS
import ch.nokillswit.infra.outbound.JIRA_SITE_URL_PATTERN
import ch.nokillswit.infra.paging.PageResponse
import ch.nokillswit.infra.validation.canonicalEmail
import ch.nokillswit.infra.validation.requireNameAndDescription
import ch.nokillswit.infra.validation.sanitizeSingleLine
import ch.nokillswit.sync.SyncLastRun
import ch.nokillswit.sync.SyncStatus
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/**
 * Jira connections (V21): an ADMIN-managed registry of Jira Cloud sites the sync OBSERVES (nothing is ever written to Jira). The `teams/`
 * shape - one request/response pair for create and update, a soft-deleted row, a name unique among the active ones - plus the first
 * credential the application stores: [JiraConnectionRequest.apiToken] is accepted on create/update, encrypted at rest
 * (`JiraConnectionService`) and NEVER returned or logged; the response carries [JiraConnectionResponse.hasApiToken] instead.
 */
const val MAX_JIRA_CONNECTION_NAME_LENGTH = 100
const val MAX_SITE_URL_LENGTH = 253
const val MAX_JIRA_EMAIL_LENGTH = 254
const val MAX_API_TOKEN_LENGTH = 1000
const val MIN_PROJECT_KEYS = 1
const val MAX_PROJECT_KEYS = 50
const val MIN_POLL_INTERVAL_MINUTES = 5
const val MAX_POLL_INTERVAL_MINUTES = 1440
const val DEFAULT_POLL_INTERVAL_MINUTES = 15

/** How much of a rejected project key a 400 quotes back (a pasted blob must not be echoed whole). */
private const val MAX_KEY_ECHO = 20

/** The Jira Cloud project-key shape: one uppercase letter, then 1-9 uppercase letters/digits/underscores. */
val PROJECT_KEY_PATTERN: Regex = Regex("^[A-Z][A-Z0-9_]{1,9}$")

/** How the token authenticates: `BASIC` = `base64(email:token)` (an Atlassian API token), `BEARER` = the token alone. */
enum class JiraAuthScheme { BASIC, BEARER }

@Serializable
data class JiraConnectionRequest(
    val name: String,
    /** The site's ORIGIN, exactly `https://<tenant>.atlassian.net` (the outbound allow-list boundary, `AtlassianSites.kt`). */
    val siteUrl: String,
    val email: String,
    /** Required on create; omitted or blank on update keeps the stored token, present rotates it. Write-only. */
    val apiToken: String? = null,
    val authScheme: JiraAuthScheme = JiraAuthScheme.BASIC,
    val projectKeys: List<String>,
    val enabled: Boolean = true,
    /** Minutes between scheduled runs (V22): omitted = [DEFAULT_POLL_INTERVAL_MINUTES], an explicit null = manual only (Refresh now). */
    val pollIntervalMinutes: Int? = DEFAULT_POLL_INTERVAL_MINUTES,
) {
    /** A default data-class `toString()` would print the token in plain text into any log line. */
    override fun toString(): String =
        "JiraConnectionRequest(name=$name, siteUrl=$siteUrl, email=$email, apiToken=${maskedSecret(apiToken)}, " +
            "authScheme=$authScheme, projectKeys=$projectKeys, enabled=$enabled, pollIntervalMinutes=$pollIntervalMinutes)"
}

@Serializable
data class JiraConnectionResponse(
    val id: UInt,
    val name: String,
    val siteUrl: String,
    val email: String,
    /** The token is write-only - never returned in any response or audit line; this says whether one is stored. */
    val hasApiToken: Boolean,
    val authScheme: JiraAuthScheme,
    val projectKeys: List<String>,
    val enabled: Boolean,
    /** Minutes between scheduled runs; null = manual only. */
    val pollIntervalMinutes: Int?,
    /** The site's cloud id, persisted by a passing Test connection; null until then. */
    val cloudId: String?,
    /** Epoch millis of the last field/issue-type discovery; null until one ran. */
    val discoveredAt: Long?,
    val lastTestedAt: Long?,
    val lastTestOk: Boolean?,
    /** Whether a field mapping has been saved (the stored document is not `{}`). */
    val mappingSet: Boolean,
    /** The connection's own newest run (any other connection's runs never count); null before the first. */
    val lastRun: SyncLastRun?,
    /** The derived sync state (`SyncStatusKernels`): state, newest run, last success, failure streak, next poll. */
    val status: SyncStatus,
    val createdAt: Long,
    val updatedAt: Long,
    /**
     * Whether this connection's calls go to the development Jira stub rather than Atlassian: derived per request from the site and the
     * server's stub configuration ([JiraStubRouting]), never stored, never true in production.
     */
    val stub: Boolean = false,
)

fun JiraConnectionResponse.withStubRouting(routing: JiraStubRouting): JiraConnectionResponse = copy(stub = routing.routes(siteUrl))

typealias JiraConnectionPageResponse = PageResponse<JiraConnectionResponse>

data class JiraConnectionListResult(val items: List<JiraConnectionResponse>, val total: Long)

/** `affected` is the updated-row count (0 -> 404); `tokenRotated` whether the PUT carried a token; `host` the site's host (audit). */
data class JiraConnectionUpdateOutcome(val affected: Int, val tokenRotated: Boolean, val host: String)

/** What a run in flight may still do with its connection ([JiraConnectionService.runnableState]). */
enum class RunnableState { RUNNABLE, GONE, DISABLED }

/**
 * `affected` is the soft-deleted row count (0 -> 404); `name` and `host` are the row as STORED (the audit fields); `bindingsUnbound` the
 * connection's ACTIVE bindings soft-deleted with it, in the same transaction, and `runsDeleted` its hard-deleted runs (the audit's counts).
 * `censusDeleted` (V23) is the hard-deleted census mirror rows: a log INFO count after the commit, NOT an audit field.
 */
data class JiraConnectionDeleteOutcome(
    val affected: Int,
    val name: String,
    val host: String,
    val bindingsUnbound: Int,
    val runsDeleted: Int = 0,
    val censusDeleted: Int = 0,
)

/** The audit/host form of a site URL: the tenant host only, never the scheme or a path. */
fun jiraHostOf(siteUrl: String): String = siteUrl.removePrefix("https://")

/** Trims the scalars (the sanitizer convention - control characters are a 400) and folds the account email; a blank token is absent. */
fun sanitizedJiraConnection(request: JiraConnectionRequest): JiraConnectionRequest = JiraConnectionRequest(
    name = sanitizeSingleLine(request.name, "Name"),
    siteUrl = sanitizeSingleLine(request.siteUrl, "siteUrl"),
    email = canonicalEmail(sanitizeSingleLine(request.email, "email")),
    apiToken = request.apiToken?.let { sanitizeSingleLine(it, "apiToken") }?.takeIf { it.isNotBlank() },
    authScheme = request.authScheme,
    projectKeys = request.projectKeys.map { sanitizeSingleLine(it, "projectKeys") },
    enabled = request.enabled,
    pollIntervalMinutes = request.pollIntervalMinutes,
)

/**
 * The connection rules - enforced by the route AND re-checked by the service, both on an already-sanitized request. No message ever
 * quotes the token. [apiTokenRequired] is true on create; an update may omit the token to keep the stored one.
 */
fun validateJiraConnection(request: JiraConnectionRequest, apiTokenRequired: Boolean) {
    requireNameAndDescription(request.name, null, MAX_JIRA_CONNECTION_NAME_LENGTH, 0)
    val siteLabel = request.siteUrl.takeIf { it.length <= MAX_SITE_URL_LENGTH }
        ?.let { JIRA_SITE_URL_PATTERN.matchEntire(it) }?.groupValues?.get(1)
    if (siteLabel == null || siteLabel in ATLASSIAN_RESERVED_SITE_LABELS) {
        throw BadRequestException("siteUrl must be exactly https://<site>.atlassian.net (no path, query or trailing slash)")
    }
    if (request.email.isBlank() || request.email.length > MAX_JIRA_EMAIL_LENGTH || '@' !in request.email) {
        throw BadRequestException("email must be a valid address of at most $MAX_JIRA_EMAIL_LENGTH characters")
    }
    if (apiTokenRequired && request.apiToken.isNullOrBlank()) throw BadRequestException("apiToken is required")
    if (request.apiToken != null && (request.apiToken.isBlank() || request.apiToken.length > MAX_API_TOKEN_LENGTH)) {
        throw BadRequestException("apiToken must be 1-$MAX_API_TOKEN_LENGTH characters")
    }
    if (request.projectKeys.size !in MIN_PROJECT_KEYS..MAX_PROJECT_KEYS) {
        throw BadRequestException("projectKeys must contain $MIN_PROJECT_KEYS-$MAX_PROJECT_KEYS keys")
    }
    request.projectKeys.forEach { key ->
        if (!PROJECT_KEY_PATTERN.matches(key)) {
            throw BadRequestException("Invalid project key: ${key.take(MAX_KEY_ECHO)} (must match ${PROJECT_KEY_PATTERN.pattern})")
        }
    }
    if (request.projectKeys.distinct().size != request.projectKeys.size) throw BadRequestException("projectKeys must be distinct")
    if (request.pollIntervalMinutes != null && request.pollIntervalMinutes !in MIN_POLL_INTERVAL_MINUTES..MAX_POLL_INTERVAL_MINUTES) {
        throw BadRequestException(
            "Polling interval must be between $MIN_POLL_INTERVAL_MINUTES and $MAX_POLL_INTERVAL_MINUTES minutes, or null for manual only",
        )
    }
}
