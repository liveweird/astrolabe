package ch.nokillswit.jira

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

// The wire shapes of the Jira import (1.2): the preview (`POST …/connections/{id}/import-preview`) and the apply (`…/import`). The
// pure rules that fill them are `JiraImportKernels`; `JiraImportRoutes` serves both, the apply through `JiraImportApply`.

/** The most items one import carries, preview rows and apply items alike, IN TOTAL (not per level): the deviations view's cap. */
const val MAX_IMPORT_ITEMS = 2_000

/** The most project keys a scope may name (a connection holds at most as many). */
const val MAX_IMPORT_PROJECT_KEYS = 50

/** The shortest and the longest window of `filter.updatedWithinDays` (ten years): the day count reaches a JQL, so it is bounded twice. */
const val MIN_IMPORT_UPDATED_DAYS = 1
const val MAX_IMPORT_UPDATED_DAYS = 3_650

/** The most Jira issues one browse reads BY ID besides its search pages: the direct parents a filter left out (`JiraImportParents.kt`). */
const val MAX_IMPORT_PARENT_READS = 200

/**
 * What an import's browse leaves out (1.13.2): [excludeDone] the items whose Jira status category is Done, [updatedWithinDays] the items
 * Jira last updated longer ago than that many days ([MIN_IMPORT_UPDATED_DAYS]..[MAX_IMPORT_UPDATED_DAYS]; null = any age). Both off is
 * the same as no filter. Per request, never stored; only the import reads through it.
 */
@Serializable
data class JiraImportFilter(val excludeDone: Boolean = false, val updatedWithinDays: Int? = null)

/** The parent of an orphan project (`programId`) or orphan milestone (`projectId`), and the team of a milestone with no name match. */
@Serializable
data class JiraImportDefaults(val programId: UInt? = null, val projectId: UInt? = null, val teamId: UInt? = null)

/** The plan levels an import can start from (1.14): a milestone has no children, so `MILESTONE` does not decode (the central `400`). */
@Serializable
enum class JiraImportRootLevel { PROGRAM, PROJECT }

/**
 * The linked node a rooted import starts from (1.14): the [nodeId] of the program or project of [level], which must lie under the
 * picked work stream and hold an ACTIVE binding through this connection. The import then reads only what Jira lists under that item.
 */
@Serializable
data class JiraImportRoot(val level: JiraImportRootLevel, val nodeId: UInt) {
    /** The plan level, for the code that speaks [JiraLevel]. */
    fun jiraLevel(): JiraLevel = JiraLevel.valueOf(level.name)
}

/**
 * What both requests share: the picked [workStreamId] (every target lies under it), the [ownerPersonId] of every created program and
 * project, an optional subset of the connection's [projectKeys] (default: all), the [defaults] and whether Jira's milestone dates are
 * copied (only where the caller may schedule the milestone's team). The optional [filter] narrows what the browse reads (absent = all).
 * The optional [root] (1.14; absent = the whole scope) limits the import to what Jira lists under that linked node: its descendants
 * only, never a row for the root itself.
 */
@Serializable
data class JiraImportScope(
    val workStreamId: UInt,
    val ownerPersonId: UInt,
    val projectKeys: List<String>? = null,
    val defaults: JiraImportDefaults? = null,
    val copyDates: Boolean = true,
    val filter: JiraImportFilter? = null,
    val root: JiraImportRoot? = null,
)

/** What an item does: the preview proposes [CREATE], [BIND] (to an unbound same-name node) or [SKIP]; an apply expects the first two. */
@Serializable
enum class JiraImportAction { CREATE, BIND, SKIP }

/**
 * Why a row is not written. The first six are the kernel's own verdicts (a preview shows these; [PARENT_SKIPPED] = the Jira parent is in
 * the browse and its row is skipped, or, in an apply, left out by the client); [CHANGED] (what the client saw is no longer what the
 * site and the plan say) exists only in an apply.
 */
@Serializable
enum class JiraImportReason { ALREADY_BOUND, NO_PARENT, NAME_TAKEN, LEVEL_UNMAPPED, NO_TEAM, PARENT_SKIPPED, CHANGED }

/** Something worth a gray word beside a row; none of them stops a row. */
@Serializable
enum class JiraImportInfo {
    NAME_TRUNCATED, ESTIMATE_NOT_CONVERTED, DATES_NOT_COPIED, DATES_INVALID, NO_WORKING_DAY,

    /** A created PROJECT's Jira dates are not both set, or not a valid window: it is created without a target window (1.14). */
    TARGET_NOT_COPIED,

    /** The filter would have left this item out, but an item that is read sits under it: it was fetched by id and kept (1.13.2). */
    KEPT_AS_PARENT,

    /**
     * Its parent in Jira could not be read with the connection's account (Jira answered `404` by id: that it does not exist or is not
     * visible): 1.13.2.
     */
    PARENT_UNREADABLE,
}

/** Where a created row lands: an [EXISTING] node, the new node of another row ([NEW_ROW]) or the level's [DEFAULT] parent. */
@Serializable
enum class JiraImportParentKind { EXISTING, NEW_ROW, DEFAULT }

