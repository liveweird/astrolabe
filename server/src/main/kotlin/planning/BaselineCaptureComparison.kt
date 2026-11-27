package ch.nokillswit.planning

/**
 * The names a changed link's ends are shown with, side-neutral like [BaselineComparison]: the "now" side's live (or second baseline's
 * frozen) name when the row exists there, else the frozen one (a removed link's ends may be gone). An end found on neither side - not
 * expected, the frozen rows hold every active milestone and project - reads as `#id`.
 */
internal class LinkEndNames(
    nowProjects: List<CompareProject>,
    frozenProjects: List<FrozenProjectRow>,
    nowMilestones: List<MilestoneCapture>,
    frozenMilestones: List<FrozenMilestoneRow>,
) {
    private val projectNames: Map<UInt, String> =
        frozenProjects.associate { it.id to it.name } + nowProjects.associate { it.id to it.name }
    private val milestones: Map<UInt, Pair<String, UInt>> =
        frozenMilestones.associate { it.id to (it.name to it.projectId) } + nowMilestones.associate { it.id to (it.name to it.projectId) }

    fun end(ref: EndpointRef): BaselineLinkEnd = when (ref.kind) {
        EndpointKind.PROJECT -> BaselineLinkEnd(ref.kind, ref.id, projectNames[ref.id] ?: "#${ref.id}", null, null)
        EndpointKind.MILESTONE -> {
            val milestone = milestones[ref.id]
            val name = milestone?.first ?: "#${ref.id}"
            BaselineLinkEnd(ref.kind, ref.id, name, milestone?.second, milestone?.let { projectNames[it.second] })
        }
    }
}

/**
 * The comparison view's `links` and `capacity` blocks as pure functions over the two sides' captured facts: `null` on a side = that
 * baseline did not capture them, and the block then answers `captured: false` and nothing else. The kernels are [BaselineLinkKernels]
 * and [BaselineCapacityKernels]; this only names, orders and caps their answer.
 */
internal object BaselineCaptureComparison {
    private val NOT_CAPTURED_LINKS = BaselineLinks(false, BaselineLinkTotals(0, 0, 0, 0), emptyList(), false)
    private val NOT_CAPTURED_CAPACITY = BaselineCapacity(false, BaselineCapacityTotals(0, 0), emptyList(), false)

    /** The changed links by dependency id, at most [MAX_BASELINE_LINK_ROWS]; the totals cover every link of either side. */
    fun links(then: List<PlanLinkFact>?, now: List<PlanLinkFact>?, names: LinkEndNames): BaselineLinks {
        if (then == null || now == null) return NOT_CAPTURED_LINKS
        val comparison = BaselineLinkKernels.compare(then, now)
        val totals = comparison.totals
        return BaselineLinks(
            captured = true,
            totals = BaselineLinkTotals(totals.added, totals.removed, totals.changed, totals.unchanged),
            items = comparison.changes.take(MAX_BASELINE_LINK_ROWS).map { change ->
                val link = checkNotNull(change.now ?: change.then)
                BaselineLinkItem(
                    dependencyId = link.id,
                    change = change.kind,
                    predecessor = names.end(link.predecessor),
                    successor = names.end(link.successor),
                    then = change.then?.toTerms(),
                    now = change.now?.toTerms(),
                )
            },
            truncated = comparison.changes.size > MAX_BASELINE_LINK_ROWS,
        )
    }

    /**
     * The teams whose capacity differs, by name (case-insensitive) then id, each with its changed ranges by start; at most
     * [MAX_BASELINE_CAPACITY_ROWS] change rows in all (the last team may be cut short). [teamNames] covers every team of either side.
     */
    fun capacity(then: List<CapacityCapture>?, now: List<CapacityCapture>?, teamNames: Map<UInt, String>): BaselineCapacity {
        if (then == null || now == null) return NOT_CAPTURED_CAPACITY
        val thenByTeam = then.groupBy({ it.teamId }) { it.period }
        val nowByTeam = now.groupBy({ it.teamId }) { it.period }
        val teamIds = (thenByTeam.keys + nowByTeam.keys)
        val changed = teamIds.map { id ->
            id to BaselineCapacityKernels.changes(thenByTeam[id].orEmpty(), nowByTeam[id].orEmpty())
        }.filter { it.second.isNotEmpty() }
            .sortedWith(compareBy({ teamNames.getValue(it.first).lowercase() }, { it.first }))
        var budget = MAX_BASELINE_CAPACITY_ROWS
        val teams = ArrayList<BaselineCapacityTeam>()
        for ((id, changes) in changed) {
            if (budget == 0) break
            val kept = changes.take(budget)
            budget -= kept.size
            teams += BaselineCapacityTeam(id, teamNames.getValue(id), kept.map { it.toView() })
        }
        return BaselineCapacity(
            captured = true,
            totals = BaselineCapacityTotals(teams = teamIds.size, changedTeams = changed.size),
            teams = teams,
            truncated = changed.sumOf { it.second.size } > MAX_BASELINE_CAPACITY_ROWS,
        )
    }

    private fun PlanLinkFact.toTerms() = LinkTerms(type, lagDays)
}

internal fun CapacityFigure.toView() = BaselineCapacityFigure(mdPerWeek.toDouble(), wipLimit)

private fun CapacityChange.toView() =
    BaselineCapacityChange(from.toString(), to?.toString(), then?.toView(), now?.toView())
