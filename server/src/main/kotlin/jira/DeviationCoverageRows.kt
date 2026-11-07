package ch.nokillswit.jira

import ch.nokillswit.infra.db.active
import ch.nokillswit.planning.MilestoneService
import ch.nokillswit.planning.ProjectService
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.EntityID
import org.jetbrains.exposed.v1.r2dbc.*

/*
 * The coverage inputs of `GET /views/deviations` (1.4): the roll-up of a bound epic's children and the children of a bound program or
 * project that no binding covers, read from the census mirror `jira_issues` and the plan's own tree. Like `DeviationViewRows.kt`, every
 * function runs INSIDE the caller's transaction (the view's snapshot, or the acknowledge's write) and takes no lock. A binding's verdict
 * depends on its own row, its connection, the mirror and the OTHER bindings - read from the tables here, never from the computation's
 * scope - so a scoped computation (the acknowledge, the timeline fold) gives the very list the full view gives, and an acknowledged
 * coverage fingerprint equals the view's. One statement per input, scoped to the bindings in view (no N+1).
 */

private val bindings = JiraBindingService.Bindings
private val connections = JiraConnectionService.Connections
private val projects = ProjectService.Projects
private val milestones = MilestoneService.Milestones

private const val DONE = "DONE"

/** The coverage inputs per BINDING id: a milestone's [rollups] and a program's or project's [unlinked] children. */
internal class Coverage(val rollups: Map<UInt, ChildRollup>, val unlinked: Map<UInt, UnlinkedChildren>) {
    companion object {
        val NONE = Coverage(emptyMap(), emptyMap())
    }
}

/** Both inputs for the [live] bindings (those whose nodes are live), against their [facts]' current mapping. */
internal suspend fun loadCoverage(live: List<BindingRow>, facts: Map<UInt, ConnectionFacts>): Coverage {
    if (live.isEmpty()) return Coverage.NONE
    val keys = loadUnlinkedJira(live, facts)
    val names = loadUnlinkedPlan(live, facts)
    val unlinked = (keys.keys + names.keys).associateWith {
        UnlinkedChildren(keys[it].orEmpty(), names[it].orEmpty())
    }
    return Coverage(loadRollups(live, facts), unlinked)
}

/** The plan level whose nodes sit directly under a [level] node (a milestone has none). */
private fun childPlanLevel(level: JiraLevel): JiraLevel? = when (level) {
    JiraLevel.PROGRAM -> JiraLevel.PROJECT
    JiraLevel.PROJECT -> JiraLevel.MILESTONE
    JiraLevel.MILESTONE -> null
}

/** `connection AND level AND parent IN (...)` for each group, ORed; null when there is nothing to ask. */
private fun mirrorPredicate(groups: Map<Pair<UInt, Int>, Collection<String>>): Op<Boolean>? =
    groups.filterValues { it.isNotEmpty() }.map { (key, parentIds) ->
        (JiraIssues.connectionId eq key.first) and (JiraIssues.hierarchyLevel eq key.second) and
            (JiraIssues.parentIssueId inList parentIds.distinct())
    }.reduceOrNull { a, b -> a or b }

/**
 * The census roll-up of each bound MILESTONE (epic): its mirrored children at the child level (`milestone.hierarchyLevel - 1`, never
 * below 0), counted, the DONE ones counted, their points summed (null when none carries a value) and the newest observation, in ONE
 * `GROUP BY (connection, parent)` over the bound issues. A binding with no mirrored child has none (absent).
 */
internal suspend fun loadRollups(live: List<BindingRow>, facts: Map<UInt, ConnectionFacts>): Map<UInt, ChildRollup> {
    val asked = live.filter { it.ref.level == JiraLevel.MILESTONE }.mapNotNull { row ->
        val childLevel = (facts[row.connectionId]?.levels?.get(JiraLevel.MILESTONE)?.hierarchyLevel ?: return@mapNotNull null) - 1
        row.takeIf { childLevel >= 0 }?.let { Triple(it, row.connectionId, childLevel) }
    }
    val predicate = mirrorPredicate(
        asked.groupBy({ it.second to it.third }) { it.first.issueId },
    ) ?: return emptyMap()
    val children = JiraIssues.issueId.count()
    val done = Case().When(JiraIssues.statusCategory eq DONE, intLiteral(1)).Else(intLiteral(0)).sum()
    val points = JiraIssues.points.sum()
    val newest = JiraIssues.observedAt.max()
    val found = JiraIssues.select(JiraIssues.connectionId, JiraIssues.parentIssueId, children, done, points, newest)
        .where { predicate }.groupBy(JiraIssues.connectionId, JiraIssues.parentIssueId).toList().associate { row ->
            (row[JiraIssues.connectionId].value to row[JiraIssues.parentIssueId]) to ChildRollup(
                row[children].toInt(), row[done]?.toInt() ?: 0, row[points], checkNotNull(row[newest]) { "count(*) > 0 has a max" },
            )
        }
    return asked.mapNotNull { (row, connection, _) -> found[connection to row.issueId]?.let { row.id to it } }.toMap()
}

