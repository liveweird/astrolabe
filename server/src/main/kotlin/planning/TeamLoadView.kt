package ch.nokillswit.planning

import kotlinx.serialization.Serializable

/** The most rows [TeamLoadView.teams] holds (the plan has about 15 teams, so nothing is cut in practice). */
const val MAX_TEAM_LOAD_ROWS = 200

/**
 * The most warning weeks the whole document lists across its rows (handed out by date, the weeks from
 * [TeamLoadView.currentWeekStart] on first; [TeamLoadView.warningWeeksTruncated]).
 */
const val MAX_TEAM_LOAD_WARNING_WEEKS = 2_000

/**
 * `GET /api/v1/views/team-load` (1.19.0) - every active team with its milestones and the weeks its page flags, in one document (the
 * documented view-endpoint shape exception, `list-endpoints.md`). Every figure is the team page's own ([TeamLoadKernels]), so the list
 * can never disagree with the page it links to or with Home's two team counts. [revision] is the PLAN's, read first (informational:
 * the view offers no write, so there is no `can`). The document is the same for every caller. [truncated] says [teams] was cut at
 * [MAX_TEAM_LOAD_ROWS]; [totals] always count every team. Each row lists its warning weeks (1.21.0), at most
 * [MAX_TEAM_LOAD_WARNING_WEEKS] in all; [warningWeeksTruncated] says a week was left out (counts and [totals] never change with it).
 * [currentWeekStart] (1.22.0) is the Monday of the SERVER's current week in UTC (never the caller's clock): the budget goes to the
 * weeks on or after it first, the nearest first, whatever the team's place, then to the earlier ones, the latest first
 * ([TeamLoadKernels.view]). No defaults: the response encoder writes every member.
 */
@Serializable
data class TeamLoadView(
    val revision: Long,
    val currentWeekStart: String,
    val totals: TeamLoadTotals,
    val teams: List<TeamLoadRow>,
    val truncated: Boolean,
    val warningWeeksTruncated: Boolean,
)

/**
 * The plan's team figures: [teams] is every ACTIVE team; [overloadedTeams] and [wipExceededTeams] are how many teams have at least one
 * week the team page flags overloaded, and over the WIP limit - Home's `plan.overloadedTeams` and `plan.wipExceededTeams`, the same
 * expression ([TeamLoadKernels.totals]) over the same loader. [unscheduledMilestones] (1.30.0) is the plan-wide count of ACTIVE milestones
 * without dates - the rows' own [TeamLoadRow.unscheduledMilestones] summed over every active team (from the counts the view already
 * loads), so it is Home's `plan.unscheduledMilestones` whatever the rows cut.
 */
@Serializable
data class TeamLoadTotals(val teams: Int, val overloadedTeams: Int, val wipExceededTeams: Int, val unscheduledMilestones: Int)

/**
 * One team: its stored [description] (null when unset; the Teams page shows it under the name), its ACTIVE manager's id and name
 * ([managerPersonId] and [managerName] are null without one, a deleted person included),
 * its ACTIVE [milestones] and the [unscheduledMilestones] among them (the team page's two trays summed and the Unscheduled tray), and its weeks - [overloadedWeeks]
 * and [wipExceededWeeks] are the team page's two orange badges, [weeksWithoutCapacity] the weeks of its load with no capacity period
 * in force (never flagged overloaded, so a team with work and no capacity would otherwise look fine). [warningWeeks] are the weeks
 * behind the first two counts - the team page's own overloaded or over-WIP weeks, oldest first (the team view's [WeekLoadView], never
 * with a Flow flag), as many as the document's budget kept of this row.
 */
@Serializable
data class TeamLoadRow(
    val id: UInt,
    val name: String,
    val description: String?,
    val managerPersonId: UInt?,
    val managerName: String?,
    val milestones: Int,
    val unscheduledMilestones: Int,
    val overloadedWeeks: Int,
    val wipExceededWeeks: Int,
    val weeksWithoutCapacity: Int,
    val warningWeeks: List<WeekLoadView>,
)
