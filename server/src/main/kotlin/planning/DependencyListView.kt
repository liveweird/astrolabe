package ch.nokillswit.planning

import kotlinx.serialization.Serializable

/**
 * The most rows [DependencyListView.dependencies] holds. The sample plan has about 300 links; a plan nearer the graph's
 * "few thousand" is cut (violated rows first) and says so in `truncated`.
 */
const val MAX_DEPENDENCY_ROWS = 1_000

/**
 * `GET /api/v1/views/dependencies` (1.20.0, names once since 1.21.0) - every ACTIVE link of the plan whose two ends resolve, the ones
 * that do not hold first, in one document (the documented view-endpoint shape exception, `list-endpoints.md`). A row names its two
 * ends by kind and id ([EndpointRef]) and carries the project view's own type, lag and check ([DependencyCheck]); the names are
 * stated ONCE in [projects], [teams] and [milestones], which hold exactly what the LISTED rows name (by ascending id; a row the cap
 * cut contributes nothing), so every reference resolves and the list can never disagree with the page it links to. [totals] is
 * Home's `plan.conflicts` function ([DependencyListKernels.totals]). [revision] is the PLAN's, read first (informational: the view
 * offers no write, so there is no document-level `can`). Since 1.22.0 each row carries the CALLER's own `can` ([DependencyListRow.can]);
 * nothing else of the document differs between callers. [truncated] says [dependencies] was cut at
 * [MAX_DEPENDENCY_ROWS]; [totals] always count every link. No defaults: the response encoder writes every member.
 */
@Serializable
data class DependencyListView(
    val revision: Long,
    val totals: DependencyListTotals,
    val projects: List<DependencyListProject>,
    val teams: List<RoadmapTeam>,
    val milestones: List<DependencyListMilestone>,
    val dependencies: List<DependencyListRow>,
    val truncated: Boolean,
)

/** A project a listed row names, as an end or as the project of a named milestone. */
@Serializable
data class DependencyListProject(val id: UInt, val name: String)

/** A milestone a listed row names as an end: its own name, its project (in [DependencyListView.projects]) and its team (in `teams`). */
@Serializable
data class DependencyListMilestone(val id: UInt, val name: String, val projectId: UInt, val teamId: UInt)

/**
 * The plan's link figures over EVERY row before the cut: [links] all of them, [violated] the ones whose check is
 * [DependencyStatus.VIOLATED] (Home's `plan.conflicts`, each link once, a link inside one project included) and [unscheduled] the
 * ones with an end without dates.
 */
@Serializable
data class DependencyListTotals(val links: Int, val violated: Int, val unscheduled: Int)

/**
 * One link: the project view's [ProjectDependency] without `critical`, its two ends as plain [EndpointRef]s (resolved through the
 * document's lists), the type, the lag, the check and (1.22.0) the CALLER's [can]: the project view's own member, from the owner chain
 * of the SUCCESSOR's project and [PlanPermissions], the very rule of `PUT` and `DELETE /dependencies/{id}`. No default: the encoder
 * writes every member.
 */
@Serializable
data class DependencyListRow(
    val id: UInt,
    val predecessor: EndpointRef,
    val successor: EndpointRef,
    val type: DependencyType,
    val lagDays: Int,
    val check: DependencyCheck,
    val can: ProjectDependencyCan,
)
