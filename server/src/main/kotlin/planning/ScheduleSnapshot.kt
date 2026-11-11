package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.teams.TeamService
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.select
import java.time.LocalDate

/**
 * The rows one team's schedule proposal reads, loaded ONCE inside the caller's transaction: the working calendar, the team's
 * milestones with their order keys, its capacity periods, every active milestone and every active link of the plan. The proposal
 * (a read-only snapshot) and the batch accept's scope check (under the plan lock) both build it through [loadScheduleSnapshot] and take
 * the digests from it ([scopeDigests]), so the two hashes are one function over one row shape.
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

    /** The spans a proposal of [teamId] as of [asOf] gives on these very rows, by milestone id (the accept's look-again). */
    fun freshSpans(teamId: UInt, asOf: LocalDate): Map<UInt, DaySpan> = ScheduleKernels.propose(inputs(teamId, asOf)).spansAfter

    /** The two digests of [teamId]'s scope (`ScheduleScope.kt`): the structure and the Monday-Friday holidays. */
    fun scopeDigests(teamId: UInt) =
        ScopeDigests(structureDigest(scheduleScope(teamId, team, periods, plan, links)), holidaysDigest(calendar.offDayDates()))
}

/**
 * Loads the [ScheduleSnapshot] of [teamId]. [teamName] only fills the wire rows' name (the proposal's); the fingerprint reads no name
 * of the team, so the batch passes an empty one.
 */
internal suspend fun loadScheduleSnapshot(teamId: UInt, teamName: String): ScheduleSnapshot {
    val calendar = loadWorkingCalendar()
    val rows = teamMilestoneRows(teamId, teamName, positionsOf(teamId), calendar)
    val (_, periods) = teamCapacityRows(teamId)
    return ScheduleSnapshot(calendar, rows, periods, milestoneFacts().map { it.fact }, linkFacts())
}

private fun List<TeamMilestoneRow>.toScheduleItems() =
    map { TeamScheduleItem(it.view.id, it.view.projectId, it.span, it.estimate, it.key, it.view.pinned) }

/** One team of a [CrossTeamSnapshot]: its [name] (the wire's, and the team order's tiebreak), milestone [rows] and capacity [periods]. */
internal class TeamSnapshot(val teamId: UInt, val name: String, val rows: List<TeamMilestoneRow>, val periods: List<CapacityPeriod>) {
    val items = rows.toScheduleItems()

    /** The STORED spans of the team's scheduled milestones, by milestone id (an unscheduled one is absent). */
    val storedSpans: Map<UInt, DaySpan> = items.mapNotNull { item -> item.span?.let { item.id to it } }.toMap()
}

/**
 * The rows a cross-team run reads (1.8.0), loaded ONCE inside the caller's transaction: the working calendar, every run team's
 * [teams] (milestones with their order keys, capacity periods), and the plan-wide [plan] (every active milestone) and [links] (every
 * active link) read once, not once per team. The run (a read-only snapshot) and the accept's scope check (under the plan lock) both
 * build it through [loadCrossTeamSnapshot] and take the digests from it - one function over one row shape, like [ScheduleSnapshot].
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

    /** The stored spans of run team [teamId] (`TeamSnapshot.storedSpans`); fails closed for a team outside the run. */
    fun storedSpansOf(teamId: UInt): Map<UInt, DaySpan> = teams.first { it.teamId == teamId }.storedSpans

    /** The kernel's input for [ScheduleKernels.checkMany] (the check endpoint reads no `asOf`). */
    fun checkInputs() = CheckInputs(teams.map { TeamRun(it.teamId, it.name, it.items, it.periods) }, plan, links, calendar)

    /** The spans a run as of [asOf] gives on these very rows, by milestone id (a milestone is on one team): the accept's look-again. */
    fun freshSpans(asOf: LocalDate): Map<UInt, DaySpan> =
        ScheduleKernels.proposeMany(inputs(asOf)).byTeam.values.flatMap { it.spansAfter.entries }.associate { it.key to it.value }

    /** The run's two digests (`ScheduleScope.kt` [runScope]): "foreign" is every team OUTSIDE the run; the holidays are the calendar's. */
    fun scopeDigests() = ScopeDigests(
        structureDigest(
            runScope(
                teamsById = teams.associate { it.teamId to it.items },
                names = teams.associate { it.teamId to it.name },
                periodsById = teams.associate { it.teamId to it.periods },
                plan = plan,
                links = links,
            ),
        ),
        holidaysDigest(calendar.offDayDates()),
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
        val rows = teamMilestoneRows(teamId, name, positionsOf(teamId), calendar)
        TeamSnapshot(teamId, name, rows, teamCapacityRows(teamId).second)
    }
    return CrossTeamSnapshot(calendar, teams, milestoneFacts().map { it.fact }, linkFacts())
}

/**
 * The names of the ACTIVE teams among [ids] (a missing or deleted id is absent), read inside the caller's transaction: the run's
 * snapshot (one REPEATABLE READ read) and the accept under the plan lock (after every team's row was locked `FOR SHARE`, so a rename -
 * `TeamService.update` takes `FOR NO KEY UPDATE` - has either committed before or waits) both load the names through here.
 */
internal suspend fun activeTeamNames(ids: List<UInt>): Map<UInt, String> {
    val teams = TeamService.Teams
    return teams.select(teams.id, teams.name).where { (teams.id inList ids) and teams.active() }
        .toList().associate { it[teams.id].value to it[teams.name] }
}
