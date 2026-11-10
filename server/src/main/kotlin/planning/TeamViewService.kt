package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.people.PersonService
import ch.nokillswit.teams.TeamService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val TeamViewServiceKey = AttributeKey<TeamViewService>("TeamViewService")

/**
 * One team's schedule, capacity and load (`GET /views/team/{id}`): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the project
 * view's protocol) that takes the revision FIRST and the rows after, then runs the pure kernels - [effectiveOrder] over the team's
 * ACTIVE milestones (the team's own positions, read from those milestones, never by iterating the order table), [weeklyLoad] over the
 * scheduled ones for the window of [loadWindow] against the stored capacity periods, and [DependencyKernels.check] per link
 * ([viewDependencies]), and reads the critical path of each project the team works on ([loadCriticalPaths], 1.7: slack toward the
 * milestone's OWN project's end; a link is critical when it lies on the chain of one of those projects). The team must be active
 * (null = the route's 404). Reads `Teams`, `People`, the plan tables, `RoadmapEntries`,
 * the order tables, `CapacityPeriods`, `Dependencies` and `PublicHolidays` (the working calendar, [loadWorkingCalendar], read right
 * after the revision) and writes nothing (`persistence.md`). The milestones' Jira links and flags (1.3) and the team's Flow capacity
 * flag and marked weeks (1.9) come from [external] inside the same snapshot, after the calendar: through the seam the Flow source reads
 * `FlowConnections`, `FlowTeamBindings`, `CapacityPeriods`, the Flow mirror (`flow_teams`, `flow_sprints`), the Flow capacity
 * acknowledgements and the acknowledging logins' names (`persistence.md` matrix).
 */
class TeamViewService(private val database: R2dbcDatabase, private val external: ExternalFlagSource = NoExternalFlags) {
    suspend fun view(
        teamId: UInt, actor: PlanActor,
        baselineId: UInt? = null,
    ): TeamView? = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val calendar = loadWorkingCalendar()
        val teams = TeamService.Teams
        val team = teams.selectAll().where { (teams.id eq teamId) and teams.active() }.toList().singleOrNull()
            ?: return@suspendTransaction null
        // The view's own rules first (a gone team is the route's 404 for every caller), then the baseline question.
        val baseline = baselineId?.let { requireActiveBaseline(it) }
        val managerId = team[teams.managerPersonId]?.value
        val managerName = managerId?.let { activePersonName(it) }

        val positions = positionsOf(teamId)
        val rawRows = teamMilestoneRows(teamId, team[teams.name], positions, calendar)
        // The critical path (1.7): each milestone's slack toward its OWN project's end, one graph build for every project of the team.
        val paths = loadCriticalPaths(rawRows.map { it.view.projectId }.distinct(), calendar)
        val rows = rawRows.map { it.withCriticalPath(paths[it.view.projectId]) }
        val criticalLinks = paths.values.flatMapTo(HashSet()) { it.criticalDependencies }
        // Inside the snapshot, after the calendar: each milestone's Jira link and flags (1.3), the team's own flag and marked days (1.9);
        // no project rows here.
        val outside = external.flagsInTransaction(
            ExternalFlagRequest(projectIds = emptyList(), milestoneIds = rows.map { it.view.id }, calendar = calendar, teamId = teamId),
        )
        val teamOutside = outside.team(teamId)
        // The stored order, read FROM the active milestones (a stale row of a gone one never shows), in stored position order.
        val listed = rows.filter { it.key.customPosition != null }.sortedBy { it.key.customPosition }.map { it.view.id }
        val (periodRows, periods) = teamCapacityRows(teamId)
        val (scheduled, unscheduled) = effectiveOrder(rows) { it.key }.partition { it.span != null }
        val items = scheduled.map { LoadItem(checkNotNull(it.span), it.estimate) }
        val window = loadWindow(items.map { it.span })

        TeamView(
            revision = revision,
            team = TeamViewTeam(
                id = teamId,
                name = team[teams.name],
                description = team[teams.description],
                managerPersonId = managerId.takeIf { managerName != null },
                managerName = managerName,
                createdAt = team[teams.createdAt],
                updatedAt = team[teams.updatedAt],
                can = TeamViewCan(
                    schedule = PlanPermissions.canSchedule(actor, teamId),
                    editCapacity = PlanPermissions.canEditCapacity(actor, teamId),
                    editOrder = PlanPermissions.canEditTeamOrder(actor, teamId),
                ),
                flags = teamOutside.flags,
            ),
            order = TeamViewOrder(custom = listed.isNotEmpty(), revision = orderRevisionOf(teamId), milestoneIds = listed),
            capacity = TeamViewCapacity(periodRows),
            weeks = weeklyLoad(items, periods, window?.span, calendar).map { it.toView() }.withFlaggedRanges(teamOutside.ranges),
            weeksTruncated = window?.truncated ?: false,
            scheduled = scheduled.map { it.view.withExternal(outside.milestone(it.view.id)) },
            unscheduled = unscheduled.map { it.view.withExternal(outside.milestone(it.view.id)) },
            dependencies = viewDependencies(rows.map { it.view.id }, emptyList(), emptyMap(), actor, calendar)
                .map { it.copy(critical = it.id in criticalLinks) },
            idleGaps = idleGapViewsOf(items.map { it.span }, calendar),
            jiraSites = outside.sites,
            baseline = baseline?.let {
                teamBaseline(it, teamId, team[teams.name], rows.map { r -> r.live() }, calendar)
            },
        )
    }

    /** The name of an ACTIVE person; null for a soft-deleted one (the team then answers no manager, as `TeamService.read` does). */
    private suspend fun activePersonName(id: UInt): String? {
        val people = PersonService.People
        return people.select(people.name).where { (people.id eq id) and people.active() }.toList().singleOrNull()?.get(people.name)
    }
}
