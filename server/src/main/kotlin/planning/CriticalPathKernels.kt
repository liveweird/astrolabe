package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar

/**
 * One entity of ANOTHER project that lies upstream of the viewed project's end: [slackDays] is how many working days it could slip
 * before that end moves (0 = it drives the end), [critical] is `slackDays == 0` and [hops] the fewest LINKS between it and the
 * viewed project (a direct neighbour is 1; containment and a span's own start-to-end cost nothing).
 */
data class UpstreamRef(val ref: EndpointRef, val slackDays: Long, val critical: Boolean, val hops: Int)

/** One entity named by a chain link ([CriticalChain]): [hops] is the fewest links to one of the seed milestones. */
data class ChainRef(val ref: EndpointRef, val hops: Int)

/**
 * The part of a viewed project's chain that runs THROUGH the seed milestones ([CriticalPathKernels.analyseAll]'s `chainSeeds`): the
 * [linkIds] of its critical links and the [members] those links name, the seeds themselves left out, ordered by hops, kind, id.
 */
data class CriticalChain(val members: List<ChainRef>, val linkIds: Set<UInt>) {
    companion object {
        /** No seeds, or none on the chain. */
        val NONE = CriticalChain(emptyList(), emptySet())
    }
}

/**
 * What [CriticalPathKernels.analyse] answers for ONE viewed project: the [slackByMilestone] of its SCHEDULED milestones (an
 * unscheduled one is absent), the [criticalMilestones] (those with zero slack), the [criticalDependencies] (ids of the driving links
 * of the whole graph that lie on the chain) and the [upstream] entities of other projects, unordered; [chain] (1.27) is
 * [CriticalChain.NONE] unless seeds were asked for.
 */
data class CriticalPathResult(
    val slackByMilestone: Map<UInt, Long>,
    val criticalMilestones: Set<UInt>,
    val criticalDependencies: Set<UInt>,
    val upstream: List<UpstreamRef>,
    val chain: CriticalChain = CriticalChain.NONE,
) {
    companion object {
        /** The answer when nothing in the project is scheduled: no slack, no chain. */
        val EMPTY = CriticalPathResult(emptyMap(), emptySet(), emptySet(), emptyList())
    }
}

/**
 * The per-project critical path as a pure kernel (no I/O, no clock) over the WHOLE active plan graph (`planning-model.md` "The
 * critical path"). It reuses the time-point vocabulary of [TimePointGraph] (`START`/`END` of every milestone and project, the
 * [DependencyEdge.from]/[DependencyEdge.to] of a link) and adds what the cycle rule ignores: the planned VALUES and the edge OFFSETS.
 *
 * Values are the working-day indices of the [WorkingCalendar], half-open exactly like [DependencyKernels]' table: a scheduled
 * milestone has `S = W(first working day on or after start)` and `E = W(last working day on or before end) + 1`; a project has the
 * `min S` and `max E` of its scheduled milestones. An edge `from -> to` with `offset` holds when `value(to) >= value(from) + offset`
 * and its slack is `value(to) - value(from) - offset`: a milestone's `S -> E` (offset = its length, slack 0: the whole bar slips),
 * containment `S(project) -> S(milestone)` and `E(milestone) -> E(project)` (offset 0), and a link `X(pred) -> Y(succ)` with offset
 * `lagDays` for all four types (its slack equals `actual - required` of [DependencyKernels.check]). A PROJECT has no start-to-end edge
 * of its own: its span is derived from its milestones, and one would make every link into a project's start critical. An edge with an
 * unscheduled end has no values and a VIOLATED link (negative slack) is left out: it is never driving and caps nothing, and upstream
 * it ends the chain.
 *
 * The float of a point toward the viewed project `p`'s end: `float(E(p)) = 0` and `float(u)` is the minimum over its included edges
 * `u -> v` toward `p`'s end of `slack + float(v)`, computed in the reverse topological order of the points that can reach `E(p)`
 * (the upstream set). A point outside it has no float: it is downstream-only or unconnected and never reported. A cycle among the
 * upstream points is a violated invariant (the cycle rule refuses every one) and fails closed with [error].
 */
