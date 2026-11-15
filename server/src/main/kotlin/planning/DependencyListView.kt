package ch.nokillswit.planning

import kotlinx.serialization.Serializable

/**
 * The most rows [DependencyListView.dependencies] holds. The sample plan has about 300 links; a plan nearer the graph's
 * "few thousand" is cut (violated rows first) and says so in `truncated`.
 */
const val MAX_DEPENDENCY_ROWS = 1_000

/**
 * `GET /api/v1/views/dependencies` (1.20.0) - every ACTIVE link of the plan whose two ends resolve, the ones that do not hold first,
 * in one document (the documented view-endpoint shape exception, `list-endpoints.md`). Every row is the project view's own item for
 * the link ([ProjectDependency]) without `critical` and `can`, so the list can never disagree with the page it links to, and
 * [totals] is Home's `plan.conflicts` function ([DependencyListKernels.totals]). [revision] is the PLAN's, read first
 * (informational: the view offers no write, so there is no `can`). The document is the same for every caller. [truncated] says
 * [dependencies] was cut at [MAX_DEPENDENCY_ROWS]; [totals] always count every link. No defaults: the response encoder writes every
 * member.
 */
@Serializable
data class DependencyListView(
    val revision: Long,
    val totals: DependencyListTotals,
    val dependencies: List<DependencyListRow>,
    val truncated: Boolean,
)

/**
 * The plan's link figures over EVERY row before the cut: [links] all of them, [violated] the ones whose check is
 * [DependencyStatus.VIOLATED] (Home's `plan.conflicts`, each link once, a link inside one project included) and [unscheduled] the
 * ones with an end without dates.
 */
@Serializable
data class DependencyListTotals(val links: Int, val violated: Int, val unscheduled: Int)

/** One link: the project view's [ProjectDependency] without `critical` and `can` - both ends resolved, the type, the lag and the check. */
@Serializable
data class DependencyListRow(
    val id: UInt,
    val predecessor: DependencyEndpoint,
    val successor: DependencyEndpoint,
    val type: DependencyType,
    val lagDays: Int,
    val check: DependencyCheck,
)
