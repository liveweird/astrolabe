package ch.nokillswit.jira

import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.upsertRows
import java.math.BigDecimal
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.JsonObject
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

// The widths of `jira_issues.type_id` and `.summary` (V23): a census row is fitted to them before it is written.
private const val TYPE_ID_WIDTH = 20
private const val SUMMARY_WIDTH = 255

/**
 * `jira_issues` (V23): the latest observed CENSUS of a connection's scope (the mapped levels plus the child level the roll-ups read), one
 * row per issue, overwritten by every run and pruned by its sweeps. Not plan state: no soft delete, no revision, no plan lock. A
 * documented hard-delete exception beside `jira_observations` - the rows go with their connection
 * ([JiraIssueStore.deleteForConnectionInTransaction]).
 */
object JiraIssues : Table("jira_issues") {
    val connectionId = reference("connection_id", JiraConnectionService.Connections)
    val issueId = varchar("issue_id", length = 20)
    val issueKey = varchar("issue_key", length = 50)
    val typeId = varchar("type_id", length = 20).nullable()
    val hierarchyLevel = integer("hierarchy_level")
    val parentIssueId = varchar("parent_issue_id", length = 20).nullable()
    val summary = varchar("summary", length = 255).nullable()
    val statusCategory = varchar("status_category", length = 16)
    val points = decimal("points", 12, 2).nullable()
    val jiraUpdatedAt = long("jira_updated_at").nullable()
    val observedAt = long("observed_at")
    override val primaryKey = PrimaryKey(connectionId, issueId)
}

/**
 * One census row as the site sent it, already FITTED to the columns of `jira_issues` (a string too long or a figure out of
 * `NUMERIC(12,2)` would fail the whole statement, and one odd issue would then fail every later run's chunk - the reasoning of
 * [JiraObservation]). Built by [of], the pure read of an issue document; the type's hierarchy level is part of the row, because the
 * census only keeps issues whose level the discovery knows.
 */
data class CensusIssue(
    val issueId: String,
    val issueKey: String,
    val typeId: String?,
    val hierarchyLevel: Int,
    val parentIssueId: String?,
    val summary: String?,
    val statusCategory: JiraStatusCategory,
    val points: BigDecimal?,
    val jiraUpdatedAt: Long?,
    val observedAt: Long,
) {
    companion object {
        /**
         * Reads [issue] (one `search/jql` entry). It does NOT filter levels (C3's census keeps only the mapped and child ones).
         * Null when the document has no usable numeric `id` or issue `key`, or when neither the
         * issue's own type object nor the [discovery] knows its hierarchy level (a row without a level cannot be classified); every other
         * absent or odd member reads as null, never a failure. [pointsFieldId] is the discovery's story-points field (null = none): its
         * value is the same clamped figure an estimate is ([estimateOf]).
         */
        fun of(issue: JsonObject, discovery: JiraDiscovery, pointsFieldId: String?, observedAt: Long): CensusIssue? {
            val id = issue["id"].text(MAX_ID)?.takeIf(ISSUE_ID_PATTERN::matches) ?: return null
            val key = issue["key"].text(MAX_ID)?.takeIf(ISSUE_KEY_PATTERN::matches) ?: return null
            val fields = issue["fields"] as? JsonObject ?: JsonObject(emptyMap())
            val type = fields["issuetype"] as? JsonObject
            val typeId = type?.get("id").text(TYPE_ID_WIDTH)
            val level = discovery.hierarchyLevelOf(typeId, type?.get("hierarchyLevel").int()) ?: return null
            val status = fields["status"] as? JsonObject
            val parent = fields["parent"] as? JsonObject
            return CensusIssue(
                issueId = id,
                issueKey = key,
                typeId = typeId?.fitted(),
                hierarchyLevel = level,
                parentIssueId = parent?.get("id").text(MAX_ID)?.takeIf(ISSUE_ID_PATTERN::matches),
                summary = fields["summary"].text(SUMMARY_WIDTH)?.fitted(),
                statusCategory = statusCategoryOf((status?.get("statusCategory") as? JsonObject)?.get("key").text(MAX_ID)),
                points = pointsFieldId?.let { estimateOf(fields[it]) },
                jiraUpdatedAt = instantOf(fields["updated"]),
                observedAt = observedAt,
            )
        }
    }
}