object CriticalPathKernels {
    private class Edge(val from: TimePoint, val to: TimePoint, val slack: Long, val linkId: UInt?)

    /** The half-open working-day values of every entity with scheduled work. */
    private class Values(milestones: Collection<PlanMilestoneFact>, calendar: WorkingCalendar) {
        private val start = HashMap<EndpointRef, Long>()
        private val end = HashMap<EndpointRef, Long>()

        init {
            for (m in milestones) {
                val span = m.span ?: continue
                val s = calendar.workingDayIndex(calendar.nextWorkingDayOnOrAfter(span.start))
                val e = calendar.workingDayIndex(calendar.previousWorkingDayOnOrBefore(span.end)) + 1
                start[EndpointRef(EndpointKind.MILESTONE, m.id)] = s
                end[EndpointRef(EndpointKind.MILESTONE, m.id)] = e
                val project = EndpointRef(EndpointKind.PROJECT, m.projectId)
                start.merge(project, s) { a, b -> minOf(a, b) }
                end.merge(project, e) { a, b -> maxOf(a, b) }
            }
        }

        fun of(point: TimePoint): Long? = (if (point.side == TimeSide.START) start else end)[point.entity]
    }

    /**
     * The critical path of project [projectId] over every ACTIVE [milestones] fact and [links] of the plan, on [calendar]'s working
     * days. A project with nothing scheduled answers [CriticalPathResult.EMPTY].
     */
    fun analyse(
        projectId: UInt,
        milestones: Collection<PlanMilestoneFact>,
        links: Collection<PlanLinkFact>,
        calendar: WorkingCalendar,
    ): CriticalPathResult = analyseAll(listOf(projectId), milestones, links, calendar).getValue(projectId)

    /**
     * [analyse] for every id of [projectIds] over ONE build of the values and the edges (the graph does not depend on the root; only
     * the walk does): the answer of `analyseAll(ids, …)[id]` equals `analyse(id, …)`. Every requested id is a key, an id without
     * scheduled work maps to [CriticalPathResult.EMPTY]. A non-empty [chainSeeds] (milestone ids) adds each result's
     * [CriticalPathResult.chain]; every other member is the same with or without seeds.
     */
    fun analyseAll(
        projectIds: Collection<UInt>,
        milestones: Collection<PlanMilestoneFact>,
        links: Collection<PlanLinkFact>,
        calendar: WorkingCalendar,
        chainSeeds: Set<UInt> = emptySet(),
    ): Map<UInt, CriticalPathResult> {
        val values = Values(milestones, calendar)
        val incoming = incomingEdges(values, milestones, links)
        return projectIds.distinct().associateWith { analyseRoot(it, values, incoming, milestones, chainSeeds) }
    }

    private fun analyseRoot(
        projectId: UInt,
        values: Values,
        incoming: Map<TimePoint, List<Edge>>,
        milestones: Collection<PlanMilestoneFact>,
        chainSeeds: Set<UInt>,
    ): CriticalPathResult {
        val root = TimePoint(EndpointRef(EndpointKind.PROJECT, projectId), TimeSide.END)
        if (values.of(root) == null) return CriticalPathResult.EMPTY
        val upstream = reaching(root, incoming)
        val remaining = HashMap<TimePoint, Int>()
        for (v in upstream) for (e in incoming[v].orEmpty()) remaining.merge(e.from, 1, Int::plus)
        check(root !in remaining) { CYCLE_MESSAGE }

        val walk = Walk(root, incoming, remaining)
        var processed = 0
        while (walk.queue.isNotEmpty()) {
            walk.visit(walk.queue.removeFirst())
            processed++
        }
        check(processed == upstream.size) { CYCLE_MESSAGE }
        val answer = result(projectId, milestones, walk.linked, walk.float, walk.hops, walk.criticalLinks)
        return if (chainSeeds.isEmpty()) answer else answer.copy(chain = chainOf(chainSeeds, upstream, incoming, walk.float))
    }

