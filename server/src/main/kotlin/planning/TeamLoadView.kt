package ch.nokillswit.planning

import kotlinx.serialization.Serializable

/** The most rows [TeamLoadView.teams] holds (the plan has about 15 teams, so nothing is cut in practice). */
const val MAX_TEAM_LOAD_ROWS = 200

/**
 * `GET /api/v1/views/team-load` (1.19.0) - every active team with its milestones and the weeks its page flags, in one document (the
 * documented view-endpoint shape exception, `list-endpoints.md`). Every figure is the team page's own ([TeamLoadKernels]), so the list
 * can never disagree with the page it links to or with Home's two team counts. [revision] is the PLAN's, read first (informational:
 * the view offers no write, so there is no `can`). The document is the same for every caller. [truncated] says [teams] was cut at
 * [MAX_TEAM_LOAD_ROWS]; [totals] always count every team. No defaults: the response encoder writes every member.
 */
@Serializable
data class TeamLoadView(val revision: Long, val totals: TeamLoadTotals, val teams: List<TeamLoadRow>, val truncated: Boolean)

/**
 * The plan's team figures: [teams] is every ACTIVE team; [overloadedTeams] and [wipExceededTeams] are how many teams have at least one
 * week the team page flags overloaded, and over the WIP limit - Home's `plan.overloadedTeams` and `plan.wipExceededTeams`, the same
 * expression ([TeamLoadKernels.totals]) over the same loader.
 */
@Serializable
data class TeamLoadTotals(val teams: Int, val overloadedTeams: Int, val wipExceededTeams: Int)

/**
 * One team: its ACTIVE manager's name ([managerName] is null without one, a deleted person included), its ACTIVE [milestones] and the
 * [unscheduledMilestones] among them (the team page's two trays summed and the Unscheduled tray), and its weeks - [overloadedWeeks]
 * and [wipExceededWeeks] are the team page's two orange badges, [weeksWithoutCapacity] the weeks of its load with no capacity period
 * in force (never flagged overloaded, so a team with work and no capacity would otherwise look fine).
 */
@Serializable
data class TeamLoadRow(
    val id: UInt,
    val name: String,
    val managerName: String?,
    val milestones: Int,
    val unscheduledMilestones: Int,
    val overloadedWeeks: Int,
    val wipExceededWeeks: Int,
    val weeksWithoutCapacity: Int,
)
