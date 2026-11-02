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
 * ([viewDependencies]). The team must be active (null = the route's 404). Reads `Teams`, `People`, the plan tables, `RoadmapEntries`,
 * the order tables, `CapacityPeriods`, `Dependencies` and `PublicHolidays` (the working calendar, [loadWorkingCalendar], read right
 * after the revision) and writes nothing (`persistence.md`).
 */
class TeamViewService(private val database: R2dbcDatabase) {
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
        val rows = teamMilestoneRows(teamId, team[teams.name], positions)
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
            ),
            order = TeamViewOrder(custom = listed.isNotEmpty(), revision = orderRevisionOf(teamId), milestoneIds = listed),
            capacity = TeamViewCapacity(periodRows),
            weeks = weeklyLoad(items, periods, window?.span, calendar).map { it.toView() },
            weeksTruncated = window?.truncated ?: false,
            scheduled = scheduled.map { it.view },
            unscheduled = unscheduled.map { it.view },
            dependencies = viewDependencies(rows.map { it.view.id }, emptyList(), emptyMap(), actor, calendar),
            idleGaps = idleGapViewsOf(items.map { it.span }, calendar),
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
