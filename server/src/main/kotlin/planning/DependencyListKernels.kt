package ch.nokillswit.planning

/**
 * The dependency list view as pure functions (no I/O, no clock; the [TeamLoadKernels] idiom). Nothing is invented here: the checks
 * are [RoadmapKernels.checkedLinks]'s, each end is built from plain facts exactly as the project view's resolved end
 * ([resolveEndpoints]) reads, and [totals] is the ONE expression behind both this view's `totals` and Home's `plan.conflicts`.
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
     * it was; the cut drops the kept and unscheduled links first). An end is a milestone from [milestones] (its own name, team and
     * dates, its project's name from [projectNames]) or a project (its name, its DERIVED span from [spans], no team).
     * [DependencyListTotals] count every link, whatever [maxRows] cuts. Every referenced milestone and project must be present (the
     * checked links resolved them).
     */
    internal fun view(
        revision: Long,
        checked: Collection<CheckedLink>,
        milestones: Collection<MilestoneFactRow>,
        projectNames: Map<UInt, String>,
        spans: Map<UInt, DaySpan>,
        maxRows: Int,
    ): DependencyListView {
        val milestoneById = milestones.associateBy { it.fact.id }
        fun end(ref: EndpointRef): DependencyEndpoint = when (ref.kind) {
            EndpointKind.MILESTONE -> {
                val row = milestoneById.getValue(ref.id)
                val span = row.fact.span
                DependencyEndpoint(
                    kind = EndpointKind.MILESTONE,
                    id = ref.id,
                    name = row.name,
                    projectId = row.fact.projectId,
                    projectName = projectNames.getValue(row.fact.projectId),
                    teamId = row.fact.teamId,
                    teamName = row.teamName,
                    startDate = span?.start?.toString(),
                    endDate = span?.end?.toString(),
                )
            }
            EndpointKind.PROJECT -> {
                val name = projectNames.getValue(ref.id)
                val span = spans[ref.id]
                DependencyEndpoint(
                    kind = EndpointKind.PROJECT,
                    id = ref.id,
                    name = name,
                    projectId = ref.id,
                    projectName = name,
                    teamId = null,
                    teamName = null,
                    startDate = span?.start?.toString(),
                    endDate = span?.end?.toString(),
                )
            }
        }
        val rows = checked.map { c ->
            DependencyListRow(
                id = c.link.id,
                predecessor = end(c.link.predecessor),
                successor = end(c.link.successor),
                type = c.link.type,
                lagDays = c.link.lagDays,
                check = c.check,
            )
        }.sortedWith(dependencyOrder({ it.check }, { it.successor.name }, { it.predecessor.name }, { it.id }))
        return DependencyListView(revision, totals(checked), rows.take(maxRows), truncated = rows.size > maxRows)
    }
}
