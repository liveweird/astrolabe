package ch.nokillswit.planning

/**
 * The dependency list view as pure functions (no I/O, no clock; the [TeamLoadKernels] idiom). Nothing is invented here: the checks
 * are [RoadmapKernels.checkedLinks]'s, the names are the same facts the project view's resolved end ([resolveEndpoints]) reads
 * (stated once in the document's lists), and [totals] is the ONE expression behind both this view's `totals` and Home's
 * `plan.conflicts`.
 */
object DependencyListKernels {
    /**
     * The link figures over [checked]: all of them, the violated ones and the unscheduled ones. [HomeKernels.plan] reads `violated`
     * as `conflicts`, so a link inside one project counts once, like every other.
     */
    fun totals(checked: Collection<CheckedLink>): DependencyListTotals = DependencyListTotals(
        links = checked.size,
        violated = checked.count { it.check.status == DependencyStatus.VIOLATED },
        unscheduled = checked.count { it.check.status == DependencyStatus.UNSCHEDULED },
    )

    /**
     * The document over [checked] (every link whose two ends resolve): rows in [dependencyOrder] (violated first, the largest shortfall
     * first, then OK, then unscheduled; successor name, predecessor name, id), cut at [maxRows] ([DependencyListView.truncated] says
     * it was; the cut drops the kept and unscheduled links first). A row names its ends by [EndpointRef]; the names are looked up from
     * [milestones] (a milestone's own name and team) and [projectNames] (a project end, or a milestone's project) for the ORDER, and
     * the three lists hold exactly what the rows KEPT by the cut name, each once, by ascending id. [DependencyListTotals] count every
     * link, whatever [maxRows] cuts. Every referenced milestone and project must be present (the checked links resolved them).
     */
    internal fun view(
        revision: Long,
        checked: Collection<CheckedLink>,
        milestones: Collection<MilestoneFactRow>,
        projectNames: Map<UInt, String>,
        maxRows: Int,
    ): DependencyListView {
        val milestoneById = milestones.associateBy { it.fact.id }
        fun nameOf(ref: EndpointRef): String = when (ref.kind) {
            EndpointKind.MILESTONE -> milestoneById.getValue(ref.id).name
            EndpointKind.PROJECT -> projectNames.getValue(ref.id)
        }
        val order = dependencyOrder<CheckedLink>(
            { it.check }, { nameOf(it.link.successor) }, { nameOf(it.link.predecessor) }, { it.link.id },
        )
        val ordered = checked.sortedWith(order)
        val kept = ordered.take(maxRows)
        val rows = kept.map { c ->
            DependencyListRow(c.link.id, c.link.predecessor, c.link.successor, c.link.type, c.link.lagDays, c.check)
        }
        val ends = rows.flatMap { listOf(it.predecessor, it.successor) }
        val namedMilestones = ends.filter { it.kind == EndpointKind.MILESTONE }.map { it.id }.distinct().sorted()
            .map { milestoneById.getValue(it) }
        val projectIds = (ends.filter { it.kind == EndpointKind.PROJECT }.map { it.id } + namedMilestones.map { it.fact.projectId })
            .distinct().sorted()
        val teamNames = namedMilestones.associate { it.fact.teamId to it.teamName }
        return DependencyListView(
            revision = revision,
            totals = totals(checked),
            projects = projectIds.map { DependencyListProject(it, projectNames.getValue(it)) },
            teams = teamNames.toSortedMap().map { (id, name) -> RoadmapTeam(id, name) },
            milestones = namedMilestones.map { DependencyListMilestone(it.fact.id, it.name, it.fact.projectId, it.fact.teamId) },
            dependencies = rows,
            truncated = ordered.size > maxRows,
        )
    }
}
