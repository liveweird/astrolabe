package ch.nokillswit.flow

import ch.nokillswit.infra.maskedSecret
import ch.nokillswit.infra.paging.PageResponse
import ch.nokillswit.infra.validation.requireNameAndDescription
import ch.nokillswit.infra.validation.sanitizeSingleLine
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable
import java.time.ZoneId

/**
 * Flow connections (V24): an ADMIN-managed registry of the Flow instances the sync READS (nothing is ever written to Flow). The Jira
 * registry's shape - one request/response pair for create and update, a soft-deleted row, a name unique among the active ones, a
 * write-only credential - with Flow's own parts: the identity is an exact ORIGIN the operator listed (never changed by a PUT), the
 * credential is Flow's read-only service token, and the time zone turns Flow's instants into dates. [FlowConnectionRequest.apiToken] is
 * accepted on create/update, encrypted at rest (`FlowConnectionService`) and NEVER returned or logged; the response carries
 * [FlowConnectionResponse.hasApiToken] instead.
 */
const val MAX_FLOW_CONNECTION_NAME_LENGTH = 100
const val MAX_FLOW_BASE_URL_LENGTH = 255
const val MAX_FLOW_TIME_ZONE_LENGTH = 64
const val MIN_FLOW_POLL_INTERVAL_MINUTES = 5
const val MAX_FLOW_POLL_INTERVAL_MINUTES = 1440
const val DEFAULT_FLOW_POLL_INTERVAL_MINUTES = 60

/** Flow's service token (Flow 1.57.0): `flow_int_` and 43 base64url characters (256 bits). A Jira token pasted here fails fast. */
val FLOW_TOKEN_PATTERN: Regex = Regex("^flow_int_[A-Za-z0-9_-]{43}$")

@Serializable
data class FlowConnectionRequest(
    val name: String,
    /** The Flow origin, exactly one the operator listed (`FLOW_ALLOWED_HOSTS` / `FLOW_INSECURE_ORIGINS`): no path, query or credentials. */
    val baseUrl: String,
    /** An IANA zone id (`Europe/Warsaw`): Flow's sprint and membership instants become dates in it. */
    val timeZone: String,
    /** Required on create; omitted or blank on update keeps the stored token, present rotates it. Write-only. */
    val apiToken: String? = null,
    val enabled: Boolean = true,
    /** Minutes between scheduled runs: omitted = [DEFAULT_FLOW_POLL_INTERVAL_MINUTES], an explicit null = manual only (Refresh now). */
    val pollIntervalMinutes: Int? = DEFAULT_FLOW_POLL_INTERVAL_MINUTES,
) {
    /** A default data-class `toString()` would print the token in plain text into any log line. */
    override fun toString(): String =
        "FlowConnectionRequest(name=$name, baseUrl=$baseUrl, timeZone=$timeZone, apiToken=${maskedSecret(apiToken)}, " +
            "enabled=$enabled, pollIntervalMinutes=$pollIntervalMinutes)"
}

@Serializable
data class FlowConnectionResponse(
    val id: UInt,
    val name: String,
    val baseUrl: String,
    val timeZone: String,
    /** The token is write-only - never returned in any response or audit line; this says whether one is stored. */
    val hasApiToken: Boolean,
    val enabled: Boolean,
    /** Minutes between scheduled runs; null = manual only. */
    val pollIntervalMinutes: Int?,
    val lastTestedAt: Long?,
    val lastTestOk: Boolean?,
    /** Epoch millis of the run that last replaced the mirror; null until one ran. */
    val teamsAt: Long?,
    val createdAt: Long,
    val updatedAt: Long,
)

typealias FlowConnectionPageResponse = PageResponse<FlowConnectionResponse>

data class FlowConnectionListResult(val items: List<FlowConnectionResponse>, val total: Long)

/** `affected` is the updated-row count (0 -> 404); `tokenRotated` whether the PUT carried a token; `host` the origin's host (audit). */
data class FlowConnectionUpdateOutcome(val affected: Int, val tokenRotated: Boolean, val host: String)

/** What a run in flight may still do with its connection ([FlowConnectionService.runnableState]). */
enum class FlowRunnableState { RUNNABLE, GONE, DISABLED }

/**
 * `affected` is the soft-deleted row count (0 -> 404); `name` and `host` are the row as STORED (the audit fields); `bindingsUnbound` the
 * connection's ACTIVE team bindings soft-deleted with it, `runsDeleted` its hard-deleted runs and `mirrorDeleted` its hard-deleted mirror
 * rows (teams, sprints and members together), all in the same transaction (the audit's counts).
 */
