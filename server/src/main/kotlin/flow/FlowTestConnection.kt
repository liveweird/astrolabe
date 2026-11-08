package ch.nokillswit.flow

import ch.nokillswit.infra.fetch.ConnectionTestRow
import ch.nokillswit.infra.fetch.ProbeRun
import ch.nokillswit.infra.maskedSecret
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId

/** The row of a stored token that cannot be decrypted (`TOKEN_UNREADABLE`: re-enter it). */
const val FLOW_STORED_TOKEN_ROW = "stored_token"
const val FLOW_TOKEN_UNREADABLE_CODE = "TOKEN_UNREADABLE"

/** What each probe needs of Flow (the rows' `scopeHint`): the service-token surface arrived in Flow 1.57.0, an older Flow answers 404. */
private const val FLOW_VERSION_HINT = "Flow 1.57.0 or later"

/**
 * What a Test connection probes. [apiToken] is null only when the STORED token could not be decrypted (a wrong or rotated
 * `DATA_ENCRYPTION_KEY`, a corrupt envelope): the test then answers one typed row instead of calling anything. [expectedUpdatedAt] is the
 * stored row's `updated_at` at read time (null for an ad-hoc test), so a result is recorded only if the row was not edited meanwhile.
 * [timeZone] turns "today" into the `sprintsSince` date, the way the run will.
 */
class FlowTestTarget(
    val baseUrl: String,
    val timeZone: String,
    val apiToken: String?,
    val expectedUpdatedAt: Long? = null,
) {
    /** The token is a secret: a default rendering must never reach a log line. */
    override fun toString(): String =
        "FlowTestTarget(baseUrl=$baseUrl, timeZone=$timeZone, apiToken=${maskedSecret(apiToken)})"
}

/**
 * The Test-connection answer: one row per probe, the size of the document the `teams` probe decoded (so the admin sees "N teams, M
 * sprints" before the first run) and whether the verdict was stored on the connection.
 */
@Serializable
data class FlowTestResult(
    val rows: List<ConnectionTestRow>,
    /** Teams in the decoded document; null unless the `teams` probe passed. */
    val teamCount: Int? = null,
    /** Sprints across those teams; null unless the `teams` probe passed. */
    val sprintCount: Int? = null,
    /** Whether Flow cut the document (`teamsTruncated` or `sprintsTruncated`): the run keeps what it got and warns. */
    val truncated: Boolean = false,
    /** Whether the result was stored on the connection: false for an ad-hoc test, or when an edit of the connection raced the test. */
    val recorded: Boolean = false,
) {
    /** What the UI calls a pass: every REQUIRED row is ok. */
    val passed: Boolean get() = rows.none { it.required && !it.ok }
}

/**
 * Test connection for Flow: `me` (the token is live) then `teams` (the document decodes), in sequence, each at most 10 s and 30 s in
 * all ([ProbeRun]). It never throws for an upstream or decrypt problem - every outcome is a row - and it touches no database: the
 * caller reads the target before and records the outcome after, so no transaction spans a Flow call. Nothing here writes the mirror (the
 * run is its single writer); `teams` asks for the same window the run does, today minus `flow.sprintsSinceDays` in the connection's zone.
 */
suspend fun FlowConnector.testConnection(target: FlowTestTarget, now: () -> Long = System::currentTimeMillis): FlowTestResult {
    val run = ProbeRun(now)
    val token = target.apiToken
    if (token == null) {
        run.fail(FLOW_STORED_TOKEN_ROW, "stored service token", required = true, code = FLOW_TOKEN_UNREADABLE_CODE)
        return FlowTestResult(run.rows)
    }
    val client = client(target.baseUrl, token)
    run.probe("me", FLOW_ME_PATH, required = true, scopeHint = FLOW_VERSION_HINT) { client.me() }
    var document: FlowTeamsDocument? = null
    // Without a live token there is nothing to read: the row says SKIPPED (not run), never a second failure of the same cause.
    if (run.rows.single().ok) {
        run.probe("teams", FLOW_TEAMS_PATH, required = true, scopeHint = FLOW_VERSION_HINT) {
            val today = Instant.ofEpochMilli(now()).atZone(ZoneId.of(target.timeZone)).toLocalDate()
            document = client.teams(today.minusDays(sprintsSinceDays.toLong()))
        }
    } else {
        run.skip("teams", FLOW_TEAMS_PATH, required = true)
    }
    val seen = document?.takeIf { run.rows.last().ok }
    return FlowTestResult(
        rows = run.rows,
        teamCount = seen?.items?.size,
        sprintCount = seen?.items?.sumOf { it.sprints.size },
        truncated = seen != null && (seen.teamsTruncated || seen.sprintsTruncated),
    )
}