/** How a milestone's team was found: by [MATCHED] name, or the [DEFAULT] team (also what an apply override reads as). */
@Serializable
enum class JiraImportTeamRule { MATCHED, DEFAULT }

/**
 * The parent of a CREATE row (absent for a program: the picked stream). [rowJiraId] names the batch row the parent depends on (a
 * [NEW_ROW] parent, or the row of a BIND parent whose target node is [nodeId]); null when the parent stands on its own.
 */
@Serializable
data class JiraImportParent(
    val kind: JiraImportParentKind,
    val nodeId: UInt? = null,
    val nodeName: String,
    val rowJiraId: String? = null,
)

/**
 * The node a row is tied to: for BIND the unbound same-name node; for ALREADY_BOUND the holder - then [nodeKind] and [connectionId]
 * (the connection that holds the binding, possibly another one of the site) are set too.
 */
@Serializable
data class JiraImportTarget(val nodeId: UInt, val nodeName: String, val nodeKind: JiraLevel? = null, val connectionId: UInt? = null)

@Serializable
data class JiraImportTeam(val id: UInt, val name: String, val rule: JiraImportTeamRule)

/** One Jira item as the import sees it. Dates are ISO `YYYY-MM-DD`; [estimateMd] is a milestone's converted man-days. */
@Serializable
data class JiraImportItem(
    val jiraId: String,
    val issueKey: String?,
    val summary: String,
    val typeName: String? = null,
    val hierarchyLevel: Int? = null,
    val parentJiraId: String? = null,
    val parentIssueKey: String? = null,
    val level: JiraLevel,
    val action: JiraImportAction,
    val reason: JiraImportReason? = null,
    val parent: JiraImportParent? = null,
    val target: JiraImportTarget? = null,
    val name: String,
    val estimateMd: Double? = null,
    val startDate: String? = null,
    val endDate: String? = null,
    val team: JiraImportTeam? = null,
    val canSchedule: Boolean,
    val scheduled: Boolean,
    val infos: List<JiraImportInfo>,
) {
    /**
     * The Jira key of an unredacted row (every row the kernel and the apply handle). Only the route's redaction of a non-admin's preview
     * under an active filter withholds it ([issueKey] null, `JiraImportRedaction.kt`), after the guards and never on an apply's row.
     */
    fun key(): String = checkNotNull(issueKey) { "a row that is not redacted has its issue key" }
}

/**
 * [truncated]: what is shown is incomplete and cannot be imported (the user narrows `projectKeys` or the filter): more issues were in
 * scope than [MAX_IMPORT_ITEMS] (the parents read by id count), or more than [MAX_IMPORT_PARENT_READS] parents would have to be read.
 */
@Serializable
data class JiraImportTotals(val items: Int, val create: Int, val bind: Int, val skip: Int, val truncated: Boolean)

@Serializable
data class JiraImportPreview(
    val connectionId: UInt,
    val workStreamId: UInt,
    val revision: Long,
    val asOf: Long,
    val totals: JiraImportTotals,
    val unmatchedTeams: List<String>,
    val items: List<JiraImportItem>,
)

/** Where a CREATE row landed in the preview: the parent's [kind] and, for an existing node, its [nodeId] (null for a new row). */
@Serializable
data class JiraImportExpectedParent(val kind: JiraImportParentKind, val nodeId: UInt? = null)

/**
 * What the preview showed for a ticked row; a difference after the re-browse and the re-read under the lock is a `CHANGED` skip. For a
 * CREATE that includes the LANDING ([parent]: absent for a program, else the previewed parent): a row never silently lands under a
 * different parent than the one the user saw (for instance the default parent, because its Jira parent was bound elsewhere meanwhile).
 * For a milestone CREATE, [teamId] is the team the preview row showed (the name match or `defaults.teamId`, WITHOUT any override): a
 * changed Jira Team value must not move the milestone to another team unseen. An `overrides.teamId` is applied on top and is not compared.
 */
@Serializable
data class JiraImportExpected(
    val action: JiraImportAction,
    val level: JiraLevel,
    val parentJiraId: String? = null,
    val nodeId: UInt? = null,
    val parent: JiraImportExpectedParent? = null,
    val teamId: UInt? = null,
)

/**
 * A ticked row's own choices over the dialog's: [teamId] the team of a milestone CREATE, [ownerPersonId] (1.14) the owner of a PROGRAM or
 * PROJECT CREATE (instead of the scope's `ownerPersonId`). Each must name an ACTIVE team / person (`400`) wherever it is sent; on a row
 * it does not apply to (a milestone for the owner, a program or project for the team, a BIND, a skipped row) it is ignored.
 */
@Serializable
data class JiraImportOverrides(val teamId: UInt? = null, val ownerPersonId: UInt? = null)

@Serializable
data class JiraImportApplyItem(val jiraId: String, val expected: JiraImportExpected, val overrides: JiraImportOverrides? = null)

