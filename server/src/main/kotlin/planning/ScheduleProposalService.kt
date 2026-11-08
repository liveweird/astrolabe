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
 * [ScheduleKernels] and resolves the touched links' ends; the answer carries the [ScheduleSnapshot]'s `scopeHash`, which the batch accept
 * recomputes under its lock. No lock, nothing written, no revision bump, nothing stored (the client holds
 * the proposal and sends the accepted moves back to the batch with this `revision`). The team must be active (null = the route's 404).
 * Reads `Teams`, the plan tables, `RoadmapEntries`, the order tables, `CapacityPeriods`, `Dependencies` and `PublicHolidays`.
 */
class ScheduleProposalService(private val database: R2dbcDatabase) {
    suspend fun propose(teamId: UInt, asOf: LocalDate): ScheduleProposal? = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val teams = TeamService.Teams
        val teamName = teams.select(teams.name).where { (teams.id eq teamId) and teams.active() }.toList().singleOrNull()?.get(teams.name)
            ?: return@suspendTransaction null
        val snapshot = loadScheduleSnapshot(teamId, teamName)
        val inputs = snapshot.inputs(teamId, asOf)
        val result = ScheduleKernels.propose(inputs)
        val check = ScheduleKernels.postCheck(inputs, result)
        val lists = proposalLists(snapshot.rows, result, snapshot.calendar, asOf)
        ScheduleProposal(
            revision = revision,
            asOf = asOf.toString(),
            teamId = teamId,
            moves = lists.moves,
            unchanged = lists.unchanged,
            unplaced = lists.unplaced,
            weeks = check.weeks.map { it.toView() },
            weeksTruncated = check.weeksTruncated,
            dependencies = proposalLinks(inputs, check),
            pinned = lists.pinned,
            scopeHash = snapshot.scopeHash(teamId),
        )
    }

    /**
     * The links the proposal touches whose verdict is or was VIOLATED (before or after the moves), each end named ([resolveEndpoints],
     * slimmed to [ScheduleProposalEnd]), with its status before and its check after - in the kernel's order, violated-after first. A link
     * that is fine both times (or unscheduled, then fine) is dropped: the page prints nothing for it and the response is the size budget.
     */
    private suspend fun proposalLinks(inputs: ScheduleInputs, check: ScheduleProposalCheck): List<ScheduleProposalLink> {
        val reported = check.links.filter { it.before == DependencyStatus.VIOLATED || it.after.status == DependencyStatus.VIOLATED }
        if (reported.isEmpty()) return emptyList()
        val facts = inputs.links.associateBy { it.id }
        val ends = resolveEndpoints(reported.map { facts.getValue(it.linkId) }.flatMap { listOf(it.predecessor, it.successor) })
        return reported.map { linkCheck ->
            val link = facts.getValue(linkCheck.linkId)
            ScheduleProposalLink(
                id = link.id,
                predecessor = ends.getValue(link.predecessor).toProposalEnd(),
                successor = ends.getValue(link.successor).toProposalEnd(),
                type = link.type,
                lagDays = link.lagDays,
                before = linkCheck.before,
                check = linkCheck.after,
            )
        }
    }

    private fun DependencyEndpoint.toProposalEnd() =
        ScheduleProposalEnd(kind, id, name, projectName.takeIf { kind == EndpointKind.MILESTONE })
}
