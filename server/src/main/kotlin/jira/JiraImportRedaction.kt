package ch.nokillswit.jira

/** The `jiraId` of a redacted row under an active filter: this prefix and its 1-based position in the final list (no Jira id leaves). */
internal const val HIDDEN_ID_PREFIX = "hidden-"

/** The rows and Jira team names a caller may see. */
class RedactedPreview(val items: List<JiraImportItem>, val unmatchedTeams: List<String>)

/** A row the preview redacts for a non-admin: a SKIP other than `ALREADY_BOUND` (which names its holder, a plan node anyone reads). */
internal fun JiraImportItem.isRedactedSkip(): Boolean = action == JiraImportAction.SKIP && reason != JiraImportReason.ALREADY_BOUND

/**
 * What a preview shows a caller who is NOT an ADMIN. A skipped row has no target, so no ownership guard ever looks at it, yet it carries
 * Jira's text: a non-admin could pick a stream where every row skips and read the whole scope's summaries without binding anything (an
 * audited, one-at-a-time act in 1.1). So every SKIP row but `ALREADY_BOUND` loses its summary (blank), its name (the issue key) and its
 * infos; the key, level, type, reason and parent keys stay (without a filter), and so do the totals and the order. The unmatched team
 * names come from the rows that WILL be created only: a Jira team name seen on a skipped row is Jira content too.
 *
 * With the import FILTER active ([filterActive]) a redacted row loses every per-item handle as well (1.13.2 audit LOW-1): the filter is a
 * probe the caller steers (repeat the preview with other filters and learn, per listed key, whether the issue is done and roughly when it
 * was updated), and a key is what names the issue. So `issueKey` is null, `name` blank, `jiraId` becomes `hidden-<n>` and the row's parent
 * id and key go too. The redacted rows come AFTER every visible row, ordered by what they still show (level top-down, then reason, type
 * name, hierarchy level) and never by id: two redacted rows that show the same are identical but for their number, so the order of the
 * rows in the plan (ascending Jira id) is not observable, and no order lines up with an unfiltered preview's. `hidden-<n>` numbers that
 * final list. An `ALREADY_BOUND` row is decided before its parent is looked at, so it can name a
 * redacted parent, or one the filtered browse never listed (it does not read the parent of a linked child): a handle to an item the
 * caller may not see, so as a precaution such a row keeps its parent id and key only when the parent is a VISIBLE row. A CREATE/BIND
 * row never has a redacted parent (a child of a skipped parent is `PARENT_SKIPPED`) and keeps its parent: the apply compares it. Without
 * a filter nothing changes.
 *
 * Residual, inherent in the settled rule "ADMIN or an owner of every target": a row that lands on the caller's own target (a CREATE under
 * a node they own, a BIND onto it) is shown in full, and the owner of a work stream sees the whole tree under it. Pure: the kernel and
 * the apply are untouched; the route applies it after the guards.
 */
fun redactForNonAdmin(plan: ImportPlan, filterActive: Boolean = false): RedactedPreview {
    val rows = plan.rows.map { it.item }
    val items = if (filterActive) withoutHandles(rows) else rows.map { it.blankedText() }
    // A created row that fell back to the default team although Jira named a team: that name matched none (a preview has no overrides).
    // The kernel's own rule: the trimmed names, sorted, one per fold.
    val created = plan.rows.filter { it.item.action == JiraImportAction.CREATE && it.item.team?.rule == JiraImportTeamRule.DEFAULT }
    val unmatched = created.mapNotNull { it.observation.teamName?.trim()?.takeIf(String::isNotEmpty) }
        .sorted().distinctBy(JiraImportKernels::foldName)
    return RedactedPreview(items, unmatched)
}

/** The plain redaction (no filter): a skipped row's text goes, its key becomes its name. */
private fun JiraImportItem.blankedText(): JiraImportItem =
    if (isRedactedSkip()) copy(summary = "", name = key(), infos = emptyList(), suggestion = null) else this

/** What a redacted row still shows: the only things its position may follow. */
private data class Shown(val level: JiraLevel, val reason: JiraImportReason?, val typeName: String?, val hierarchyLevel: Int?)

private val SHOWN_ORDER = compareBy<Shown>(
    { it.level.ordinal }, { it.reason?.ordinal ?: -1 }, { it.typeName.orEmpty() }, { it.hierarchyLevel ?: -1 },
)

private fun JiraImportItem.shown() = Shown(level, reason, typeName, hierarchyLevel)

/**
 * The filtered preview's rows: the visible ones first, then the redacted ones, handle-free and in no order of their ids (the sort is
 * stable, and rows it cannot tell apart cannot be told apart in the answer either).
 */
private fun withoutHandles(rows: List<JiraImportItem>): List<JiraImportItem> {
    val visibleIds = rows.filterNot { it.isRedactedSkip() }.mapTo(HashSet()) { it.jiraId }
    val visible = rows.filterNot { it.isRedactedSkip() }.map { item ->
        val linked = item.action == JiraImportAction.SKIP
        if (linked && item.parentJiraId !in visibleIds) item.copy(parentJiraId = null, parentIssueKey = null) else item
    }
    val redacted = rows.filter { it.isRedactedSkip() }.sortedWith { a, b -> SHOWN_ORDER.compare(a.shown(), b.shown()) }
    val hidden = redacted.mapIndexed { index, item ->
        item.copy(
            jiraId = "$HIDDEN_ID_PREFIX${visible.size + index + 1}",
            issueKey = null,
            summary = "",
            name = "",
            infos = emptyList(),
            suggestion = null,
            parentJiraId = null,
            parentIssueKey = null,
        )
    }
    return visible + hidden
}