    /**
     * The chain THROUGH [seedMilestones] (the team's own milestones): the seed points are their zero-float points (none = no chain).
     * The critical edges are those of slack 0 into a zero-float point; the backward closure from the seeds holds everything that
     * drives them, the forward one everything they drive, up to the viewed project's end. A critical LINK is on the chain when its
     * `to` point is in the backward closure or its `from` point in the forward one; members are the entities such links name minus
     * the seeds (a project met only through containment is named by no link, so it is no member). `hops` = the fewest LINKS from a
     * seed (containment and a milestone's start-to-end cost nothing), the minimum over the entity's points.
     */
    private fun chainOf(
        seedMilestones: Set<UInt>,
        upstream: Set<TimePoint>,
        incoming: Map<TimePoint, List<Edge>>,
        float: Map<TimePoint, Long>,
    ): CriticalChain {
        val seeds = seedMilestones.flatMap { id ->
            TimeSide.entries.map { TimePoint(EndpointRef(EndpointKind.MILESTONE, id), it) }.filter { float[it] == 0L }
        }
        if (seeds.isEmpty()) return CriticalChain.NONE
        val into = HashMap<TimePoint, List<Edge>>()
        val out = HashMap<TimePoint, MutableList<Edge>>()
        for (v in upstream) {
            if (float.getValue(v) != 0L) continue
            val critical = incoming[v].orEmpty().filter { it.slack == 0L }
            into[v] = critical
            for (e in critical) out.getOrPut(e.from) { ArrayList() }.add(e)
        }
        val back = hopsFrom(seeds, into) { it.from }
        val forward = hopsFrom(seeds, out) { it.to }
        val linkIds = HashSet<UInt>()
        val named = HashSet<EndpointRef>()
        for ((head, edges) in into) {
            for (e in edges) {
                val id = e.linkId ?: continue
                if (head !in back && e.from !in forward) continue
                linkIds.add(id)
                named.add(e.from.entity)
                named.add(head.entity)
            }
        }
        val members = named.filterNot { it.kind == EndpointKind.MILESTONE && it.id in seedMilestones }.map { ref ->
            val points = TimeSide.entries.map { TimePoint(ref, it) }
            ChainRef(ref, (points.mapNotNull { back[it] } + points.mapNotNull { forward[it] }).min())
        }
        return CriticalChain(members.sortedWith(compareBy({ it.hops }, { it.ref.kind }, { it.ref.id })), linkIds)
    }

    /**
     * The fewest links from [seeds] to every point they reach over [edges] (keyed by the point an edge is left from; [next] is its
     * other end): a 0-1 search, a link costs 1 and containment or a milestone's start-to-end 0. The graph is acyclic, so it ends.
     */
    private fun hopsFrom(
        seeds: Collection<TimePoint>,
        edges: Map<TimePoint, List<Edge>>,
        next: (Edge) -> TimePoint,
    ): Map<TimePoint, Int> {
        val hops = HashMap<TimePoint, Int>()
        val queue = ArrayDeque<TimePoint>()
        for (seed in seeds) {
            hops[seed] = 0
            queue.addLast(seed)
        }
        while (queue.isNotEmpty()) {
            val v = queue.removeFirst()
            val here = hops.getValue(v)
            for (e in edges[v].orEmpty()) {
                val cost = if (e.linkId != null) 1 else 0
                val w = next(e)
                if (here + cost >= (hops[w] ?: Int.MAX_VALUE)) continue
                hops[w] = here + cost
                if (cost == 0) queue.addFirst(w) else queue.addLast(w)
            }
        }
        return hops
    }

    /** The reverse-topological relaxation: [visit] settles a point whose every outgoing edge is done and relaxes the edges into it. */
    private class Walk(
        root: TimePoint,
        private val incoming: Map<TimePoint, List<Edge>>,
        private val remaining: MutableMap<TimePoint, Int>,
    ) {
        val float = hashMapOf(root to 0L)
        val hops = hashMapOf(root to 0)
        val criticalLinks = HashSet<UInt>()
        val linked = HashSet<EndpointRef>()
        val queue = ArrayDeque(listOf(root))

        fun visit(v: TimePoint) {
            val floatV = float.getValue(v)
            val hopsV = hops.getValue(v)
            for (e in incoming[v].orEmpty()) {
                val link = e.linkId
                float.merge(e.from, e.slack + floatV) { a, b -> minOf(a, b) }
                hops.merge(e.from, hopsV + (if (link != null) 1 else 0)) { a, b -> minOf(a, b) }
                if (link != null) {
                    linked.add(e.from.entity)
                    linked.add(v.entity)
                    if (e.slack == 0L && floatV == 0L) criticalLinks.add(link)
                }
                if (remaining.merge(e.from, -1, Int::plus) == 0) queue.addLast(e.from)
            }
        }
    }

