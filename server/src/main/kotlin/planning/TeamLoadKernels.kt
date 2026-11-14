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
     * count every team, whatever [maxRows] cuts.
     */
    fun view(
        revision: Long,
        teams: Collection<TeamLoadTeam>,
        counts: Map<UInt, TeamMilestoneCount>,
        teamWeeks: Map<UInt, List<WeekLoad>>,
        maxRows: Int,
    ): TeamLoadView {
        val ordered = teams.sortedWith(compareBy({ it.name.lowercase() }, { it.id }))
        val warnings = totals(teamWeeks)
        return TeamLoadView(
            revision = revision,
            totals = TeamLoadTotals(teams.size, warnings.overloadedTeams, warnings.wipExceededTeams),
            teams = ordered.take(maxRows).map { row(it, counts[it.id] ?: EMPTY, teamWeeks[it.id].orEmpty()) },
            truncated = ordered.size > maxRows,
        )
    }

    private fun row(team: TeamLoadTeam, count: TeamMilestoneCount, weeks: List<WeekLoad>) = TeamLoadRow(
        id = team.id,
        name = team.name,
        managerName = team.managerName,
        milestones = count.total,
        unscheduledMilestones = count.unscheduled,
        overloadedWeeks = weeks.count { it.overloaded },
        wipExceededWeeks = weeks.count { it.wipExceeded },
        weeksWithoutCapacity = weeks.count { it.capacity == null },
    )

    private val EMPTY = TeamMilestoneCount(0, 0)
}