/**
 * The keys of the OPEN (not DONE) mirrored children of each bound PROGRAM or PROJECT, at the mapping's level for the child plan level
 * (unmapped = no coverage), that NO active binding covers: no active binding of an active connection of the SAME site (D1: the issue
 * id is unique per site) names the issue. Node liveness of that binding is not re-checked (the run releases dead-node bindings every
 * poll). One statement; ascending by numeric id; keys only, never a summary.
 */
internal suspend fun loadUnlinkedJira(live: List<BindingRow>, facts: Map<UInt, ConnectionFacts>): Map<UInt, List<String>> {
    val asked = live.mapNotNull { row ->
        val child = childPlanLevel(row.ref.level) ?: return@mapNotNull null
        val level = facts[row.connectionId]?.levels?.get(child)?.hierarchyLevel ?: return@mapNotNull null
        Triple(row, row.connectionId, level)
    }
    val predicate = mirrorPredicate(asked.groupBy({ it.second to it.third }) { it.first.issueId }) ?: return emptyMap()
    val peer = connections.alias("peer")
    val linked = bindings.innerJoin(peer, { bindings.connectionId }, { peer[connections.id] }).select(bindings.id).where {
        (bindings.jiraIssueId eq JiraIssues.issueId) and bindings.active() and (peer[connections.markedAsDeleted] eq false) and
            (peer[connections.siteUrl] eq connections.siteUrl)
    }
    val open = JiraIssues.innerJoin(connections, { JiraIssues.connectionId }, { connections.id })
        .select(JiraIssues.connectionId, JiraIssues.parentIssueId, JiraIssues.issueId, JiraIssues.issueKey)
        .where { predicate and (JiraIssues.statusCategory neq DONE) and notExists(linked) }.toList()
        .sortedWith(compareBy({ it[JiraIssues.issueId].length }, { it[JiraIssues.issueId] }))
        .groupBy({ it[JiraIssues.connectionId].value to it[JiraIssues.parentIssueId] }) { it[JiraIssues.issueKey] }
    return asked.mapNotNull { (row, connection, _) -> open[connection to row.issueId]?.let { row.id to it } }.toMap()
}

/**
 * The names of the direct plan children (a program's projects, a project's milestones; active) of each bound PROGRAM or PROJECT that
 * no active binding of an active connection covers, when the connection's mapping maps the child plan level (else no coverage).
 * At most two statements (projects, milestones); ascending by id.
 */
internal suspend fun loadUnlinkedPlan(live: List<BindingRow>, facts: Map<UInt, ConnectionFacts>): Map<UInt, List<String>> {
    fun asked(level: JiraLevel) = live.filter { row ->
        row.ref.level == level && facts[row.connectionId]?.levels?.containsKey(childPlanLevel(level)) == true
    }
    val result = HashMap<UInt, List<String>>()
    val ofPrograms = asked(JiraLevel.PROGRAM)
    if (ofPrograms.isNotEmpty()) {
        val covered = coveredBy(bindings.projectId, projects.id)
        val byProgram = projects.select(projects.programId, projects.name)
            .where { (projects.programId inList ofPrograms.map { it.ref.id }.distinct()) and projects.active() and notExists(covered) }
            .orderBy(projects.id).toList().groupBy({ it[projects.programId].value }) { it[projects.name] }
        ofPrograms.forEach { row -> byProgram[row.ref.id]?.let { result[row.id] = it } }
    }
    val ofProjects = asked(JiraLevel.PROJECT)
    if (ofProjects.isNotEmpty()) {
        val covered = coveredBy(bindings.milestoneId, milestones.id)
        val byProject = milestones.select(milestones.projectId, milestones.name)
            .where { (milestones.projectId inList ofProjects.map { it.ref.id }.distinct()) and milestones.active() and notExists(covered) }
            .orderBy(milestones.id).toList().groupBy({ it[milestones.projectId].value }) { it[milestones.name] }
        ofProjects.forEach { row -> byProject[row.ref.id]?.let { result[row.id] = it } }
    }
    return result
}

/** The correlated subquery of the bindings covering a node: ACTIVE, on an ACTIVE connection, [nodeColumn] = the outer [outerId]. */
private fun coveredBy(nodeColumn: Column<EntityID<UInt>?>, outerId: Column<EntityID<UInt>>) =
    bindings.innerJoin(connections, { bindings.connectionId }, { connections.id }).select(bindings.id)
        .where { (nodeColumn eq outerId) and bindings.active() and connections.active() }

internal fun ChildRollup.toWire() = DeviationRollup(children, done, points?.toDouble(), observedAt)
