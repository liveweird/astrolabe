package ch.nokillswit.jira

import ch.nokillswit.sync.SyncOutcome
import kotlinx.serialization.Serializable

/** The most items one `GET /views/deviations` answers (≈ 350 B a row, so ≤ 700 KB); beyond it `truncated` is true. */
const val MAX_DEVIATION_ITEMS = 2000

/**
 * `GET /api/v1/views/deviations` - where the plan and the Jira items bound to it disagree (the view-endpoint shape exception, bounded by
 * the plan's scale: at most one binding per node, [MAX_DEVIATION_ITEMS] rows). [revision] is the PLAN's revision, read before the rows
 * (this view moves none); [asOf] is the UTC date `PROGRESS_MISMATCH` measured against. [connections] lists EVERY active connection -
 * bindings or not, enabled or not (`enabled` says which) - because a non-admin owner's bind dialog gets its connection id here (the
 * registry is ADMIN only) and offers only the enabled ones.
 * [totals] count the FILTERED bindings BEFORE the cap, so they stay exact when [truncated] (`bindings` counts only deviating
 * bindings unless `all` applies); [items] are the first
 * [MAX_DEVIATION_ITEMS] of them: bindings with a WARNING first, then by work stream, program, project, level (program, project,
 * milestone), name (all case-insensitive) and binding id.
 */
@Serializable
data class DeviationView(
    val revision: Long,
    val asOf: String,
    val connections: List<DeviationConnection>,
    val totals: DeviationTotals,
    val items: List<DeviationItem>,
    val truncated: Boolean,
)

/**
 * An active connection. A bind goes through an ENABLED one only; a disabled one is listed because its bindings are (they still block
 * their node and issue, so they must stay seen and unlinkable). The id and site of a bound connection were already visible through
 * `GET /bindings`; the name, and the very existence of a binding-less one, are new to a non-admin. Never the email, the token, the
 * project keys or the mapping. [mappingOk] is false when the connection's effective mapping cannot be
 * resolved against its discovery (unset discovery, an unreadable or stale document): no level or estimate comparison is made for its
 * bindings, and a bind through it would be refused with a `409`.
 */
@Serializable
data class DeviationConnection(
    val id: UInt,
    val name: String,
    val siteUrl: String,
    val enabled: Boolean,
    val mappingOk: Boolean,
    val lastRun: DeviationLastRun?,
)

/**
 * The connection's newest run. A run left unfinished by a crash keeps `finishedAt = null` until the next claim abandons it (1.1 has no
 * scheduler), so [running] is the page's rule: true only for an unfinished run younger than `sync.maxRunMinutes`. An unfinished run that
 * is not [running] was interrupted.
 */
@Serializable
data class DeviationLastRun(
    val id: UInt,
    val startedAt: Long,
    val finishedAt: Long?,
    val outcome: SyncOutcome?,
    val errorCode: String?,
    val running: Boolean,
)

/** Across the filtered bindings, before the cap: the deviations by severity, the bindings and the bindings whose issue is gone. */
@Serializable
data class DeviationTotals(val warnings: Int, val infos: Int, val bindings: Int, val gone: Int)

/**
 * The bound node and where it sits: the id and name of every level from the work stream down to the node itself (a program has no
 * project; only a milestone has a team).
 */
@Serializable
data class DeviationNode(
    val kind: JiraLevel,
    val id: UInt,
    val name: String,
    val projectId: UInt?,
    val projectName: String?,
    val programId: UInt?,
    val programName: String?,
    val workStreamId: UInt,
    val workStreamName: String,
    val teamId: UInt?,
    val teamName: String?,
)

/**
 * Jira's side as last observed. Everything after [url] is null for a binding never observed (none exists normally: the bind writes the
 * first observation). Dates are ISO; [estimate] is in [estimateUnit]; [observedAt] is epoch millis.
 */
@Serializable
data class DeviationJira(
    val issueId: String,
    val key: String,
    val url: String,
    val summary: String?,
    val typeName: String?,
    val hierarchyLevel: Int?,
    val statusName: String?,
    val statusCategory: JiraStatusCategory?,
    val start: String?,
    val end: String?,
    val estimate: Double?,
    val estimateUnit: JiraEstimateUnit?,
    val parentKey: String?,
    val teamName: String?,
    val observedAt: Long?,
    val gone: Boolean,
)

/**
 * The plan's side. [start] and [end] are the dates the deviations compared: a milestone's stored dates, a project's or program's derived
 * span (so equal to [spanStart] and [spanEnd], which are null for a milestone); [targetStart] and [targetEnd] are a project's window;
 * [estimateMd] a milestone's man-days.
 */
@Serializable
data class DeviationPlan(
    val start: String?,
    val end: String?,
    val estimateMd: Double?,
    val targetStart: String?,
    val targetEnd: String?,
    val spanStart: String?,
    val spanEnd: String?,
)

@Serializable
data class DeviationItem(
    val bindingId: UInt,
    val connectionId: UInt,
    val level: JiraLevel,
    val node: DeviationNode,
    val jira: DeviationJira,
    val plan: DeviationPlan,
    val deviations: List<Deviation>,
)

/**
 * The query. [all] true lists bindings with no deviation too; absent it defaults to true when [projectId] or [teamId] is given (the
 * per-project and per-team chips ask "is it linked, and how"), else false. [kind] and [severity] keep the bindings that have such a
 * deviation, whatever [all] says. `ESTIMATE_NOT_COMPARABLE` is listed only on an EXPLICIT `all=true` or when [kind] names it: the
 * implied [all] of a chip does not switch the estimate noise on.
 */
data class DeviationFilter(
    val connectionId: UInt? = null,
    val level: JiraLevel? = null,
    val severity: DeviationSeverity? = null,
    val kind: DeviationKind? = null,
    val workStreamId: UInt? = null,
    val programId: UInt? = null,
    val projectId: UInt? = null,
    val teamId: UInt? = null,
    val all: Boolean? = null,
) {
    /** Whether bindings without a deviation are listed. */
    val includeAll: Boolean get() = all ?: (projectId != null || teamId != null)
}