    /** Every included edge, keyed by its `to` point (the walk runs from the viewed project's end backwards). */
    private fun incomingEdges(
        values: Values,
        milestones: Collection<PlanMilestoneFact>,
        links: Collection<PlanLinkFact>,
    ): Map<TimePoint, List<Edge>> {
        val incoming = HashMap<TimePoint, MutableList<Edge>>()

        fun add(from: TimePoint, to: TimePoint, offset: Long, linkId: UInt?) {
            val a = values.of(from) ?: return
            val b = values.of(to) ?: return
            val slack = b - a - offset
            if (slack >= 0) incoming.getOrPut(to) { ArrayList() }.add(Edge(from, to, slack, linkId))
        }
        for (m in milestones) {
            if (m.span == null) continue
            val milestone = EndpointRef(EndpointKind.MILESTONE, m.id)
            val s = TimePoint(milestone, TimeSide.START)
            val e = TimePoint(milestone, TimeSide.END)
            add(s, e, checkNotNull(values.of(e)) - checkNotNull(values.of(s)), null)
            val project = EndpointRef(EndpointKind.PROJECT, m.projectId)
            add(TimePoint(project, TimeSide.START), s, 0, null)
            add(e, TimePoint(project, TimeSide.END), 0, null)
        }
        for (link in links) {
            val edge = DependencyEdge(link.predecessor, link.successor, link.type)
            add(edge.from, edge.to, link.lagDays.toLong(), link.id)
        }
        return incoming
    }

    /** Every point that can reach [root] over [incoming], [root] included. */
    private fun reaching(root: TimePoint, incoming: Map<TimePoint, List<Edge>>): Set<TimePoint> {
        val seen = hashSetOf(root)
        val stack = ArrayDeque(listOf(root))
        while (stack.isNotEmpty()) {
            for (e in incoming[stack.removeLast()].orEmpty()) if (seen.add(e.from)) stack.addLast(e.from)
        }
        return seen
    }

    /** The per-milestone and per-entity answers from the final floats. */
    private fun result(
        projectId: UInt,
        milestones: Collection<PlanMilestoneFact>,
        linked: Set<EndpointRef>,
        float: Map<TimePoint, Long>,
        hops: Map<TimePoint, Int>,
        criticalLinks: Set<UInt>,
    ): CriticalPathResult {
        val slackByMilestone = HashMap<UInt, Long>()
        val critical = HashSet<UInt>()
        val upstream = ArrayList<UpstreamRef>()

        // An entity's figure is the minimum over those of its points that can reach the viewed project's end.
        fun report(ref: EndpointRef) {
            val points = listOf(TimePoint(ref, TimeSide.START), TimePoint(ref, TimeSide.END)).filter { it in float }
            if (points.isEmpty()) return
            val slack = points.minOf { float.getValue(it) }
            upstream.add(UpstreamRef(ref, slack, slack == 0L, points.minOf { hops.getValue(it) }))
        }
        for (m in milestones) {
            val ref = EndpointRef(EndpointKind.MILESTONE, m.id)
            val slack = float[TimePoint(ref, TimeSide.START)] ?: continue
            if (m.projectId == projectId) {
                slackByMilestone[m.id] = slack
                if (slack == 0L) critical.add(m.id)
            } else {
                report(ref)
            }
        }
        // A project is listed only when an included link names it (the point the link uses), not for merely containing upstream milestones.
        for (ref in linked) if (ref.kind == EndpointKind.PROJECT && ref.id != projectId) report(ref)
        return CriticalPathResult(slackByMilestone, critical, criticalLinks, upstream)
    }

    private const val CYCLE_MESSAGE = "the active plan graph holds a cycle"
}