data class FlowConnectionDeleteOutcome(
    val affected: Int,
    val name: String,
    val host: String,
    val bindingsUnbound: Int,
    val runsDeleted: Int = 0,
    val mirrorDeleted: Int = 0,
)

/**
 * A stored connection with its token DECRYPTED in memory, for the one caller that is about to use it ([FlowConnectionService.readForTest],
 * [FlowConnectionService.readForRun]). [apiToken] is null when the stored envelope cannot be decrypted (a wrong or rotated key): the
 * caller reports a typed `TOKEN_UNREADABLE`, never a 500. [expectedUpdatedAt] lets `recordTest` drop a result that judged an older row.
 */
data class FlowConnectionTarget(
    val id: UInt,
    val name: String,
    val baseUrl: String,
    val timeZone: String,
    val apiToken: String?,
    val enabled: Boolean,
    val expectedUpdatedAt: Long,
) {
    /** A default data-class `toString()` would print the decrypted token. */
    override fun toString(): String =
        "FlowConnectionTarget(id=$id, name=$name, baseUrl=$baseUrl, timeZone=$timeZone, apiToken=${maskedSecret(apiToken)}, " +
            "enabled=$enabled, expectedUpdatedAt=$expectedUpdatedAt)"
}

/** The audit/host form of a Flow origin: the host (and port) only, never the scheme. */
fun flowHostOf(baseUrl: String): String = baseUrl.substringAfter("://")

/** Trims the scalars (the sanitizer convention - control characters are a 400); a blank token is absent. */
fun sanitizedFlowConnection(request: FlowConnectionRequest): FlowConnectionRequest = FlowConnectionRequest(
    name = sanitizeSingleLine(request.name, "Name"),
    baseUrl = sanitizeSingleLine(request.baseUrl, "baseUrl"),
    timeZone = sanitizeSingleLine(request.timeZone, "timeZone"),
    apiToken = request.apiToken?.let { sanitizeSingleLine(it, "apiToken") }?.takeIf { it.isNotBlank() },
    enabled = request.enabled,
    pollIntervalMinutes = request.pollIntervalMinutes,
)

/**
 * The connection rules - enforced by the route AND re-checked by the service, both on an already-sanitized request. No message ever
 * quotes the token or the rejected origin. [apiTokenRequired] is true on create; an update may omit the token to keep the stored one.
 * [baseUrlAllowed] is the operator's origin allow-list (`FlowOrigins.baseUrlAllowed`, arrives with the outbound guard): the registry
 * can never widen it, so an unlisted origin is a 400 here.
 */
fun validateFlowConnection(request: FlowConnectionRequest, apiTokenRequired: Boolean, baseUrlAllowed: (String) -> Boolean) {
    requireNameAndDescription(request.name, null, MAX_FLOW_CONNECTION_NAME_LENGTH, 0)
    if (request.baseUrl.length > MAX_FLOW_BASE_URL_LENGTH || !baseUrlAllowed(request.baseUrl)) {
        throw BadRequestException("baseUrl must be exactly one of the Flow origins this server is configured to allow")
    }
    if (request.timeZone.length > MAX_FLOW_TIME_ZONE_LENGTH || !isRegionZone(request.timeZone)) {
        throw BadRequestException("timeZone must be an IANA time zone id such as Europe/Warsaw")
    }
    if (apiTokenRequired && request.apiToken.isNullOrBlank()) throw BadRequestException("apiToken is required")
    if (request.apiToken != null && !FLOW_TOKEN_PATTERN.matches(request.apiToken)) {
        throw BadRequestException("apiToken must be a Flow service token (flow_int_ followed by 43 characters)")
    }
    if (request.pollIntervalMinutes != null &&
        request.pollIntervalMinutes !in MIN_FLOW_POLL_INTERVAL_MINUTES..MAX_FLOW_POLL_INTERVAL_MINUTES
    ) {
        throw BadRequestException(
            "Polling interval must be between $MIN_FLOW_POLL_INTERVAL_MINUTES and $MAX_FLOW_POLL_INTERVAL_MINUTES minutes, " +
                "or null for manual only",
        )
    }
}

/** A region id the JDK knows (`ZoneId.of` accepts it); a bare offset such as `+02:00` has no daylight saving and is no IANA id. */
private fun isRegionZone(id: String): Boolean = id in ZoneId.getAvailableZoneIds()
