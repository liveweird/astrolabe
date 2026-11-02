package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import java.time.LocalDate

/**
 * The rows one team's schedule proposal reads, loaded ONCE inside the caller's transaction: the working calendar, the team's
 * milestones with their order keys, its capacity periods, every active milestone and every active link of the plan. The proposal
 * (a read-only snapshot) and the batch accept's scope check (under the plan lock) both build it through [loadScheduleSnapshot] and take
 * the [scopeHash] from it, so the two hashes are one function over one row shape.
 */
internal class ScheduleSnapshot(
    val calendar: WorkingCalendar,
    val rows: List<TeamMilestoneRow>,
    val periods: List<CapacityPeriod>,
    val plan: List<PlanMilestoneFact>,
    val links: List<PlanLinkFact>,
) {
    private val team = rows.map { TeamScheduleItem(it.view.id, it.view.projectId, it.span, it.estimate, it.key) }

    /** The kernel's input for [teamId] as of [asOf]. */
    fun inputs(teamId: UInt, asOf: LocalDate) = ScheduleInputs(
        asOf = asOf,
        teamId = teamId,
        team = team,
        periods = periods,
        plan = plan,
        links = links,
        calendar = calendar,
    )

    /** The scope fingerprint of [teamId] (`ScheduleScope.kt`). */
    fun scopeHash(teamId: UInt): String =
        scopeFingerprint(scheduleScope(teamId, team, periods, plan, links, calendar.offDayDates()))
}

/**
 * Loads the [ScheduleSnapshot] of [teamId]. [teamName] only fills the wire rows' name (the proposal's); the fingerprint reads no name
 * of the team, so the batch passes an empty one.
 */
internal suspend fun loadScheduleSnapshot(teamId: UInt, teamName: String): ScheduleSnapshot {
    val calendar = loadWorkingCalendar()
    val rows = teamMilestoneRows(teamId, teamName, positionsOf(teamId))
    val (_, periods) = teamCapacityRows(teamId)
    return ScheduleSnapshot(calendar, rows, periods, milestoneFacts().map { it.fact }, linkFacts())
}
