package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar

/*
 * The scheduling kernel's dependency side (v0.8.0; `planning-model.md` "The auto-proposal"): the dates every milestone and project has
 * SO FAR ([PlanValues]), the lower bounds the links put on a milestone ([ScheduleConstraints.bounds]) and the order in which the
 * milestones are placed ([ScheduleConstraints.placementOrder]). Pure: no I/O, no clock.
 */

private const val CYCLE_MESSAGE = "the active plan graph holds a cycle"

/**
 * The dates the run knows: the FIXED milestones (of every team) and the ones placed so far. A project's span is derived from its
 * valued milestones (min start, max end), exactly as the views derive it.
 */
internal class PlanValues {
    private val milestones = HashMap<UInt, DaySpan>()
    private val projects = HashMap<UInt, DaySpan>()

    fun put(id: UInt, projectId: UInt, span: DaySpan) {
        milestones[id] = span
        projects.merge(projectId, span) { a, b -> DaySpan(minOf(a.start, b.start), maxOf(a.end, b.end)) }
    }

    /** The span of [ref], or null while it has no dates (an unscheduled milestone, a project with nothing scheduled). */
    fun spanOf(ref: EndpointRef): DaySpan? = if (ref.kind == EndpointKind.MILESTONE) milestones[ref.id] else projects[ref.id]
}

/** What the valued predecessors demand of one milestone: the earliest working-day INDEX of its start and of its end (null = none). */
internal class Bounds(val startIndex: Long?, val endIndex: Long?)

/**
 * Fails closed when the active plan graph holds a cycle (the cycle rule refuses every one, so only a hand-edited database has one): the
 * time-point graph of [DependencyGraph.kt] over the plan's containment and [links], checked edge by edge.
 */
internal fun requireAcyclicPlan(containment: Iterable<ContainmentLink>, links: List<PlanLinkFact>) {
    val edges = links.map { DependencyEdge(it.predecessor, it.successor, it.type) }
    val graph = TimePointGraph.build(containment, edges)
    check(edges.none { graph.reaches(it.to, it.from) != null }) { CYCLE_MESSAGE }
}

/**
 * The links that bind the MOVABLE milestones of one team. A link binds a milestone m when its successor is m, or is m's project and
 * the link constrains the START (a start-bound link into a project binds every milestone of it through containment; an END-bound one
 * binds the project's derived end, which no single milestone owns, and is only reported by the post-check). [values] is the shared,
 * growing record of dates; [links] are ordered by id.
 */
internal class ScheduleConstraints(
    links: List<PlanLinkFact>,
    private val movable: List<TeamScheduleItem>,
    private val values: PlanValues,
    private val calendar: WorkingCalendar,
) {
    private val binding: Map<UInt, List<PlanLinkFact>>
    private val movableById = movable.associateBy { it.id }
    private val movableByProject = movable.groupBy { it.projectId }

    init {
        val intoMilestone = HashMap<UInt, MutableList<PlanLinkFact>>()
        val intoProjectStart = HashMap<UInt, MutableList<PlanLinkFact>>()
        for (link in links) {
            if (link.successor.kind == EndpointKind.MILESTONE) {
                intoMilestone.getOrPut(link.successor.id) { ArrayList() }.add(link)
            } else if (link.type.successorSide == TimeSide.START) {
                intoProjectStart.getOrPut(link.successor.id) { ArrayList() }.add(link)
            }
        }
        binding = movable.associate { m ->
            m.id to (intoMilestone[m.id].orEmpty() + intoProjectStart[m.projectId].orEmpty()).sortedBy { it.id }
        }
    }

    /**
     * The lower bounds of [m] from every binding link whose predecessor has dates now: the `required` working-day index of
     * [DependencyKernels.requiredIndex], on the start for FS/SS and on the end for FF/SF (a lead is simply clamped by the caller's
     * own first-day bound). A predecessor without dates binds nothing.
     */
    fun bounds(m: TeamScheduleItem): Bounds {
        var start: Long? = null
        var end: Long? = null
        for (link in binding.getValue(m.id)) {
            val predecessor = values.spanOf(link.predecessor) ?: continue
            val required = DependencyKernels.requiredIndex(link.type, link.lagDays, predecessor, calendar)
            if (link.type.successorSide == TimeSide.START) {
                start = maxOf(start ?: required, required)
            } else {
                end = maxOf(end ?: required, required)
            }
        }
        return Bounds(start, end)
    }

    /**
     * The placement order: the movable milestones in the team's order, each preceded (depth-first, in link-id order) by the movable
     * milestones of this team it must wait for, so a bound is read off dates the run has already produced. A milestone that is on the
     * walk's stack when it is met again is skipped (the hoisting relation can close a loop on valid data: `a FF b` + `b SS a` +
     * a third entity), never an error; a real cycle of the plan graph failed earlier ([requireAcyclicPlan]).
     */
    fun placementOrder(): List<TeamScheduleItem> {
        val seen = HashSet<UInt>()
        val ordered = ArrayList<TeamScheduleItem>(movable.size)

        fun visit(m: TeamScheduleItem) {
            if (!seen.add(m.id)) return
            hoistedBefore(m).forEach(::visit)
            ordered.add(m)
        }
        movable.forEach(::visit)
        return ordered
    }

    /** The movable milestones of this team that a binding link of [m] names (a project predecessor names its movable milestones). */
    private fun hoistedBefore(m: TeamScheduleItem): List<TeamScheduleItem> =
        binding.getValue(m.id).flatMap { link ->
            if (link.predecessor.kind == EndpointKind.MILESTONE) {
                listOfNotNull(movableById[link.predecessor.id])
            } else {
                movableByProject[link.predecessor.id].orEmpty()
            }
        }.filter { it.id != m.id }
}
