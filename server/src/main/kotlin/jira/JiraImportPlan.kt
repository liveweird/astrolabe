package ch.nokillswit.jira

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.MilestoneSpan
import ch.nokillswit.planning.TargetWindow
import java.math.BigDecimal

// The input and output types of `JiraImportKernels.plan`. Plain data: the service (C4 preview, C5 apply) builds the input from the
// browse and from rows read in one snapshot (preview) or under the plan lock (apply), and turns the output into the wire shapes.

/**
 * One browsed issue. [observation] must have been read through the mapping at the issue's OWN plan level (its dates and estimate come
 * from that level's fields). [parentTypeId] and [parentTypeHierarchyLevel] are the issue type of its Jira `parent` member
 * (`fields.parent.fields.issuetype`): `JiraObservation` does not keep them, and the level of a parent that is not itself browsed
 * is resolved from them through the discovery, never from `hierarchyLevel` alone (a site may omit it on the type object).
 * [keptAsParent] (1.13.2): the import's filter would have left it out, and it was fetched by id because an item that is read sits under
 * it. [parentUnreadable]: its direct Jira parent was read by id and the connection could not read it; the planner skips it `NO_PARENT`,
 * never under a default parent.
 */
data class ImportBrowsedIssue(
    val observation: JiraObservation,
    val parentTypeId: String? = null,
    val parentTypeHierarchyLevel: Int? = null,
    val keptAsParent: Boolean = false,
    val parentUnreadable: Boolean = false,
)

/**
 * The issues one browse produced; [truncated] = the browse stopped at the cap (or at the bound of the parents it reads by id), so more
 * were in scope. A truncated browse cannot tell a parent that was cut away from a genuine orphan, so the caller (the apply) MUST refuse
 * it with a `400` before any write.
 */
class ImportBrowse(val issues: List<ImportBrowsedIssue>, val truncated: Boolean = false)

/** An active plan node under the picked stream. [bound] = it carries an active Jira binding (any connection). */
class ImportPlanNode(val id: UInt, val parentId: UInt?, val name: String, val bound: Boolean)

/** Every active node under the picked work stream: programs (parent = none), projects (parent = program), milestones (parent = project). */
class ImportTree(
    val programs: List<ImportPlanNode>,
    val projects: List<ImportPlanNode>,
    val milestones: List<ImportPlanNode>,
)

/**
 * An active binding of a browsed issue (or of a Jira parent outside the browse) on ANY active connection of the site (D1). [live] =
 * its node and every ancestor are active; a dead holder never blocks - the apply releases it.
 */
class ImportHolder(
    val bindingId: UInt,
    val connectionId: UInt,
    val issueId: String,
    val level: JiraLevel,
    val nodeId: UInt,
    val nodeName: String,
    val live: Boolean,
)

class ImportTeam(val id: UInt, val name: String)

/**
 * The plan side, read in one snapshot. [allProgramNames] are the names of ALL active programs (program names are globally unique).
 * [holders] must cover every browsed issue AND every Jira parent named by a browsed issue (a parent outside the browse can be bound too).
 * [canScheduleTeamIds] = the teams the caller may schedule, null = every team (ADMIN).
 */
class ImportSnapshot(
    val tree: ImportTree,
    val allProgramNames: Collection<String>,
    val holders: List<ImportHolder>,
    val teams: List<ImportTeam>,
    val canScheduleTeamIds: Set<UInt>?,
    val calendar: WorkingCalendar,
)

/** The node a rooted import (1.14) starts from: the kernel lands a row only under it (`OUTSIDE_ROOT` otherwise); never a milestone. */
class ImportRootNode(val level: JiraLevel, val nodeId: UInt)

/**
 * REQUIREMENT ON THE CALLER (preview route and apply): refuse a `defaults.teamId` or an `overrides.teamId` that is not an ACTIVE team
 * with a `400` BEFORE the kernel runs (and under the lock in an apply). The kernel's own handling of an unknown override (the row
 * becomes NO_TEAM, never another team) is only a backstop, not the contract.
 */
