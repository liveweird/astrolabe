package ch.nokillswit.jira

/** The rows and Jira team names a caller may see. */
class RedactedPreview(val items: List<JiraImportItem>, val unmatchedTeams: List<String>)

/**
 * What a preview shows a caller who is NOT an ADMIN. A skipped row has no target, so no ownership guard ever looks at it, yet it carries
 * Jira's text: a non-admin could pick a stream where every row skips and read the whole scope's summaries without binding anything (an
 * audited, one-at-a-time act in 1.1). So every SKIP row but `ALREADY_BOUND` (which names its holder, a plan node anyone reads) loses its
 * summary (blank), its name (the issue key) and its infos; the key, level, type, reason and parent keys stay, and so do the totals and the
 * order. The unmatched team names come from the rows that WILL be created only: a Jira team name seen on a skipped row is Jira content too.
 *
 * Residual, inherent in the settled rule "ADMIN or an owner of every target": a row that lands on the caller's own target (a CREATE under
 * a node they own, a BIND onto it) is shown in full, and the owner of a work stream sees the whole tree under it. Pure: the kernel and
 * the apply are untouched; the route applies it after the guards.
 */
fun redactForNonAdmin(plan: ImportPlan): RedactedPreview {
    val items = plan.rows.map { row ->
        val item = row.item
        if (item.action != JiraImportAction.SKIP || item.reason == JiraImportReason.ALREADY_BOUND) {
            item
        } else {
            item.copy(summary = "", name = item.issueKey, infos = emptyList())
        }
    }
    // A created row that fell back to the default team although Jira named a team: that name matched none (a preview has no overrides).
    // The kernel's own rule: the trimmed names, sorted, one per fold.
    val created = plan.rows.filter { it.item.action == JiraImportAction.CREATE && it.item.team?.rule == JiraImportTeamRule.DEFAULT }
    val unmatched = created.mapNotNull { it.observation.teamName?.trim()?.takeIf(String::isNotEmpty) }
        .sorted().distinctBy(JiraImportKernels::foldName)
    return RedactedPreview(items, unmatched)
}
