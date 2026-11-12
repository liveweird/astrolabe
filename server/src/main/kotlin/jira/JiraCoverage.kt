package ch.nokillswit.jira

import ch.nokillswit.planning.SNAPSHOT
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val JiraCoverageServiceKey = AttributeKey<JiraCoverageService>("JiraCoverageService")

/** What the summary can say: nothing was ever censused, the mapping cannot name the levels, or the counts are there. */
@Serializable
enum class JiraCoverageState { NOT_SYNCED, MAPPING_UNUSABLE, READY }

/**
 * One mapped plan level's counts over the connection's census mirror: [inScope] = mirror issues at the level's Jira hierarchy level,
 * [linked] = those an active binding names (the unlinked-in-Jira rule: same site, active binding, active connection), [openUnlinked] =
 * those not in the Done status category and not linked. Counts only: no key, name or summary ever rides here.
 */
@Serializable
data class JiraCoverageLevel(val level: JiraLevel, val hierarchyLevel: Int, val inScope: Int, val linked: Int, val openUnlinked: Int)

/**
 * `GET /integrations/jira/connections/{id}/coverage`: the per-level counts ([levels] is empty unless [state] is `READY`; top down,
 * program, project, milestone, only the mapped ones) and [censusAt], when the run last finished a census (null = never or cleared for a
 * re-seed).
 */
@Serializable
data class JiraCoverageResponse(val state: JiraCoverageState, val censusAt: Long?, val levels: List<JiraCoverageLevel>)

/**
 * The connection page's coverage summary: ONE read-only snapshot transaction over what the runs already stored (`jira_connections`,
 * the census mirror `jira_issues`, `jira_bindings`) - no call to Jira, no lock, no write, no revision. The mapped levels come from the
 * connection's CURRENT effective mapping ([loadConnections], the Deviations view's resolution).
 */
class JiraCoverageService(private val database: R2dbcDatabase) {
    private val connections = JiraConnectionService.Connections

    /** The summary of an ACTIVE connection, or null when it does not exist (or is deleted). */
    suspend fun read(connectionId: UInt): JiraCoverageResponse? = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val facts = loadConnections(onlyId = connectionId).singleOrNull() ?: return@suspendTransaction null
        val censusAt = connections.select(connections.censusAt).where { connections.id eq connectionId }
            .toList().single()[connections.censusAt]
        val mirrored = JiraIssues.selectAll().where { JiraIssues.connectionId eq connectionId }.limit(1).toList().isNotEmpty()
        val levels = facts.levels
        when {
            censusAt == null && !mirrored -> JiraCoverageResponse(JiraCoverageState.NOT_SYNCED, null, emptyList())
            levels == null -> JiraCoverageResponse(JiraCoverageState.MAPPING_UNUSABLE, censusAt, emptyList())
            else -> JiraCoverageResponse(JiraCoverageState.READY, censusAt, countLevels(connectionId, levels))
        }
    }

    /** Counts per mapped level in one grouped statement: the level's issues, the linked ones and the open unlinked ones. */
    private suspend fun countLevels(connectionId: UInt, levels: Map<JiraLevel, DeviationMapping>): List<JiraCoverageLevel> {
        val linked = bindingOnSameSite()
        val hierarchy = JiraIssues.hierarchyLevel
        val inScope = JiraIssues.issueId.count()
        val linkedCount = Case().When(exists(linked), intLiteral(1)).Else(intLiteral(0)).sum()
        val open = (JiraIssues.statusCategory neq JiraStatusCategory.DONE.name) and notExists(linked)
        val openUnlinked = Case().When(open, intLiteral(1)).Else(intLiteral(0)).sum()
        val found = JiraIssues.innerJoin(connections, { JiraIssues.connectionId }, { connections.id })
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
