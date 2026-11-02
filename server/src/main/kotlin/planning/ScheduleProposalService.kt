package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.teams.TeamService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.time.LocalDate

val ScheduleProposalServiceKey = AttributeKey<ScheduleProposalService>("ScheduleProposalService")

/**
 * The auto-proposal (`POST /teams/{id}/schedule-proposal`, v0.8.0): a COMPUTATION, not a mutation. ONE read-only REPEATABLE READ
 * transaction ([SNAPSHOT], the team view's protocol) takes the plan revision FIRST, then the working calendar and the rows - the team's
 * milestones with their order keys, its capacity periods, every active milestone and link of the plan - then runs the pure
 * [ScheduleKernels] and resolves the touched links' ends. No lock, nothing written, no revision bump, nothing stored (the client holds
 * the proposal and sends the accepted moves back to the batch with this `revision`). The team must be active (null = the route's 404).
 * Reads `Teams`, the plan tables, `RoadmapEntries`, the order tables, `CapacityPeriods`, `Dependencies` and `PublicHolidays`.
 */
class ScheduleProposalService(private val database: R2dbcDatabase) {
    suspend fun propose(teamId: UInt, asOf: LocalDate): ScheduleProposal? = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val calendar = loadWorkingCalendar()
        val teams = TeamService.Teams
        val teamName = teams.select(teams.name).where { (teams.id eq teamId) and teams.active() }.toList().singleOrNull()?.get(teams.name)
            ?: return@suspendTransaction null
        val rows = teamMilestoneRows(teamId, teamName, positionsOf(teamId))
        val (_, periods) = teamCapacityRows(teamId)
        val inputs = ScheduleInputs(
            asOf = asOf,
            teamId = teamId,
            team = rows.map { TeamScheduleItem(it.view.id, it.view.projectId, it.span, it.estimate, it.key) },
            periods = periods,
            plan = milestoneFacts().map { it.fact },
            links = linkFacts(),
            calendar = calendar,
        )
        val result = ScheduleKernels.propose(inputs)
        val check = ScheduleKernels.postCheck(inputs, result)
        val lists = proposalLists(rows, result, calendar)
        ScheduleProposal(
            revision = revision,
            asOf = asOf.toString(),
            teamId = teamId,
            moves = lists.moves,
            unchanged = lists.unchanged,
            unplaced = lists.unplaced,
            weeks = check.weeks.map { it.toView() },
            weeksTruncated = check.weeksTruncated,
            dependencies = proposalLinks(inputs, result, check),
        )
    }

    /**
     * The links the proposal touches with both ends resolved ([resolveEndpoints]) and re-dated to the state AFTER the moves, each with
     * its status before and its check after - in the kernel's order, violated-after first.
     */
    private suspend fun proposalLinks(
        inputs: ScheduleInputs,
        result: ScheduleProposalResult,
        check: ScheduleProposalCheck,
    ): List<ScheduleProposalLink> {
        if (check.links.isEmpty()) return emptyList()
        val facts = inputs.links.associateBy { it.id }
        val ends = resolveEndpoints(check.links.map { facts.getValue(it.linkId) }.flatMap { listOf(it.predecessor, it.successor) })
        val after = SpansAfter(inputs.team.map { it.id }.toSet(), result.spansAfter, projectSpansAfter(inputs, result.spansAfter))
        return check.links.map { linkCheck ->
            val link = facts.getValue(linkCheck.linkId)
            ScheduleProposalLink(
                id = link.id,
                predecessor = after.apply(link.predecessor, ends.getValue(link.predecessor)),
                successor = after.apply(link.successor, ends.getValue(link.successor)),
                type = link.type,
                lagDays = link.lagDays,
                before = linkCheck.before,
                check = linkCheck.after,
            )
        }
    }
}
