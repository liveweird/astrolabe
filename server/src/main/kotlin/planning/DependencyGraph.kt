package ch.nokillswit.planning

/** Which end of an entity's span a [TimePoint] is. */
enum class TimeSide { START, END }

/** A time point of the plan: the start or the end of a milestone or a project. */
data class TimePoint(val entity: EndpointRef, val side: TimeSide)

/** The containment fact "milestone [milestoneId] lies inside project [projectId]". */
data class ContainmentLink(val milestoneId: UInt, val projectId: UInt)

/** A stored dependency as the graph sees it. */
data class DependencyEdge(val predecessor: EndpointRef, val successor: EndpointRef, val type: DependencyType)

/** The predecessor side a [DependencyType] anchors on: F* leaves from the predecessor's END, S* from its START. */
val DependencyType.predecessorSide: TimeSide
    get() = if (this == DependencyType.FS || this == DependencyType.FF) TimeSide.END else TimeSide.START

/** The successor side a [DependencyType] constrains: *S binds the successor's START, *F its END. */
val DependencyType.successorSide: TimeSide
    get() = if (this == DependencyType.FS || this == DependencyType.SS) TimeSide.START else TimeSide.END

/** The time point the link leaves from. */
val DependencyEdge.from: TimePoint get() = TimePoint(predecessor, type.predecessorSide)

/** The time point the link arrives at. */
val DependencyEdge.to: TimePoint get() = TimePoint(successor, type.successorSide)

/**
 * The start/end time-point graph of the ACTIVE plan as a pure kernel (no I/O), the cycle rule of `planning-model.md` "Dependencies".
 * Nodes are `START(x)` and `END(x)` of every milestone and project that takes part. Edges: `START(x) -> END(x)` for every entity,
 * containment `START(project) -> START(milestone)` and `END(milestone) -> END(project)`, and one edge per dependency
 * ([DependencyEdge.from] -> [DependencyEdge.to]). Without dependency edges the graph is a DAG, so a NEW edge `u -> v` closes a cycle
 * exactly when `v` already reaches `u` ([cycleClosedBy]). Lags are ignored on purpose: ANY directed cycle is refused (a zero-lag
 * SS/SS pair included), the invariant the critical path (v0.7) and the scheduler (v0.8) rely on — every active row set is acyclic, so
 * their longest-path passes terminate. They add edge weights to this same builder.
 */
class TimePointGraph private constructor(private val next: Map<TimePoint, List<TimePoint>>) {
    /**
     * An iterative depth-first search from [from] with parent links: the path `from ... to` (both included) when [to] is reachable,
     * else null. A point reaches itself by the one-element path. Not necessarily the shortest path.
     */
    fun reaches(from: TimePoint, to: TimePoint): List<TimePoint>? {
        if (from == to) return listOf(from)
        val parent = HashMap<TimePoint, TimePoint>()
        val seen = HashSet<TimePoint>().apply { add(from) }
        val stack = ArrayDeque<TimePoint>().apply { addLast(from) }
        while (stack.isNotEmpty()) {
            val current = stack.removeLast()
            for (candidate in next[current].orEmpty()) {
                if (!seen.add(candidate)) continue
                parent[candidate] = current
                if (candidate == to) return pathTo(to, parent)
                stack.addLast(candidate)
            }
        }
        return null
    }

    /**
     * The cycle the NEW [edge] would close, as the entities along it — consecutive time points of one entity collapsed, the first
     * entity (the edge's predecessor) repeated last — or null when it closes none. The edge is not part of this graph yet.
     */
    fun cycleClosedBy(edge: DependencyEdge): List<EndpointRef>? {
        val path = reaches(edge.to, edge.from) ?: return null
        val entities = ArrayList<EndpointRef>()
        for (point in listOf(edge.from) + path) {
            if (entities.lastOrNull() != point.entity) entities.add(point.entity)
        }
        return entities
    }

    private fun pathTo(to: TimePoint, parent: Map<TimePoint, TimePoint>): List<TimePoint> {
        val reversed = ArrayList<TimePoint>()
        var cursor: TimePoint? = to
        while (cursor != null) {
            reversed.add(cursor)
            cursor = parent[cursor]
        }
        return reversed.asReversed()
    }

    companion object {
        /** Builds the graph of the given active milestones' containment and the active [dependencies]. */
        fun build(containment: Iterable<ContainmentLink>, dependencies: Iterable<DependencyEdge>): TimePointGraph {
            val edges = LinkedHashMap<TimePoint, MutableList<TimePoint>>()
            val known = HashSet<EndpointRef>()

            fun edge(from: TimePoint, to: TimePoint) {
                edges.getOrPut(from) { ArrayList() }.add(to)
            }

            fun entity(ref: EndpointRef) {
                if (known.add(ref)) edge(TimePoint(ref, TimeSide.START), TimePoint(ref, TimeSide.END))
            }
            for (link in containment) {
                val milestone = EndpointRef(EndpointKind.MILESTONE, link.milestoneId)
                val project = EndpointRef(EndpointKind.PROJECT, link.projectId)
                entity(milestone)
                entity(project)
                edge(TimePoint(project, TimeSide.START), TimePoint(milestone, TimeSide.START))
                edge(TimePoint(milestone, TimeSide.END), TimePoint(project, TimeSide.END))
            }
            for (dependency in dependencies) {
                entity(dependency.predecessor)
                entity(dependency.successor)
                edge(dependency.from, dependency.to)
            }
            return TimePointGraph(edges)
        }
    }
}
