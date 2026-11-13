package ch.nokillswit.jira

import ch.nokillswit.infra.db.active
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*

/** The cap of `GET /views/jira-links` (the plan's scale gives about 120 program and project links). */
const val MAX_JIRA_LINKS = 2000

/**
 * `GET /views/jira-links` (1.15): the narrow read of "which program and project is linked to which Jira item", for the Plan page's
 * import entries. [connections] is EVERY active connection (the deviations view's rule: the six members, never the email, token,
 * mapping or discovery); [links] the active bindings of active connections on LIVE programs and projects, programs first, each by
 * node id; [truncated] says the cap dropped links. No revision and no `can`: links are not plan state.
 */
@Serializable
data class JiraLinksView(val connections: List<JiraLinkConnection>, val links: List<JiraNodeLink>, val truncated: Boolean)

/** A connection as the links view shows it: exactly what `GET /views/deviations` `connections[]` already tells every login. */
@Serializable
data class JiraLinkConnection(
    val id: UInt,
    val name: String,
    val siteUrl: String,
    val enabled: Boolean,
    val projectKeys: List<String>,
    val mappingOk: Boolean,
)

/** One binding of a program or project: [gone] is the observation's flag (false when never observed). */
@Serializable
data class JiraNodeLink(
    val level: JiraLevel,
    val nodeId: UInt,
    val bindingId: UInt,
    val connectionId: UInt,
    val issueKey: String,
    val gone: Boolean,
)

private val bindings = JiraBindingService.Bindings
private val connections = JiraConnectionService.Connections
private val observations = JiraObservations

/**
 * The links of the caller's transaction: ONE statement (`jira_bindings` ⋈ `jira_connections` LEFT JOIN `jira_observations`, for the
 * one `gone` column), the ACTIVE bindings of ACTIVE connections on LIVE program and project nodes (the node and every ancestor
 * active: the bindings list's own sub-queries), programs first, then projects, each by node id. Reads at most [limit] + 1 rows, so
 * the caller can tell the cap dropped some; a milestone binding is never read.
 */
internal suspend fun loadNodeLinks(limit: Int): List<JiraNodeLink> =
    bindings.innerJoin(connections, { bindings.connectionId }, { connections.id })
        .leftJoin(observations, { bindings.id }, { observations.bindingId })
        .select(
            bindings.id, bindings.connectionId, bindings.level, bindings.programId, bindings.projectId, bindings.jiraIssueKey,
            observations.gone,
        )
        .where {
            bindings.active() and connections.active() and
                (bindings.level inList listOf(JiraLevel.PROGRAM.name, JiraLevel.PROJECT.name)) and
                (
                    (bindings.programId inSubQuery liveProgramIds()) or
                        (bindings.projectId inSubQuery liveProjectIds())
                    )
        }
        // Ordering by the `level` string relies on 'PROGRAM' < 'PROJECT' (programs first); the node columns break the tie.
        .orderBy(bindings.level to SortOrder.ASC, bindings.programId to SortOrder.ASC, bindings.projectId to SortOrder.ASC)
        .limit(limit + 1)
        .toList().map { row ->
            val level = JiraLevel.valueOf(row[bindings.level])
            val node = if (level == JiraLevel.PROGRAM) row[bindings.programId] else row[bindings.projectId]
            JiraNodeLink(
                level = level,
                nodeId = checkNotNull(node) { "ck_jira_bindings_node: a program or project binding names its node" }.value,
                bindingId = row[bindings.id].value,
                connectionId = row[bindings.connectionId].value,
                issueKey = row[bindings.jiraIssueKey],
                gone = row.getOrNull(observations.gone) ?: false,
            )
        }

/** Every active connection as the links view shows it: by name (case-insensitive), then id. */
internal fun List<ConnectionFacts>.toLinkConnections(): List<JiraLinkConnection> =
    sortedWith(compareBy<ConnectionFacts>({ it.name.lowercase() }, { it.id })).map {
        JiraLinkConnection(it.id, it.name, it.siteUrl, it.enabled, it.projectKeys, mappingOk = it.levels != null)
    }
