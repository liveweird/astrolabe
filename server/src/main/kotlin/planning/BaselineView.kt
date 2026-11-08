@file:OptIn(ExperimentalSerializationApi::class)

package ch.nokillswit.planning

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

/**
 * `GET /api/v1/views/baseline/{id}` - the comparison of one baseline with the plan NOW, in one document (the documented view-endpoint
 * shape exception, `list-endpoints.md`; bounded by the plan's scale: at most about 100 project rows and 1,000 milestone rows). [revision]
 * is the plan revision read FIRST; the baseline equals the plan at [BaselineResponse.planRevision], so a view at that revision shows
 * no movement. [projects] is the union of the baseline's and the live projects; [milestones] lists ONLY the rows that changed (any
 * kind but UNCHANGED, or a different estimate): the unchanged rows are in [totals] and the projects' `counts`.
 *
 * With `?against=N` (1.7) "now" is a second baseline instead of the live plan: [baseline] stays "then" (the path id), [against] is the
 * "now" baseline's header, the `live`/`rankNow`/`span` fields read that baseline's frozen rows, and ADDED means "in [against] only",
 * REMOVED "in [baseline] only". [against] is absent (not null) without the parameter, so the document is byte-identical to before.
 */
@Serializable
data class BaselineView(
    val revision: Long,
    val baseline: BaselineResponse,
    val totals: BaselineViewTotals,
    val projects: List<BaselineViewProject>,
    val milestones: List<BaselineViewMilestone>,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val against: BaselineResponse? = null,
)

/** The counts over EVERY milestone row (changed or not) and every project row of the comparison. */
@Serializable
data class BaselineViewTotals(val milestones: MovementTotalsView, val projects: MovementTotalsView)

/**
 * A project of the comparison: the live names when it exists now, else the frozen ones; [rankThen]/[rankNow] its rank positions
 * (null = unranked or absent on that side); [baselineSpan]/[span] its derived span then and now (null = nothing scheduled or absent
 * on that side). [movement] is ADDED for a project newer than the baseline and REMOVED for one gone; [counts] the movement counts
 * over its milestones (a removed project: its removed milestones).
 */
@Serializable
data class BaselineViewProject(
    val projectId: UInt,
    val name: String,
    val programName: String,
    val workStreamName: String,
    val rankThen: Int?,
    val rankNow: Int?,
    val baselineSpan: DateSpan?,
    val span: DateSpan?,
    val movement: MovementView,
    val counts: MovementTotalsView,
)

/** A milestone side: its dates (null = unscheduled) and estimate. */
@Serializable
data class BaselineFigures(val start: String?, val end: String?, val estimateMd: Double)

/**
 * A changed milestone: [frozen] is null for one added since the baseline, [live] for one removed; the name, project and team are the
 * live ones when it exists now. The rows follow the projects' order, then start (live, else frozen; undated last), end, name, id.
 */
@Serializable
data class BaselineViewMilestone(
    val milestoneId: UInt,
    val name: String,
    val projectId: UInt,
    val teamId: UInt,
    val teamName: String,
    val frozen: BaselineFigures?,
    val live: BaselineFigures?,
    val movement: MovementView,
)
