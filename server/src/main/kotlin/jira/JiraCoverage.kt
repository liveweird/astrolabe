package ch.nokillswit.jira

import ch.nokillswit.planning.SNAPSHOT
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncRunService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val JiraCoverageServiceKey = AttributeKey<JiraCoverageService>("JiraCoverageService")

/**
 * What the summary can say: nothing was ever censused ([NOT_SYNCED]), the mapping cannot name the levels ([MAPPING_UNUSABLE]), the mapping
 * was saved after the last successful run read the site, so the mirror does not hold the new levels yet ([MAPPING_CHANGED]), or the counts
 * are there ([READY]).
 */
@Serializable
enum class JiraCoverageState { NOT_SYNCED, MAPPING_UNUSABLE, MAPPING_CHANGED, READY }

/**
 * One mapped plan level's counts over the connection's census mirror: [inScope] = mirror issues at the level's Jira hierarchy level,
 * [linked] = those an active binding names (the unlinked-in-Jira rule: same site, active binding, active connection), [openUnlinked] =
 * those not in the Done status category and not linked. Counts only: no key, name or summary ever rides here.
 */
@Serializable
data class JiraCoverageLevel(val level: JiraLevel, val hierarchyLevel: Int, val inScope: Int, val linked: Int, val openUnlinked: Int)

/**
 * `GET /integrations/jira/connections/{id}/coverage`: the per-level counts ([levels] is empty unless [state] is `READY`; top down,
 * program, project, milestone, only the mapped ones) and [readAt], when the connection's last SUCCESSFUL run finished - the counted rows
 * are as of then (the run upserts and prunes the mapped levels every time); null before any success.
 */
@Serializable
data class JiraCoverageResponse(val state: JiraCoverageState, val readAt: Long?, val levels: List<JiraCoverageLevel>)

/**
 * The connection page's coverage summary: ONE read-only snapshot transaction over what the runs already stored (`jira_connections`,
 * the census mirror `jira_issues`, `jira_bindings`, the run registry `sync_runs`) - no call to Jira, no lock, no write, no revision. The
 * mapped levels come from the connection's CURRENT effective mapping ([loadConnections], the Deviations view's resolution).
 */
class JiraCoverageService(private val database: R2dbcDatabase, private val runs: SyncRunService) {
    private val bindings = JiraBindingService.Bindings

    /** The summary of an ACTIVE connection, or null when it does not exist (or is deleted). */
    suspend fun read(connectionId: UInt): JiraCoverageResponse? = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val facts = loadConnections(onlyId = connectionId).singleOrNull() ?: return@suspendTransaction null
        val mirrored = JiraIssues.select(JiraIssues.issueId).where { JiraIssues.connectionId eq connectionId }.limit(1).toList()
            .isNotEmpty()
        val lastRead = runs.lastSucceededInTransaction(SyncKind.JIRA, connectionId)
        val readAt = lastRead?.let { it.finishedAt ?: it.startedAt }
        val levels = facts.levels
        // A mapping saved after the last successful run STARTED (that run read under the old one) touches neither the mirror nor
        // `census_at`: a newly mapped level would read a false 0/0/0, so no counts until a run has read under the new mapping.
        val remapped = facts.mappingChangedAt?.let { lastRead == null || it > lastRead.startedAt } == true
        when {
            facts.censusAt == null && !mirrored -> JiraCoverageResponse(JiraCoverageState.NOT_SYNCED, null, emptyList())
            levels == null -> JiraCoverageResponse(JiraCoverageState.MAPPING_UNUSABLE, readAt, emptyList())
            remapped -> JiraCoverageResponse(JiraCoverageState.MAPPING_CHANGED, readAt, emptyList())
            else -> JiraCoverageResponse(JiraCoverageState.READY, readAt, countLevels(connectionId, facts.siteUrl, levels))
        }
    }

    /**
     * Counts per mapped level in one grouped statement: the level's issues, the linked ones and the open unlinked ones. The linked
     * verdict is computed ONCE per mirror row, by a LEFT JOIN to the DISTINCT set of linked issue ids of the site
     * ([linkedIssueIdsOnSite], the Deviations view's rule), not by a correlated subplan per row and per use.
     */
    private suspend fun countLevels(
        connectionId: UInt,
        siteUrl: String,
        levels: Map<JiraLevel, DeviationMapping>,
    ): List<JiraCoverageLevel> {
        val linked = linkedIssueIdsOnSite(siteUrl).alias("linked")
        val linkedId = linked[bindings.jiraIssueId]
        val hierarchy = JiraIssues.hierarchyLevel
        val inScope = JiraIssues.issueId.count()
        val linkedCount = Case().When(linkedId.isNotNull(), intLiteral(1)).Else(intLiteral(0)).sum()
        val open = (JiraIssues.statusCategory neq JiraStatusCategory.DONE.name) and linkedId.isNull()
        val openUnlinked = Case().When(open, intLiteral(1)).Else(intLiteral(0)).sum()
        val found = JiraIssues.join(linked, JoinType.LEFT, JiraIssues.issueId, linkedId)
            .select(hierarchy, inScope, linkedCount, openUnlinked)
            .where { (JiraIssues.connectionId eq connectionId) and (hierarchy inList levels.values.map { it.hierarchyLevel }) }
            .groupBy(hierarchy).toList().associateBy { it[hierarchy] }
        return JiraLevel.entries.mapNotNull { level ->
            val mapped = levels[level]?.hierarchyLevel ?: return@mapNotNull null
            val row = found[mapped]
            JiraCoverageLevel(
                level, mapped, row?.get(inScope)?.toInt() ?: 0, row?.get(linkedCount) ?: 0,
                row?.get(openUnlinked) ?: 0,
            )
        }
    }
}
