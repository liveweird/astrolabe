package ch.nokillswit.jira

import ch.nokillswit.planning.DeviationDetail
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.sync.SyncLastRun
import ch.nokillswit.sync.SyncStatus
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
 * `GET /bindings`; the name, the very existence of a binding-less one and (1.10) the connection's [projectKeys] (the import's scope
 * options for a work-stream owner) are new to a non-admin. Never the email, the token or the mapping. [mappingOk] is false when the
 * connection's effective mapping cannot be resolved against its discovery (unset discovery, an unreadable or stale document): no level
 * or estimate comparison is made for its bindings, and a bind through it would be refused with a `409`.
 */
@Serializable
data class DeviationConnection(
    val id: UInt,
    val name: String,
    val siteUrl: String,
    val enabled: Boolean,
    val projectKeys: List<String>,
    val mappingOk: Boolean,
    /** The newest run, also [SyncStatus.lastRun] (kept for the page's existing readers). */
    val lastRun: SyncLastRun?,
    /** The connection's derived sync state (1.3): operational and secret-free, the same disclosure class as [lastRun]. */
    val status: SyncStatus,
)

/**
 * Across the bindings matching every filter but the acknowledgement state (`acknowledged`, and the default that hides acknowledged
 * ones), before the cap: [warnings] and [infos] count the OPEN LINES (a deviation without a current acknowledgement, 1.12) of the
 * open bindings, [gone] the open bindings whose issue is gone, and [acknowledged] the BINDINGS with at least one currently
 * acknowledged line, so both are known whatever the list shows (on `acknowledged=true` the open counts are what the Open filter would
 * list). [bindings] is the exception: the number of bindings the list actually answers.
 */
@Serializable
data class DeviationTotals(val warnings: Int, val infos: Int, val bindings: Int, val gone: Int, val acknowledged: Int)

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
 * first observation). Dates are ISO; [estimate] is in [estimateUnit]; [observedAt] is epoch millis. [rollup] is always present, null =
 * none.
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
    val rollup: DeviationRollup?,
)

/**
 * An epic's children as the census holds them (1.4): the non-sub-task issues at the child level under the bound issue. [points] is the
 * discovery's story-points sum, never converted (null when no child carries a value); [observedAt] the newest observation of any child.
 * Null on [DeviationJira] while the issue has no mirrored child, and for every non-milestone binding.
 */
@Serializable
data class DeviationRollup(val children: Int, val done: Int, val points: Double?, val observedAt: Long)

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

/**
 * One binding. [fingerprint] is the SHA-256 of the binding's FULL deviation list ([fingerprintOf]; it does not depend on the filters,
 * so `ESTIMATE_NOT_COMPARABLE` counts even where [deviations] hides it): the token a client echoes to acknowledge (the stored
 * acknowledgements are per line, [DeviationLine.acknowledgement]). [acknowledgement] is DEPRECATED since 1.12 (the old web UI's
 * summary, kept for readers that predate the lines): null while no listed line is stamped, else the newest stamp among the listed
 * lines, `current` = every listed line is currently acknowledged. [can] is the caller's right to acknowledge it.
 */
@Serializable
data class DeviationItem(
    val bindingId: UInt,
    val connectionId: UInt,
    val level: JiraLevel,
    val node: DeviationNode,
    val jira: DeviationJira,
    val plan: DeviationPlan,
    val deviations: List<DeviationLine>,
    val fingerprint: String,
    val acknowledgement: DeviationAcknowledgement?,
    val can: DeviationCan,
)

/**
 * One listed deviation with the state of its own acknowledgement (1.12): the [Deviation]'s members (flat, so the wire shape of a line
 * is the old one plus one member) and [acknowledgement], null until someone acknowledges THIS line; its `current` is whether the stored
 * per-line fingerprint still equals the line's now (false = acknowledged, then changed: the line is open again).
 */
@Serializable
data class DeviationLine(
    val kind: DeviationKind,
    val severity: DeviationSeverity,
    val detail: DeviationDetail,
    val acknowledgement: DeviationAcknowledgement?,
)

/**
 * An acknowledgement as stored: [at] epoch millis, [by] the acknowledging login's active person's name else its display name (never
 * the email; null once the login is deleted); [current] is false when the acknowledged line changed since.
 */
@Serializable
data class DeviationAcknowledgement(val at: Long, val by: String?, val current: Boolean)

/**
 * What the caller may do with the item: [acknowledge] is the node's owner chain, ADMIN or - on a milestone - its team's manager
 * (false for an anonymous computation).
 */
@Serializable
data class DeviationCan(val acknowledge: Boolean)

/**
 * The query. [all] true lists bindings with no deviation too; absent it defaults to true when [projectId] or [teamId] is given (the
 * per-project and per-team chips ask "is it linked, and how"), else false. [kind] and [severity] keep the bindings that have such a
 * deviation, whatever [all] says. `ESTIMATE_NOT_COMPARABLE` is listed only on an EXPLICIT `all=true` or when [kind] names it: the
 * implied [all] of a chip does not switch the estimate noise on. [acknowledged] true lists the bindings whose acknowledgement is
 * CURRENT, false the ones without a current one; absent, the default lists OPEN bindings (deviating and not currently acknowledged),
 * and an [includeAll] listing keeps every state.
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
    val acknowledged: Boolean? = null,
) {
    /** Whether bindings without a deviation (and acknowledged ones) are listed. */
    val includeAll: Boolean get() = all ?: (projectId != null || teamId != null)
}