class ImportInput(
    val browse: ImportBrowse,
    val mapping: JiraMapping,
    val discovery: JiraDiscovery,
    val snapshot: ImportSnapshot,
    val defaults: JiraImportDefaults,
    val copyDates: Boolean,
    val asOf: Long,
    /** The apply's ticked items; null = a preview (nothing is ticked, no row carries an [ImportRow.apply]). */
    val ticks: List<JiraImportApplyItem>? = null,
    /** A rooted import's root (1.14); null = a whole-scope import, whose rows the kernel plans as before. */
    val root: ImportRootNode? = null,
    /**
     * The suggested matches the user confirmed (1.15), Jira id -> plan node id. An entry is honoured only when it equals the kernel's own
     * suggestion for that row ([ImportNameMatch]); any other is ignored. Empty = the planner of 1.14, row for row.
     */
    val matches: Map<String, UInt> = emptyMap(),
)

/** The same input with an apply's [ticks] (the apply runs the kernel once as a preview and once ticked, over one input). */
internal fun ImportInput.withTicks(ticks: List<JiraImportApplyItem>): ImportInput =
    ImportInput(browse, mapping, discovery, snapshot, defaults, copyDates, asOf, ticks, root, matches)

/** What an apply does with a row. */
sealed interface ImportApply {
    /** Ticked, and exactly what the client saw: insert it (a CREATE or a BIND). */
    data object Write : ImportApply

    /** Not ticked: neither written nor reported. */
    data object NotRequested : ImportApply

    /** Ticked, and not written, for [reason]. */
    class Skipped(val reason: JiraImportReason) : ImportApply
}

/**
 * One planned row: the wire [item], plus what a write needs. Rows come top-down (programs, projects, milestones; ids ascending inside a
 * level), so a [JiraImportParent.rowJiraId] always names an earlier row. [estimate] and [span] are the milestone's exact values
 * ([span] non-null = it will be scheduled); [releases] are the dead holders of the issue the write must release
 * (a preview shows them on CREATE/BIND rows; an apply clears them on every row it does not write - read [ImportPlan.releases]).
 */
data class ImportRow(
    val item: JiraImportItem,
    val observation: JiraObservation,
    val estimate: BigDecimal?,
    val span: MilestoneSpan?,
    val releases: List<ImportHolder>,
    val apply: ImportApply?,
    /** A created PROJECT's target window, copied from Jira's dates (1.14): both dates valid and `copyDates` on; else null. */
    val window: TargetWindow? = null,
)

/** A ticked item an apply does not write: [issueKey] is null when the re-browse no longer finds the issue. */
class ImportSkip(val jiraId: String, val issueKey: String?, val reason: JiraImportReason)

class ImportPlan(
    val asOf: Long,
    val rows: List<ImportRow>,
    /**
     * More issues were in scope than [MAX_IMPORT_ITEMS] (or the browse stopped at the cap). Rows may then be wrong in a way no row
     * shows: a parent cut away reads as an orphan (default parent, or NO_PARENT). The apply MUST refuse a truncated plan with a `400`
     * before any write, and the preview's modal must disable Import.
     */
    val truncated: Boolean,
    /** Jira team names (distinct, sorted) no Astrolabe team matched, among the milestones that needed a team. */
    val unmatchedTeams: List<String>,
    /** The apply's ticked ids the browse no longer holds (reason `CHANGED`), in tick order. */
    val vanished: List<String>,
) {
    /** The rows an apply writes, in write order (top-down, ids ascending inside a level). */
    val writes: List<ImportRow> get() = rows.filter { it.apply == ImportApply.Write }

    /** The dead holders an apply releases: those of the rows it writes, and of no other row. */
    val releases: List<ImportHolder> get() = writes.flatMap { it.releases }

    /** Every ticked item that is not written, in row order, then the vanished ones. */
    val skips: List<ImportSkip>
        get() = rows.mapNotNull { row ->
            (row.apply as? ImportApply.Skipped)?.let { ImportSkip(row.item.jiraId, row.item.key(), it.reason) }
        } + vanished.map { ImportSkip(it, null, JiraImportReason.CHANGED) }

    fun totals(): JiraImportTotals {
        val actions = rows.groupingBy { it.item.action }.eachCount()
        return JiraImportTotals(
            rows.size,
            actions[JiraImportAction.CREATE] ?: 0,
            actions[JiraImportAction.BIND] ?: 0,
            actions[JiraImportAction.SKIP] ?: 0,
            truncated,
        )
    }
}