/**
 * The census's database side, the ONLY writer of `jira_issues` and of `jira_connections.census_at`: short transactions, each independent
 * of any HTTP call, none taking the plan lock and none bumping a revision. A write re-checks that its connection is still ACTIVE under a
 * `FOR SHARE` row lock (the bind's idiom), so a delete that raced a run either waits for the write and then removes it, or has won and
 * the write is skipped: no row is ever left behind for a deleted connection.
 */
class JiraIssueStore(private val database: R2dbcDatabase) {
    private val connections = JiraConnectionService.Connections

    /**
     * Upserts [rows] (overwriting every column of an issue already mirrored) in ONE transaction; answers the rows written - 0 for an
     * empty list or a connection deleted since the run started.
     */
    suspend fun upsert(connectionId: UInt, rows: List<CensusIssue>): Int {
        if (rows.isEmpty()) return 0
        return suspendTransaction(database) {
            val live = connections.select(connections.id).where { (connections.id eq connectionId) and connections.active() }
                .forUpdate(ForUpdateOption.PostgreSQL.ForShare).toList().isNotEmpty()
            if (!live) return@suspendTransaction 0
            JiraIssues.upsertRows(rows, keys = listOf(JiraIssues.connectionId, JiraIssues.issueId)) { row ->
                this[JiraIssues.connectionId] = connectionId
                this[JiraIssues.issueId] = row.issueId
                this[JiraIssues.issueKey] = row.issueKey
                this[JiraIssues.typeId] = row.typeId
                this[JiraIssues.hierarchyLevel] = row.hierarchyLevel
                this[JiraIssues.parentIssueId] = row.parentIssueId
                this[JiraIssues.summary] = row.summary
                this[JiraIssues.statusCategory] = row.statusCategory.name
                this[JiraIssues.points] = row.points
                this[JiraIssues.jiraUpdatedAt] = row.jiraUpdatedAt
                this[JiraIssues.observedAt] = row.observedAt
            }
            rows.distinctBy { it.issueId }.size
        }
    }

    /** The connection's mirrored issues as issue id to hierarchy level (≤ ~6,000 rows at scale): what a prune diffs against. */
    suspend fun index(connectionId: UInt): Map<String, Int> = suspendTransaction(database) {
        JiraIssues.select(JiraIssues.issueId, JiraIssues.hierarchyLevel).where { JiraIssues.connectionId eq connectionId }
            .toList().associate { it[JiraIssues.issueId] to it[JiraIssues.hierarchyLevel] }
    }

    /** Removes the connection's mirror rows of [issueIds] (the caller chunks by [RUN_CHUNK]); answers the rows removed. */
    suspend fun delete(connectionId: UInt, issueIds: Collection<String>): Int {
        require(issueIds.size <= RUN_CHUNK) { "delete: at most $RUN_CHUNK ids per call, the run's chunk" }
        if (issueIds.isEmpty()) return 0
        return suspendTransaction(database) {
            JiraIssues.deleteWhere { (JiraIssues.connectionId eq connectionId) and (JiraIssues.issueId inList issueIds) }
        }
    }

    /** `jira_connections.census_at` of an ACTIVE connection: null when never censused, or when the connection is missing or deleted. */
    suspend fun censusAt(connectionId: UInt): Long? = suspendTransaction(database) {
        connections.select(connections.censusAt).where { (connections.id eq connectionId) and connections.active() }
            .toList().singleOrNull()?.get(connections.censusAt)
    }

    /**
     * Stamps `census_at` (no `updated_at`: a census says nothing about a Test result); false when the connection is gone. A null [at]
     * clears it: the next run reads in full and re-seeds the mirror.
     */
    suspend fun stampCensus(connectionId: UInt, at: Long?): Boolean = suspendTransaction(database) {
        connections.update({ (connections.id eq connectionId) and connections.active() }) { it[censusAt] = at } > 0
    }

    companion object {
        /**
         * Removes every mirror row of the connection INSIDE the caller's open transaction (it opens none): a connection delete takes
         * its mirror with it, like its runs. Answers the rows removed.
         */
        suspend fun deleteForConnectionInTransaction(connectionId: UInt): Int =
            JiraIssues.deleteWhere { JiraIssues.connectionId eq connectionId }
    }
}
