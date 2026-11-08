package ch.nokillswit.flow

import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.sync.SyncStatus
import kotlinx.serialization.Serializable

/*
 * The capacity deviation (1.6.0): where a bound team's capacity in the plan differs from what Flow would make it carry. It lives in
 * `flow/` with its OWN vocabulary: a Jira deviation is a binding on a plan NODE (`jira/DeviationView.kt`), a capacity deviation is a
 * team x sprint row, and `jira/` and `flow/` may not name each other (`PackageBoundaryTest`). Only the shared WARNING/INFO scale
 * ([DeviationSeverity]) is imported from `planning`. The rules are `CapacityDeviationKernels`, the document `flow-sync.md` "Deviations".
 */

/** The most teams one `GET /views/capacity-deviations` answers (Flow's own team cap; the real figure is below 100); then `truncated`. */
const val MAX_CAPACITY_DEVIATION_ITEMS = 1_000

/**
 * `CAPACITY_DIFFERS`: the plan's capacity over the days a sprint holds differs from Flow's by at least 0.5 man-days (WARNING when the
 * plan has more, INFO when less). `CAPACITY_MISSING`: no period is in force on any working day of the sprint (INFO). `TEAM_GONE`: the
 * bound Flow team is no longer in Flow's document (WARNING).
 */
@Serializable
enum class CapacityDeviationKind { CAPACITY_DIFFERS, CAPACITY_MISSING, TEAM_GONE }

/**
 * The evidence of one deviation, every member optional so one shape serves every kind (all null for `TEAM_GONE`; [planMd] and [gapMd]
 * null for `CAPACITY_MISSING`). [start]/[end] are the sprint's first and last day in the connection's zone (ISO dates), [effectiveFrom]
 * the first day the sprint holds (the import's claim), [workingDays] the working days from there to [end]. [flowMd] is what the import
 * would make the plan carry over those days, `round2(mdPerWeek x workingDays / 5)`; [flowTotalMd] is Flow's own total for the whole
 * sprint (it differs from [flowMd] for a fixed per-sprint figure that shares days with an earlier sprint). [planMd] is the plan's capacity
 * over the same days (the team view's arithmetic) and [gapMd] is `planMd - flowMd`, POSITIVE = the plan has more; all three rounded to
 * two decimals. It has NO default on purpose: the response `Json` does not encode defaults, so a defaulted member would vanish.
 */
@Serializable
data class CapacityDeviationDetail(
    val sprintId: Long?,
    val sprintName: String?,
    val start: String?,
    val end: String?,
    val effectiveFrom: String?,
    val workingDays: Int?,
    val flowMd: Double?,
    val flowTotalMd: Double?,
    val planMd: Double?,
    val gapMd: Double?,
)

@Serializable
data class CapacityDeviation(val kind: CapacityDeviationKind, val severity: DeviationSeverity, val detail: CapacityDeviationDetail)

/** An ACTIVE Flow connection, enabled or not. No base URL, token or zone; [teamsAt] is when it last mirrored a document. */
@Serializable
data class CapacityDeviationConnection(val id: UInt, val name: String, val enabled: Boolean, val status: SyncStatus, val teamsAt: Long?)

@Serializable
data class CapacityDeviationTeam(val id: UInt, val name: String)

@Serializable
data class CapacityDeviationFlowTeam(val id: Int, val name: String)

/**
 * One bound team with its deviations ([deviations] is never empty in a listed item; the filters narrow it). [observedAt] is when the mirror
 * last saw the Flow team (null when it is gone), [zone] the connection's IANA id the sprint dates are in.
 */
@Serializable
data class CapacityDeviationItem(
    val bindingId: UInt,
    val connectionId: UInt,
    val team: CapacityDeviationTeam,
    val flowTeam: CapacityDeviationFlowTeam,
    val observedAt: Long?,
    val zone: String,
    val deviations: List<CapacityDeviation>,
)

/**
 * Over the teams MATCHED (all that pass the filters), before the cap: [warnings] and [infos] count their rows, [gone] the `TEAM_GONE`
 * ones, [teams] the teams (it can exceed the items listed).
 */
@Serializable
data class CapacityDeviationTotals(val warnings: Int, val infos: Int, val gone: Int, val teams: Int)

/**
 * `GET /api/v1/views/capacity-deviations`: [asOf] is the UTC date of the read; [connections] every ACTIVE Flow connection (at most
 * [MAX_PANEL_CONNECTIONS]); [items] the first [MAX_CAPACITY_DEVIATION_ITEMS] teams, a team with a WARNING first. No `revision`: capacity
 * periods are team data and no plan revision moves with them.
 */
@Serializable
data class CapacityDeviationView(
    val asOf: String,
    val connections: List<CapacityDeviationConnection>,
    val totals: CapacityDeviationTotals,
    val items: List<CapacityDeviationItem>,
    val truncated: Boolean,
)
