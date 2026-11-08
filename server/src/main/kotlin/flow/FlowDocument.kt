package ch.nokillswit.flow

import ch.nokillswit.infra.fetch.FetchException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement

// THE Kotlin place where Flow's wire contract is written (Flow 1.57.0, `~/.claude/plans/flow-service-token.md` section 3.1; the stub's twin
// is `sample-data/flow/contract.mjs`). If the real Flow ships a different path, query name or field, THIS file and contract.mjs change
// (plus a regenerate), and `FlowClientTest` / `FlowStubFixtureTest` prove them aligned (`flow-sync.md` "The contract and drift").
// Nothing else in the server names a Flow field or path.

/** The two operations (both GET, `Authorization: Bearer flow_int_...`). */
internal const val FLOW_ME_PATH = "/api/v1/integration/me"
internal const val FLOW_TEAMS_PATH = "/api/v1/integration/teams"

/** The one query parameter of `teams`: an ISO date, the effective filter on the sprints (Flow defaults it to today - 365 days). */
internal const val FLOW_SPRINTS_SINCE_PARAMETER = "sprintsSince"

/** The most sprint rows one document carries; past it Flow sets [FlowTeamsDocument.sprintsTruncated]. */
const val FLOW_SPRINT_CAP = 2_000

/** The most teams one document carries; past it Flow sets [FlowTeamsDocument.teamsTruncated]. */
const val FLOW_TEAM_CAP = 1_000

/**
 * Lenient on members the client does not read (a newer Flow may add some), strict on the ones it does: a missing or mistyped REQUIRED
 * member is a [FetchException] `INVALID_RESPONSE` (the run fails visibly rather than mirroring a guess). The required members include the
 * lists (`items`, `members`, `sprints`) and the flags (`teamsTruncated`, `sprintsTruncated`, `hasCalendar`): an absent one reads as
 * drift, never as "empty" or "false". Only the scalars that may be `null` default to `null`: Flow encodes without defaults, so it OMITS
 * a null (`expiresAt`, `lastUsedAt`, `validTo`, a missing capacity...), and an omitted null decodes the same as a sent one.
 *
 * `teamsTruncated` (the 1,000-team cap, [FLOW_TEAM_CAP]) and `sprintsTruncated` are read by the run (`FlowObserver`): it WARNs when
 * either is set and never treats a team absent from a truncated document as gone. Nothing here acts on them.
 */
private val FLOW_JSON = Json { ignoreUnknownKeys = true }

/** `GET /integration/me`: the facts of the presenting token (before this call's `last_used_at` stamp). Test connection's proof of life. */
@Serializable
data class FlowMe(
    val tokenId: Int,
    val name: String,
    val createdAt: Long,
    val expiresAt: Long? = null,
    val lastUsedAt: Long? = null,
)

/**
 * `GET /integration/teams?sprintsSince=YYYY-MM-DD`: every active Flow team with its dated members and its sprints, ONE document (not
 * paged). [teamsTruncated] says the team cap ([FLOW_TEAM_CAP]) and [sprintsTruncated] the sprint cap ([FLOW_SPRINT_CAP]) cut the answer.
 */
@Serializable
data class FlowTeamsDocument(
    /** Epoch millis of Flow's read. */
    val asOf: Long,
    /** The effective filter, `YYYY-MM-DD`. */
    val sprintsSince: String,
    val teamsTruncated: Boolean,
    val sprintsTruncated: Boolean,
    val items: List<FlowTeam>,
)

@Serializable
data class FlowTeam(
    val id: Int,
    val name: String,
    val managerName: String? = null,
    /** The team's default sprint capacity in man-days, null when Flow has none. */
    val defaultCapacityMd: Double? = null,
    val members: List<FlowMember>,
    val sprints: List<FlowSprint>,
)

/** One membership interval, HALF-OPEN: a member over `[validFrom, validTo)`; [validTo] null = still a member. Epoch millis. */
@Serializable
data class FlowMember(
    val accountId: String,
    val displayName: String? = null,
    val validFrom: Long,
    val validTo: Long? = null,
)

/**
 * One sprint row. [capacityMd] is a TOTAL for the sprint whatever its [capacitySource] (`CALENDAR`, `TEAM_DEFAULT`, `DEFAULT`; kept as
 * text, an unknown value is not an error); null = Flow derived no capacity at all. Instants are epoch millis.
 */
@Serializable
data class FlowSprint(
    val sprintId: Long,
    /** Flow's own data-source connection the sprint came from. */
    val connectionId: Int,
    val name: String,
    val state: String,
    val startAt: Long? = null,
    val endAt: Long? = null,
    val completeAt: Long? = null,
    val hasCalendar: Boolean,
    val capacityMd: Double? = null,
    val capacitySource: String? = null,
)

/** Decodes the `me` body; a shape mismatch is `INVALID_RESPONSE` (the endpoint path only - never a query). */
internal fun decodeFlowMe(json: JsonElement): FlowMe = decodeFlow(json, FLOW_ME_PATH)

/** Decodes the `teams` body; a shape mismatch is `INVALID_RESPONSE`. */
internal fun decodeFlowTeams(json: JsonElement): FlowTeamsDocument = decodeFlow(json, FLOW_TEAMS_PATH)

private inline fun <reified T> decodeFlow(json: JsonElement, endpoint: String): T = try {
    FLOW_JSON.decodeFromJsonElement<T>(json)
} catch (cause: Exception) {
    // A SerializationException or IllegalArgumentException: the message may quote the offending value, so it is kept as the cause only.
    throw FetchException(FLOW_SOURCE, "INVALID_RESPONSE", null, endpoint).also { it.initCause(cause) }
}
