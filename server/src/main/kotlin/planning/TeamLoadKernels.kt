package ch.nokillswit.planning

/** An ACTIVE team as the team-load view sees it; [managerName] is null without an ACTIVE manager person. */
data class TeamLoadTeam(val id: UInt, val name: String, val managerName: String?)

/** A team's ACTIVE milestones: all of them and the ones without dates. */
data class TeamMilestoneCount(val total: Int, val unscheduled: Int)

/** How many teams have at least one overloaded week and at least one week over the WIP limit. */
data class TeamWarningCounts(val overloadedTeams: Int, val wipExceededTeams: Int)

/**
 * The team-load view as pure functions (no I/O, no clock; the [HomeKernels] idiom). Nothing is invented here: every figure counts the
 * team page's own [WeekLoad] flags, and [totals] is the ONE expression behind both this view's `totals` and Home's `plan` block, so
 * the two can never disagree. A team absent from the weeks map has no scheduled work and reads zeros.
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
     * count every team, whatever [maxRows] cuts. Each row also lists its warning weeks (overloaded or over the WIP limit, in the
     * loader's order: oldest first); [maxWarningWeeks] is the budget for the WHOLE document, handed out in row order - the row where
     * it runs out lists the first weeks that fit, later rows none - and [TeamLoadView.warningWeeksTruncated] is true when any listed
     * row left a week out. A team past [maxRows] is not a row and uses no budget; the counts never change with the cut.
     */
    fun view(
        revision: Long,
        teams: Collection<TeamLoadTeam>,
        counts: Map<UInt, TeamMilestoneCount>,
        teamWeeks: Map<UInt, List<WeekLoad>>,
        maxRows: Int,
        maxWarningWeeks: Int,
    ): TeamLoadView {
        val ordered = teams.sortedWith(compareBy({ it.name.lowercase() }, { it.id }))
        val warnings = totals(teamWeeks)
        var budget = maxWarningWeeks
        var cut = false
        val rows = ordered.take(maxRows).map { team ->
            val weeks = teamWeeks[team.id].orEmpty()
            val warning = weeks.filter { it.overloaded || it.wipExceeded }
            val listed = warning.take(budget.coerceAtLeast(0))
            budget -= listed.size
            if (listed.size < warning.size) cut = true
            row(team, counts[team.id] ?: EMPTY, weeks, listed)
        }
        return TeamLoadView(
            revision = revision,
            totals = TeamLoadTotals(teams.size, warnings.overloadedTeams, warnings.wipExceededTeams),
            teams = rows,
            truncated = ordered.size > maxRows,
            warningWeeksTruncated = cut,
        )
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
