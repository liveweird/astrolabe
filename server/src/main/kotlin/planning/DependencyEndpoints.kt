package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.teams.TeamService
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*

/*
 * The dependency reads that run INSIDE the caller's transaction (the service opens it): the endpoints a link names, resolved in
 * batches, and the active plan's time-point graph. Nothing here locks; the create runs both under the plan lock.
 */

/**
 * Resolves [refs] to their wire form in one pass per kind: a milestone's own name, project and team (names read WITHOUT an `active()`
 * filter — an active milestone's project and team are always active, the `ownerNames` reasoning) and its dates; a project's name
 * and its DERIVED span (the earliest start to the latest end over its scheduled ACTIVE milestones, [SpanKernels.derivedSpan], null
 * while none is scheduled — never the target window). Every ref must name an existing row (the caller has checked it is active).
 */
internal suspend fun resolveEndpoints(refs: Collection<EndpointRef>): Map<EndpointRef, DependencyEndpoint> {
    val milestoneIds = refs.filter { it.kind == EndpointKind.MILESTONE }.map { it.id }.distinct()
    val projectIds = refs.filter { it.kind == EndpointKind.PROJECT }.map { it.id }.distinct()
    return milestoneEndpoints(milestoneIds) + projectEndpoints(projectIds)
}

private suspend fun milestoneEndpoints(ids: List<UInt>): Map<EndpointRef, DependencyEndpoint> {
    if (ids.isEmpty()) return emptyMap()
    val milestones = MilestoneService.Milestones
    val projects = ProjectService.Projects
    val teams = TeamService.Teams
    return milestones.innerJoin(projects, { milestones.projectId }, { projects.id })
        .innerJoin(teams, { milestones.teamId }, { teams.id })
        .select(
            milestones.id, milestones.name, milestones.projectId, projects.name, milestones.teamId, teams.name,
            milestones.startDate, milestones.endDate,
        )
        .where { milestones.id inList ids }
        .toList()
        .associate { row ->
            val id = row[milestones.id].value
            EndpointRef(EndpointKind.MILESTONE, id) to DependencyEndpoint(
                kind = EndpointKind.MILESTONE,
                id = id,
                name = row[milestones.name],
                projectId = row[milestones.projectId].value,
                projectName = row[projects.name],
                teamId = row[milestones.teamId].value,
                teamName = row[teams.name],
                startDate = row[milestones.startDate]?.toString(),
                endDate = row[milestones.endDate]?.toString(),
            )
        }
}

private suspend fun projectEndpoints(ids: List<UInt>): Map<EndpointRef, DependencyEndpoint> {
    if (ids.isEmpty()) return emptyMap()
    val milestones = MilestoneService.Milestones
    val projects = ProjectService.Projects
    val spans = milestones.select(milestones.projectId, milestones.startDate, milestones.endDate)
        .where { (milestones.projectId inList ids) and milestones.active() and milestones.startDate.isNotNull() }
        .toList()
        .groupBy({ it[milestones.projectId].value }) { row ->
            val start = checkNotNull(row[milestones.startDate])
            DaySpan(start, checkNotNull(row[milestones.endDate]))
        }
        .mapValues { (_, own) -> SpanKernels.derivedSpan(own) }
    return projects.select(projects.id, projects.name)
        .where { projects.id inList ids }
        .toList()
        .associate { row ->
            val id = row[projects.id].value
            val span = spans[id]
            EndpointRef(EndpointKind.PROJECT, id) to DependencyEndpoint(
                kind = EndpointKind.PROJECT,
                id = id,
                name = row[projects.name],
                projectId = id,
                projectName = row[projects.name],
                teamId = null,
                teamName = null,
                startDate = span?.start?.toString(),
                endDate = span?.end?.toString(),
            )
        }
}

/**
 * The time-point graph of the whole ACTIVE plan: every active milestone's containment in its project and every active dependency.
 * Two statements, bounded by the plan's scale (about 1,000 milestones and a few thousand links). An active milestone's project is
 * always active (the project delete cascades its milestones), so no ancestor join is needed.
 */
internal suspend fun loadTimePointGraph(): TimePointGraph {
    val milestones = MilestoneService.Milestones
    val links = DependencyService.Dependencies
    val containment = milestones.select(milestones.id, milestones.projectId)
        .where { milestones.active() }
        .orderBy(milestones.id)
        .toList()
        .map { ContainmentLink(it[milestones.id].value, it[milestones.projectId].value) }
    val dependencies = links.selectAll()
        .where { links.active() }
        .orderBy(links.id)
        .toList()
        .map { DependencyEdge(it.predecessorRef(), it.successorRef(), DependencyType.valueOf(it[links.type])) }
    return TimePointGraph.build(containment, dependencies)
}
