package ch.nokillswit.planning

import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.people.PersonService
import ch.nokillswit.teams.TeamCapacityService
import ch.nokillswit.teams.TeamService
import ch.nokillswit.teams.activeCapacityPeriods
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*

/*
 * The loaders of the team load: the weeks of every team with scheduled work (shared by the home view and the team-load view, so the two
 * team counts are one loader's), the milestone counts and the teams with their managers. Each runs INSIDE the calling view's read
 * transaction and nowhere else; none writes.
 */

/**
 * The weeks of EVERY active team with scheduled work, the team page's rule, for every caller: ONE select of the scheduled milestones'
 * spans and estimates grouped by team (reads `milestones`), ONE select of those teams' ACTIVE capacity periods (reads
 * `team_capacity_periods`: the team view's ordering, [teamCapacityRows]'s values), then one [weeklyLoad] run per team with work against
 * [calendar]. A team without scheduled work has no entry; with none at all the second select is skipped.
 */
internal suspend fun teamWeeks(calendar: WorkingCalendar): Map<UInt, List<WeekLoad>> {
    val milestones = MilestoneService.Milestones
    val scheduled = milestones.select(milestones.teamId, milestones.startDate, milestones.endDate, milestones.estimateMd)
        .where { milestones.active() and milestones.startDate.isNotNull() and milestones.endDate.isNotNull() }
        .toList()
        .groupBy({ it[milestones.teamId].value }) { row ->
            val start = checkNotNull(row[milestones.startDate])
            val end = checkNotNull(row[milestones.endDate])
            LoadItem(DaySpan(start, end), row[milestones.estimateMd])
        }
    if (scheduled.isEmpty()) return emptyMap()
    val periods = TeamCapacityService.CapacityPeriods
    val byTeam = activeCapacityPeriods(scheduled.keys)
        .toList()
        .groupBy({ it[periods.teamId].value }) {
            CapacityPeriod(it[periods.effectiveFrom], it[periods.mdPerWeek], it[periods.wipLimit])
        }
    return scheduled.mapValues { (teamId, items) ->
        weeklyLoad(items, byTeam[teamId].orEmpty(), loadWindow(items.map { it.span })?.span, calendar)
    }
}

/**
 * Every team's ACTIVE milestones and the ones without dates, ONE select of `milestones` (the team and the start date; the pair of dates
 * is both-or-neither, `ck_milestones_schedule`) grouped in Kotlin. The team page's own predicate: the team's ACTIVE milestones.
 */
internal suspend fun teamMilestoneCounts(): Map<UInt, TeamMilestoneCount> {
    val milestones = MilestoneService.Milestones
    return milestones.select(milestones.teamId, milestones.startDate).where { milestones.active() }.toList()
        .groupBy({ it[milestones.teamId].value }) { it[milestones.startDate] == null }
        .mapValues { (_, undated) -> TeamMilestoneCount(undated.size, undated.count { it }) }
}

/**
 * The ACTIVE teams, each with its manager's name: ONE select of `teams` LEFT-joined to `people`. The person's deleted flag is read with
 * the name and turned into a null name here - a `WHERE` on the person would drop the team itself - the rule of the team view
 * (`TeamViewService`: a team whose manager's person is gone answers no manager).
 */
internal suspend fun activeTeamsWithManagers(): List<TeamLoadTeam> {
    val teams = TeamService.Teams
    val people = PersonService.People
    return teams.join(people, JoinType.LEFT, onColumn = teams.managerPersonId, otherColumn = people.id)
        .select(teams.id, teams.name, people.name, people.markedAsDeleted)
        .where { teams.active() }
        .toList()
        .map { row ->
            val manager = row.getOrNull(people.name)?.takeIf { row.getOrNull(people.markedAsDeleted) == false }
            TeamLoadTeam(row[teams.id].value, row[teams.name], manager)
        }
}
