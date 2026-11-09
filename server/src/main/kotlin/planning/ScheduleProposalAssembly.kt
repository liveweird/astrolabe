package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import java.time.LocalDate

/*
 * The assembly of the proposal document from the kernel's answer, shared by the per-team proposal (`ScheduleProposalService`) and the
 * cross-team run (`CrossTeamProposalService`): both load the rows and call this. Nothing here reads a clock, and the only read is the
 * link ends' names ([proposalLinks], inside the caller's transaction). The kernel decides every date; this only names, counts and
 * shifts them.
 */

/** The three lists of the proposal that come from the kernel's placements and verdicts. */
internal class ProposalLists(
    val moves: List<ScheduleProposalMove>,
    val unchanged: List<UInt>,
    val unplaced: List<ScheduleProposalUnplaced>,
    val pinned: List<UInt>,
)

/**
 * [ScheduleProposalResult.placements] split into the milestones that MOVE and the ones that keep their dates ([Placement.to] ==
 * [Placement.from]), in the team's effective order, and [ScheduleProposalResult.unplaced] named. A scheduled milestone that could not
 * be placed is listed as unplaced only: it keeps its stored dates. [ProposalLists.pinned] names the team's pinned milestones that start
 * after [asOf]: fixed by their pin (V25; some would have stayed anyway, e.g. for want of a place; one already in progress is fixed
 * regardless and not listed), in the team's effective order.
 */
internal fun proposalLists(
    rows: List<TeamMilestoneRow>,
    result: ScheduleProposalResult,
    calendar: WorkingCalendar,
    asOf: LocalDate,
): ProposalLists {
    val byId = rows.associateBy { it.view.id }
    val moves = ArrayList<ScheduleProposalMove>()
    val unchanged = ArrayList<UInt>()
    for (placement in result.placements) {
        if (placement.to == placement.from) {
            unchanged += placement.milestoneId
            continue
        }
        val milestone = byId.getValue(placement.milestoneId).view
        moves += ScheduleProposalMove(
            milestoneId = milestone.id,
            name = milestone.name,
            projectId = milestone.projectId,
            projectName = milestone.projectName,
            estimateMd = milestone.estimateMd,
            from = placement.from?.toDateSpan(),
            to = placement.to.toDateSpan(),
            workingDays = calendar.workingDaysBetween(placement.to.start, placement.to.end).toInt(),
            shiftDays = placement.from?.let { shiftInWorkingDays(it, placement.to, calendar) },
        )
    }
    val unplaced = result.unplaced.map { verdict ->
        val milestone = byId.getValue(verdict.milestoneId).view
        ScheduleProposalUnplaced(milestone.id, milestone.name, milestone.projectId, milestone.projectName, verdict.reason)
    }
    val pinned = effectiveOrder(rows) { it.key }.filter { it.view.pinned && it.span != null && it.span.start > asOf }.map { it.view.id }
    return ProposalLists(moves, unchanged, unplaced, pinned)
}

internal fun DaySpan.toDateSpan() = DateSpan(start.toString(), end.toString())

/**
 * The links of [check] whose verdict is or was VIOLATED (before or after the moves), each end named ([resolveEndpoints], slimmed to
 * [ScheduleProposalEnd]), with its status before and its check after - in the kernel's order, violated-after first. A link that is fine
 * both times (or unscheduled, then fine) is dropped: the page prints nothing for it and the response is the size budget. [links] is
 * the plan's link facts (every id of [check] is among them). Runs inside the caller's transaction.
 */
internal suspend fun proposalLinks(links: Collection<PlanLinkFact>, check: ScheduleProposalCheck): List<ScheduleProposalLink> {
    val reported = check.links.filter { it.before == DependencyStatus.VIOLATED || it.after.status == DependencyStatus.VIOLATED }
    if (reported.isEmpty()) return emptyList()
    val facts = links.associateBy { it.id }
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
