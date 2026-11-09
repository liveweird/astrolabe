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
    private val team = rows.toScheduleItems()

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

private fun List<TeamMilestoneRow>.toScheduleItems() =
    map { TeamScheduleItem(it.view.id, it.view.projectId, it.span, it.estimate, it.key, it.view.pinned) }

/** One team of a [CrossTeamSnapshot]: its [name] (the wire's, and the team order's tiebreak), milestone [rows] and capacity [periods]. */
internal class TeamSnapshot(val teamId: UInt, val name: String, val rows: List<TeamMilestoneRow>, val periods: List<CapacityPeriod>) {
    val items = rows.toScheduleItems()
}

/**
 * The rows a cross-team run reads (1.8.0), loaded ONCE inside the caller's transaction: the working calendar, every run team's
 * [teams] (milestones with their order keys, capacity periods), and the plan-wide [plan] (every active milestone) and [links] (every
 * active link) read once, not once per team. The run (a read-only snapshot) and the accept's scope check (under the plan lock) both
 * build it through [loadCrossTeamSnapshot] and take the [scopeHash] from it - one function over one row shape, like [ScheduleSnapshot].
 */
internal class CrossTeamSnapshot(
    val calendar: WorkingCalendar,
    val teams: List<TeamSnapshot>,
    val plan: List<PlanMilestoneFact>,
    val links: List<PlanLinkFact>,
) {
    /** The kernel's input for the whole run as of [asOf]. */
    fun inputs(asOf: LocalDate) = MultiTeamInputs(
        asOf = asOf,
        teams = teams.map { TeamRun(it.teamId, it.name, it.items, it.periods) },
        plan = plan,
        links = links,
        calendar = calendar,
    )

    /** The run's scope fingerprint (`ScheduleScope.kt` [runScope]): "foreign" is every team OUTSIDE the run. */
    fun scopeHash(): String = scopeFingerprint(
        runScope(
            teamsById = teams.associate { it.teamId to it.items },
            names = teams.associate { it.teamId to it.name },
            periodsById = teams.associate { it.teamId to it.periods },
            plan = plan,
            links = links,
            holidays = calendar.offDayDates(),
        ),
    )
}

/**
 * Loads the [CrossTeamSnapshot] of the teams in [teamNames] (id -> name). The names are REAL on every path: they fill the wire rows,
 * break the team order's ties AND are in the fingerprint (a rename changes the placement), so a caller recomputing the hash under a
 * lock must pass the current names, never blanks. The caller has already established that every id is an ACTIVE team.
 */
internal suspend fun loadCrossTeamSnapshot(teamNames: Map<UInt, String>): CrossTeamSnapshot {
    val calendar = loadWorkingCalendar()
    val teams = teamNames.entries.sortedBy { it.key }.map { (teamId, name) ->
        val rows = teamMilestoneRows(teamId, name, positionsOf(teamId))
        TeamSnapshot(teamId, name, rows, teamCapacityRows(teamId).second)
    }
    return CrossTeamSnapshot(calendar, teams, milestoneFacts().map { it.fact }, linkFacts())
}
