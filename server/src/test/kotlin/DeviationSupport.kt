package ch.nokillswit

import ch.nokillswit.jira.CensusIssue
import ch.nokillswit.jira.DeviationItem
import ch.nokillswit.jira.DeviationView
import ch.nokillswit.jira.DiscoveredIssueType
import ch.nokillswit.jira.DiscoveredLevel
import ch.nokillswit.jira.DiscoveryMarkers
import ch.nokillswit.jira.JiraConnectionResponse
import ch.nokillswit.jira.JiraDiscovery
import ch.nokillswit.jira.JiraEstimateMapping
import ch.nokillswit.jira.JiraEstimateUnit
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraIssueStore
import ch.nokillswit.jira.JiraMappingLevels
import ch.nokillswit.jira.JiraStatusCategory
import ch.nokillswit.jira.toStoredJson
import ch.nokillswit.planning.DeviationKind
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import java.math.BigDecimal
import java.sql.Types
import java.time.LocalDate
import kotlin.test.assertEquals

// Shared by the Deviations view tests. NOTHING here touches the Jira stub: connections are made through the API (no Test connection),
// their discovery and mapping are written straight into the columns, and bindings and observations are raw INSERTs.

/** A Monday far enough ahead that "today" is before it whenever the suite runs (the progress rules compare with the real clock). */
const val DV_MONDAY = "2044-02-01"

const val DV_VIEW = "/api/v1/views/deviations"

/** The discovery every seeded connection stores: Epic (1), Initiative (2) and Program (3), no fields (the mapping names none). */
val DV_DISCOVERY = JiraDiscovery(
    discoveredAt = 1, fieldCount = 0, issueTypeCount = 3, fieldsTruncated = false, fields = emptyList(),
    issueTypes = listOf(
        DiscoveredIssueType("10004", "Epic", 1, false),
        DiscoveredIssueType("10005", "Initiative", 2, false),
        DiscoveredIssueType("10006", "Program", 3, false),
    ),
    levels = listOf(DiscoveredLevel(1, listOf("Epic")), DiscoveredLevel(2, listOf("Initiative")), DiscoveredLevel(3, listOf("Program"))),
    markers = DiscoveryMarkers(),
)

/** Program 3, project 2, milestone 1; points convert at 0.5 man-days a point. */
val DV_MAPPING = JiraMapping(
    JiraMappingLevels(program = JiraLevelMapping(3), project = JiraLevelMapping(2), milestone = JiraLevelMapping(1)),
    JiraEstimateMapping(JiraEstimateUnit.POINTS, 0.5),
)

/** The stored mapping that is valid JSON for an object but not a mapping: the document this build cannot decode. */
const val DV_UNREADABLE_MAPPING = """{"levels": 5}"""

/**
 * A connection made through the API (so its token is encrypted like any other), then given [discovery] and [mapping] straight in the
 * columns; null leaves the column as the API made it (no discovery, no mapping). A disabled one is created disabled.
 */
suspend fun HttpClient.dvConnection(
    discovery: JiraDiscovery? = DV_DISCOVERY,
    mapping: String? = DV_MAPPING.toStoredJson(),
    enabled: Boolean = true,
): UInt {
    val created = postJson(JB_CONNECTIONS, jbRequest(enabled = enabled))
    assertEquals(HttpStatusCode.Created, created.status)
    val id = jbJson.decodeFromString<JiraConnectionResponse>(created.bodyAsText()).id
    discovery?.let { jbSql(
        "UPDATE jira_connections SET discovery = ?::jsonb, discovered_at = 1 WHERE id = ?", it.toStoredJson(), id.toInt(),
    ) }
    mapping?.let { jbSql("UPDATE jira_connections SET mapping = ?::jsonb WHERE id = ?", it, id.toInt()) }
    return id
}

/** What an observation row holds; the defaults are a clean epic-level issue of a milestone named `Alpha`. */
class DvObs(
    val summary: String? = "Alpha",
    val level: Int? = 1,
    val status: String = "UNKNOWN",
    val parentId: String? = null,
    val parentKey: String? = null,
    val start: String? = null,
    val end: String? = null,
    val estimate: String? = null,
    val unit: String? = null,
    val gone: Boolean = false,
    val goneReason: String? = null,
)

