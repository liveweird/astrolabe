package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar

/*
 * The pure assembly of the proposal document from the kernel's answer (`ScheduleProposalService` loads the rows and resolves the link
 * ends; nothing here reads a database or a clock). The kernel decides every date; this only names, counts and shifts them.
 */

/** The three lists of the proposal that come from the kernel's placements and verdicts. */
internal class ProposalLists(val moves: List<ScheduleProposalMove>, val unchanged: List<UInt>, val unplaced: List<ScheduleProposalUnplaced>)

/**
 * [ScheduleProposalResult.placements] split into the milestones that MOVE and the ones that keep their dates ([Placement.to] ==
 * [Placement.from]), in the team's effective order, and [ScheduleProposalResult.unplaced] named. A scheduled milestone that could not
 * be placed is listed as unplaced only: it keeps its stored dates.
 */
internal fun proposalLists(rows: List<TeamMilestoneRow>, result: ScheduleProposalResult, calendar: WorkingCalendar): ProposalLists {
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
    return ProposalLists(moves, unchanged, unplaced)
}

private fun DaySpan.toDateSpan() = DateSpan(start.toString(), end.toString())

/** Working days from the current effective start to the proposed start: later is positive, earlier negative. */
private fun shiftInWorkingDays(from: DaySpan, to: DaySpan, calendar: WorkingCalendar): Int =
    (calendar.workingDayIndex(to.start) - calendar.workingDayIndex(calendar.nextWorkingDayOnOrAfter(from.start))).toInt()

/**
 * The dates of the team's milestones and of every project AFTER accepting every move: what the reported links' ends read. A milestone
 * of the team that is absent from [milestones] has no dates; a milestone of another team keeps the stored dates its resolved end carries.
 */
internal class SpansAfter(
    private val teamMilestoneIds: Set<UInt>,
    private val milestones: Map<UInt, DaySpan>,
    private val projects: Map<UInt, DaySpan>,
) {
    /** [end] (the resolved end named by [ref], stored dates) re-dated to the state after the proposal. */
    fun apply(ref: EndpointRef, end: DependencyEndpoint): DependencyEndpoint = when {
        ref.kind == EndpointKind.PROJECT -> end.datedAs(projects[ref.id])
        ref.id in teamMilestoneIds -> end.datedAs(milestones[ref.id])
        else -> end
    }

    private fun DependencyEndpoint.datedAs(span: DaySpan?) = copy(startDate = span?.start?.toString(), endDate = span?.end?.toString())
}

/**
 * The project spans after the run: the derived span (earliest start to latest end, [RoadmapKernels.projectSpans]) over the OTHER teams'
 * stored dates plus this team's [spansAfter].
 */
internal fun projectSpansAfter(inputs: ScheduleInputs, spansAfter: Map<UInt, DaySpan>): Map<UInt, DaySpan> {
    val others = inputs.plan.filter { it.teamId != inputs.teamId }
    val team = inputs.team.map { PlanMilestoneFact(it.id, it.projectId, inputs.teamId, spansAfter[it.id]) }
    return RoadmapKernels.projectSpans(others + team)
}
