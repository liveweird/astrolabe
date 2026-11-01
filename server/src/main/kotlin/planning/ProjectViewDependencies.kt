package ch.nokillswit.planning

import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.active
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import java.time.LocalDate

/*
 * The dependency half of the project view (`GET /views/project/{id}`), split out of `ProjectViewService` to keep both small. Runs
 * INSIDE the view's read transaction, after the revision and the project's milestones.
 */

/**
 * Every ACTIVE link with an end in project [projectId] — the project itself or one of its [milestoneIds] — as the view's
 * [ProjectDependency]s: both ends resolved ([resolveEndpoints], so an end in another project carries that project's name, its team
 * and its dates, and a project end its derived span), the pure [DependencyKernels.check] and the caller's `can.delete`, ordered by
 * [DEPENDENCY_ORDER]. Reads, in the transaction: the links (one statement), the endpoints (a handful of `inList` statements per kind)
 * and, only when a successor lives in ANOTHER project, those projects' owner chains ([projectChains], one statement). An active link's
 * ends are active (the delete cascades keep it so), and so are their ancestors (a program or work stream with active children cannot
 * be deleted).
 */
internal suspend fun projectDependencies(
    projectId: UInt,
    milestoneIds: Collection<UInt>,
    projectChain: OwnerChain,
    actor: PlanActor,
): List<ProjectDependency> {
    val links = DependencyService.Dependencies
    val touching = linksTouching(milestoneIds, listOf(projectId)) ?: return emptyList()
    val rows = links.selectAll().where { links.active() and touching }.orderBy(links.id).toList()
    if (rows.isEmpty()) return emptyList()
    val ends = resolveEndpoints(rows.flatMap { listOf(it.predecessorRef(), it.successorRef()) })
    val externalSuccessors = rows.map { ends.getValue(it.successorRef()).projectId }.filter { it != projectId }
    val chains = projectChains(externalSuccessors) + (projectId to projectChain)
    return rows.map { row ->
        val predecessor = ends.getValue(row.predecessorRef())
        val successor = ends.getValue(row.successorRef())
        val type = DependencyType.valueOf(row[links.type])
        val lagDays = row[links.lagDays]
        ProjectDependency(
            id = row[links.id].value,
            predecessor = predecessor,
            successor = successor,
            type = type,
            lagDays = lagDays,
            check = DependencyKernels.check(type, lagDays, predecessor.span(), successor.span()),
            can = ProjectDependencyCan(
                delete = chains[successor.projectId]?.let { PlanPermissions.canDeleteDependency(actor, it) } ?: false,
            ),
        )
    }.sortedWith(DEPENDENCY_ORDER)
}

/**
 * The order of the view's `dependencies`, so that the top of the list IS the conflict list: VIOLATED first (the largest shortfall
 * first), then OK, then UNSCHEDULED; within a group by the successor's name, the predecessor's name (case-insensitive) and the id.
 */
internal val DEPENDENCY_ORDER: Comparator<ProjectDependency> = compareBy<ProjectDependency>(
    { it.check.status.rank() },
    { -(it.check.shortfallDays ?: 0) },
    { it.successor.name.lowercase() },
    { it.predecessor.name.lowercase() },
    { it.id },
)

private fun DependencyStatus.rank(): Int = when (this) {
    DependencyStatus.VIOLATED -> 0
    DependencyStatus.OK -> 1
    DependencyStatus.UNSCHEDULED -> 2
}

/** The end's dates as a [DaySpan], or null while it is unscheduled (a milestone without dates, a project with none scheduled). */
private fun DependencyEndpoint.span(): DaySpan? {
    val start = startDate ?: return null
    val end = endDate ?: return null
    return DaySpan(LocalDate.parse(start), LocalDate.parse(end))
}