private fun java.sql.PreparedStatement.set(index: Int, value: Any?) {
    if (value == null) setNull(index, Types.NULL) else setObject(index, value)
}

/**
 * An ACTIVE binding of [level] node [nodeId] to issue [issueId]/[key] on [connectionId] (a raw INSERT, past every guard), with the
 * observation [obs] (none = a binding no run or bind ever observed). Returns the binding id.
 */
fun dvBind(connectionId: UInt, level: JiraLevel, nodeId: UInt, issueId: String, key: String, obs: DvObs? = DvObs()): UInt {
    val column = when (level) {
        JiraLevel.PROGRAM -> "program_id"
        JiraLevel.PROJECT -> "project_id"
        JiraLevel.MILESTONE -> "milestone_id"
    }
    PostgresTestSupport.connect().use { c ->
        val id = c.prepareStatement(
            "INSERT INTO jira_bindings (connection_id, level, $column, jira_issue_id, jira_issue_key, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, 1, 1) RETURNING id",
        ).use { st ->
            st.setInt(1, connectionId.toInt())
            st.setString(2, level.name)
            st.setInt(3, nodeId.toInt())
            st.setString(4, issueId)
            st.setString(5, key)
            st.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
        if (obs != null) {
            c.prepareStatement(
                "INSERT INTO jira_observations (binding_id, observed_at, issue_key, summary, type_name, hierarchy_level, status_name, " +
                    "status_category, parent_issue_id, parent_issue_key, start_date, end_date, estimate, estimate_unit, team_name, " +
                    "jira_updated_at, gone, gone_reason) " +
                    "VALUES (?, 1234, ?, ?, 'Epic', ?, 'In progress', ?, ?, ?, ?, ?, ?, ?, 'Team', 1, ?, ?)",
            ).use { st ->
                st.setInt(1, id)
                st.setString(2, key)
                st.set(3, obs.summary)
                st.set(4, obs.level)
                st.setString(5, obs.status)
                st.set(6, obs.parentId)
                st.set(7, obs.parentKey)
                st.set(8, obs.start?.let(LocalDate::parse))
                st.set(9, obs.end?.let(LocalDate::parse))
                st.set(10, obs.estimate?.let(::BigDecimal))
                st.set(11, obs.unit)
                st.setBoolean(12, obs.gone)
                st.set(13, obs.goneReason)
                st.executeUpdate()
            }
        }
        return id.toUInt()
    }
}

/** `GET /views/deviations` with [query] (`connectionId=1&all=true`), decoded; the status must be 200. */
suspend fun HttpClient.dvView(query: String = ""): DeviationView {
    val response = get(if (query.isEmpty()) DV_VIEW else "$DV_VIEW?$query")
    assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
    return jbJson.decodeFromString(response.bodyAsText())
}

/** The items by binding id. */
fun DeviationView.byBinding(): Map<UInt, DeviationItem> = items.associateBy { it.bindingId }

/** The kinds an item lists, as a set. */
fun DeviationItem.kindSet(): Set<DeviationKind> = deviations.map { it.kind }.toSet()

/**
 * One census mirror row of [connectionId] (the run's `jira_issues`, written through the store the run uses): issue [id] with key `COV-[id]`
 * at hierarchy [level] under [parent], in a [status] category, with [points] (a plain decimal) or none.
 */
suspend fun dvMirror(
    connectionId: UInt,
    id: String,
    level: Int,
    parent: String?,
    status: JiraStatusCategory = JiraStatusCategory.TODO,
    points: String? = null,
    observedAt: Long = 5_000L,
) {
    val row = CensusIssue(id, "COV-$id", "10004", level, parent, "Summary of $id", status, points?.let(::BigDecimal), null, observedAt)
    assertEquals(1, JiraIssueStore(sharedDatabaseForTests()).upsert(connectionId, listOf(row)))
}
