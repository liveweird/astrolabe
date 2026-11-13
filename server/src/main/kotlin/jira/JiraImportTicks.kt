package ch.nokillswit.jira

/**
 * The apply's ticks over the decided rows (split out of [ImportPlanner]). [ticks] are the client's ticked rows by Jira id;
 * [naturalTeams] is the planner's own map of the team each milestone row has WITHOUT an override (filled while the rows are planned,
 * read here after they all are).
 */
internal class ImportTicks(
    private val ticks: Map<String, JiraImportApplyItem>,
    private val naturalTeams: Map<String, UInt?>,
) {
    fun applyTicks(planned: List<ImportRow>): List<ImportRow> {
        val outcomes = HashMap<String, ImportApply>()
        return planned.map { row ->
            val tick = ticks[row.item.jiraId]
            val apply = if (tick == null) ImportApply.NotRequested else outcomeOf(row, tick, outcomes)
            outcomes[row.item.jiraId] = apply
            // Only a written row releases anything: nothing else may carry a release for a flatMap to find.
            row.copy(apply = apply, releases = row.releases.takeIf { apply == ImportApply.Write }.orEmpty())
        }
    }

    /** The kernel's own skip first, then a changed expectation, then a parent the client left out; else the row is written. */
    private fun outcomeOf(row: ImportRow, tick: JiraImportApplyItem, outcomes: Map<String, ImportApply>): ImportApply {
        val item = row.item
        item.reason?.let { return ImportApply.Skipped(it) }
        if (!matches(tick.expected, item)) return ImportApply.Skipped(JiraImportReason.CHANGED)
        val dependsOn = item.parent?.rowJiraId
        if (dependsOn != null && outcomes[dependsOn] != ImportApply.Write) return ImportApply.Skipped(JiraImportReason.PARENT_SKIPPED)
        return ImportApply.Write
    }

    private fun matches(expected: JiraImportExpected, item: JiraImportItem): Boolean =
        expected.action == item.action && expected.level == item.level && expected.parentJiraId == item.parentJiraId &&
            expected.nodeId == item.target?.nodeId && landsWhereSeen(expected, item) && teamAsSeen(expected, item)

    /** A milestone CREATE keeps the team the preview showed (the natural one, before any override); other rows have no team. */
    private fun teamAsSeen(expected: JiraImportExpected, item: JiraImportItem): Boolean =
        item.action != JiraImportAction.CREATE || item.level != JiraLevel.MILESTONE || expected.teamId == naturalTeams[item.jiraId]

    /** A CREATE lands under the parent the client saw: the same kind and, for an existing node, the same node. A BIND lands nowhere. */
    private fun landsWhereSeen(expected: JiraImportExpected, item: JiraImportItem): Boolean =
        item.action != JiraImportAction.CREATE ||
            (expected.parent?.kind == item.parent?.kind && expected.parent?.nodeId == item.parent?.nodeId)
}
