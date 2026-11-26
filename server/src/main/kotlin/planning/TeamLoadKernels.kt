package ch.nokillswit.planning

import java.time.LocalDate

/** An ACTIVE team as the team-load view sees it; [managerName] is null without an ACTIVE manager person. */
data class TeamLoadTeam(val id: UInt, val name: String, val managerName: String?)

/** A team's ACTIVE milestones: all of them and the ones without dates. */
data class TeamMilestoneCount(val total: Int, val unscheduled: Int)

/** How many teams have at least one overloaded week and at least one week over the WIP limit. */
data class TeamWarningCounts(val overloadedTeams: Int, val wipExceededTeams: Int)

/**
 * The team-load view as pure functions (no I/O, no clock - the current week is a parameter; the [HomeKernels] idiom). Nothing is
 * invented here: every figure counts the team page's own [WeekLoad] flags, and [totals] is the ONE expression behind both this view's
 * `totals` and Home's `plan` block, so the two can never disagree. A team absent from the weeks map has no scheduled work and reads zeros.
 */
object TeamLoadKernels {
    /**
     * The teams with at least one [WeekLoad.overloaded] week and at least one [WeekLoad.wipExceeded] week in [teamWeeks]. The map
     * must hold EVERY active team with scheduled work (the [teamWeeks] loader), never a subset, or the figures are short.
     */
    fun totals(teamWeeks: Map<UInt, List<WeekLoad>>): TeamWarningCounts = TeamWarningCounts(
        overloadedTeams = teamWeeks.values.count { weeks -> weeks.any { it.overloaded } },
        wipExceededTeams = teamWeeks.values.count { weeks -> weeks.any { it.wipExceeded } },
    )

    /**
     * The document over [teams] (every ACTIVE team): rows by lowercase name then id, cut at [maxRows] ([TeamLoadView.truncated] says
     * it was), each with the [counts] of its milestones and the three week counts of its [teamWeeks] entry. A week with a null
     * capacity is counted as "without capacity" and never as overloaded ([WeekLoad.overloaded] is false for it). [TeamLoadTotals]
     * count every team, whatever [maxRows] cuts (its `unscheduledMilestones` sums the same [counts] over every team in [teams]).
     * Each row also lists its warning weeks (overloaded or over the WIP limit, oldest first); [maxWarningWeeks] is the budget for
     * the WHOLE document, handed out by date ([handOutWarningWeeks], with [currentWeek], the Monday of the server's current week, as
     * the pivot) and [TeamLoadView.warningWeeksTruncated] is true when any listed row left a week out. A team past [maxRows] is not
     * a row and uses no budget; the counts never change with the cut.
     */
    fun view(
        revision: Long,
        teams: Collection<TeamLoadTeam>,
        counts: Map<UInt, TeamMilestoneCount>,
        teamWeeks: Map<UInt, List<WeekLoad>>,
        maxRows: Int,
        maxWarningWeeks: Int,
        currentWeek: LocalDate,
    ): TeamLoadView {
        val ordered = teams.sortedWith(compareBy({ it.name.lowercase() }, { it.id }))
        val warnings = totals(teamWeeks)
        val listedTeams = ordered.take(maxRows)
        val weeksOf = listedTeams.map { teamWeeks[it.id].orEmpty() }
        val warningOf = weeksOf.map { weeks -> weeks.filter { it.overloaded || it.wipExceeded } }
        val kept = handOutWarningWeeks(warningOf, maxWarningWeeks, currentWeek)
        val rows = listedTeams.mapIndexed { index, team -> row(team, counts[team.id] ?: EMPTY, weeksOf[index], kept[index]) }
        return TeamLoadView(
            revision = revision,
            currentWeekStart = currentWeek.toString(),
            totals = TeamLoadTotals(
                teams = teams.size,
                overloadedTeams = warnings.overloadedTeams,
                wipExceededTeams = warnings.wipExceededTeams,
                unscheduledMilestones = teams.sumOf { (counts[it.id] ?: EMPTY).unscheduled },
            ),
            teams = rows,
            truncated = ordered.size > maxRows,
            warningWeeksTruncated = kept.sumOf { it.size } < warningOf.sumOf { it.size },
        )
    }

    /**
     * The budget's hand-out: every week of every row in [warningByRow] is a candidate; the [budget] best are kept, the best being the
     * weeks on or after [currentWeek] (the nearest first), then the earlier ones (the latest first), a tie on the date going to the
     * earlier row. The result is parallel to [warningByRow], each row's kept weeks in their original (oldest first) order. A budget
     * at or below zero keeps nothing.
     */
    fun handOutWarningWeeks(warningByRow: List<List<WeekLoad>>, budget: Int, currentWeek: LocalDate): List<List<WeekLoad>> {
        val candidates = warningByRow.flatMapIndexed { row, weeks -> weeks.map { row to it } }
        val order = compareBy<Pair<Int, WeekLoad>> { (_, week) -> week.weekStart < currentWeek }
            .thenComparator { (_, a), (_, b) ->
                if (a.weekStart < currentWeek) b.weekStart.compareTo(a.weekStart) else a.weekStart.compareTo(b.weekStart)
            }
            .thenBy { it.first }
        val kept = candidates.sortedWith(order).take(budget.coerceAtLeast(0)).toHashSet()
        return warningByRow.mapIndexed { row, weeks -> weeks.filter { (row to it) in kept } }
    }

    private fun row(team: TeamLoadTeam, count: TeamMilestoneCount, weeks: List<WeekLoad>, listed: List<WeekLoad>) = TeamLoadRow(
        id = team.id,
        name = team.name,
        managerName = team.managerName,
        milestones = count.total,
        unscheduledMilestones = count.unscheduled,
        overloadedWeeks = weeks.count { it.overloaded },
        wipExceededWeeks = weeks.count { it.wipExceeded },
        weeksWithoutCapacity = weeks.count { it.capacity == null },
        warningWeeks = listed.map { it.toView() },
    )

    private val EMPTY = TeamMilestoneCount(0, 0)
}
