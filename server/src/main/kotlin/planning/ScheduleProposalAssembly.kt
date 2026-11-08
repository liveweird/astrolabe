package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import java.time.LocalDate

/*
 * The pure assembly of the proposal document from the kernel's answer (`ScheduleProposalService` loads the rows and resolves the link
 * ends; nothing here reads a database or a clock). The kernel decides every date; this only names, counts and shifts them.
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
 * be placed is listed as unplaced only: it keeps its stored dates. [ProposalLists.pinned] names the team's milestones the run kept on
 * their dates ONLY because they are pinned (V25: a pinned, dated milestone starting after [asOf]; one already in progress is fixed
 * anyway), in the team's effective order.
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