/** `POST …/{id}/import`: the [JiraImportScope] members (flat on the wire) plus the ticked [items]. */
@Serializable
data class JiraImportApplyRequest(
    val workStreamId: UInt,
    val ownerPersonId: UInt,
    val projectKeys: List<String>? = null,
    val defaults: JiraImportDefaults? = null,
    val copyDates: Boolean = true,
    val items: List<JiraImportApplyItem>,
    val filter: JiraImportFilter? = null,
    val root: JiraImportRoot? = null,
) {
    fun scope(): JiraImportScope = JiraImportScope(workStreamId, ownerPersonId, projectKeys, defaults, copyDates, filter, root)
}

@Serializable
data class JiraImportCreated(
    val jiraId: String,
    val issueKey: String,
    val kind: JiraLevel,
    val id: UInt,
    val bindingId: UInt,
    val name: String,
    val scheduled: Boolean,
)

@Serializable
data class JiraImportBound(val jiraId: String, val issueKey: String, val kind: JiraLevel, val id: UInt, val bindingId: UInt)

/** [issueKey] is null for an item the re-browse no longer finds. */
@Serializable
data class JiraImportSkipped(val jiraId: String, val issueKey: String? = null, val reason: JiraImportReason)

/** [revision] is the plan revision after the ONE bump, also when everything was skipped. */
@Serializable
data class JiraImportResult(
    val revision: Long,
    val created: List<JiraImportCreated>,
    val bound: List<JiraImportBound>,
    val skipped: List<JiraImportSkipped>,
)

/**
 * The project keys an import browses: [JiraImportScope.projectKeys] (1 to [MAX_IMPORT_PROJECT_KEYS], distinct, each one of the
 * connection's [connectionKeys]), else all of them; then the filter's day count, a whole number from [MIN_IMPORT_UPDATED_DAYS] to
 * [MAX_IMPORT_UPDATED_DAYS] (it reaches a query, so nothing else passes). A `400` on a client bug; the route AND the service both call it.
 */
fun validateImportScope(scope: JiraImportScope, connectionKeys: List<String>): List<String> {
    val keys = validatedKeys(scope, connectionKeys)
    val days = scope.filter?.updatedWithinDays
    if (days != null && days !in MIN_IMPORT_UPDATED_DAYS..MAX_IMPORT_UPDATED_DAYS) {
        throw BadRequestException("filter.updatedWithinDays must be between $MIN_IMPORT_UPDATED_DAYS and $MAX_IMPORT_UPDATED_DAYS")
    }
    return keys
}

private fun validatedKeys(scope: JiraImportScope, connectionKeys: List<String>): List<String> {
    val requested = scope.projectKeys ?: return connectionKeys
    if (requested.isEmpty() || requested.size > MAX_IMPORT_PROJECT_KEYS) {
        throw BadRequestException("projectKeys must list between 1 and $MAX_IMPORT_PROJECT_KEYS keys")
    }
    if (requested.toSet().size != requested.size) throw BadRequestException("projectKeys must name each key once")
    val outside = requested.firstOrNull { it !in connectionKeys }
    if (outside != null) throw BadRequestException("Project key ${outside.take(MAX_KEY_ECHO)} is not one of the connection's keys")
    return requested
}

private const val MAX_KEY_ECHO = 20

/**
 * The apply items' rules, for client bugs only (the recomputation under the lock is the real protection): between one and
 * [MAX_IMPORT_ITEMS] items, each Jira id a numeric id named once, `expected.action` CREATE or BIND (a BIND carries its node, a CREATE
 * does not), `expected.parentJiraId` a numeric id when present, `expected.parent` present for a CREATE below a program. A `400` names
 * the failing item's index.
 * It cannot see teams or people: the caller must ALSO refuse (`400`) an `overrides.teamId` that is not an active team and an
 * `overrides.ownerPersonId` that is not an active person before the kernel runs (the kernel's NO_TEAM for an unknown team override
 * is only a backstop).
 */
fun validateApplyItems(items: List<JiraImportApplyItem>) {
    if (items.isEmpty()) throw BadRequestException("items must list at least one Jira item")
    if (items.size > MAX_IMPORT_ITEMS) throw BadRequestException("items must list at most $MAX_IMPORT_ITEMS Jira items")
    if (items.map { it.jiraId }.toSet().size != items.size) throw BadRequestException("items must name each Jira item once")
    items.forEachIndexed { index, item ->
        val expected = item.expected
        val problem = when {
            !ISSUE_ID_PATTERN.matches(item.jiraId) -> "jiraId must be a numeric Jira issue id"
            expected.action == JiraImportAction.SKIP -> "expected.action must be CREATE or BIND"
            expected.action == JiraImportAction.BIND && expected.nodeId == null -> "expected.nodeId is required for a BIND"
            expected.action == JiraImportAction.CREATE && expected.nodeId != null -> "expected.nodeId must be absent for a CREATE"
            expected.parentJiraId != null && !ISSUE_ID_PATTERN.matches(expected.parentJiraId) ->
                "expected.parentJiraId must be a numeric Jira issue id"
            expected.action == JiraImportAction.CREATE && expected.level != JiraLevel.PROGRAM && expected.parent == null ->
                "expected.parent is required for a CREATE below a program"
            else -> null
        }
        if (problem != null) throw BadRequestException("items[$index]: $problem")
    }
}
