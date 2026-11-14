package ch.nokillswit.planning

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/**
 * `GET /views/roadmap?criticalPath=N` (1.7): the chain toward ONE picked project, rolled up to the roadmap's grain. [projectId] is the
 * target; [projects] are the OTHER projects upstream of its end (the target itself is implied: critical, slack 0), by hops, slack, id;
 * [pairs] are the ordered project pairs holding at least one link on the chain, by (predecessor, successor). Both are empty while the
 * target has nothing scheduled. Present only with the parameter, on `GET /views/roadmap` and (1.16) `GET /views/programs` - the same block
 * from the same step ([criticalPathTo]) (`planning-model.md` "The roadmap view").
 */
@Serializable
data class RoadmapCriticalPath(
    val projectId: UInt,
    val projects: List<RoadmapCriticalProject>,
    val pairs: List<RoadmapCriticalPair>,
)

/**
 * One project upstream of the target: [slackDays] is the least slack among its upstream milestones (and itself, when a link names it),
 * [critical] whether any of them is on the chain (slack 0), [hops] the fewest links between any of them and the target.
 */
@Serializable
data class RoadmapCriticalProject(val projectId: UInt, val slackDays: Int, val critical: Boolean, val hops: Int)

/** An ordered pair of projects holding at least one critical link; it marks the pair's direct AND bundle arrows on the roadmap. */
@Serializable
data class RoadmapCriticalPair(val predecessorProjectId: UInt, val successorProjectId: UInt)

/** The pure roll-up of one project's [CriticalPathResult] to projects and project pairs (no I/O). */
object RoadmapCriticalPathKernels {
    /**
     * Rolls [result] (the kernel's answer for [root] over [facts] and [links], the SAME rows) up to projects: a milestone resolves to
     * its project, a project to itself; the root's own entities are left out, a link inside one project yields no pair.
     */
    fun rollUp(
        root: UInt,
        result: CriticalPathResult,
        facts: Collection<PlanMilestoneFact>,
        links: Collection<PlanLinkFact>,
    ): RoadmapCriticalPath {
        val projectOf = facts.associate { it.id to it.projectId }

        fun resolve(ref: EndpointRef): UInt? = if (ref.kind == EndpointKind.PROJECT) ref.id else projectOf[ref.id]

        val upstream = result.upstream.mapNotNull { up -> resolve(up.ref)?.takeIf { it != root }?.let { it to up } }
            .groupBy({ it.first }, { it.second })
            .map { (project, ups) ->
                RoadmapCriticalProject(
                    projectId = project,
                    slackDays = Math.toIntExact(ups.minOf { it.slackDays }),
                    critical = ups.any { it.critical },
                    hops = ups.minOf { it.hops },
                )
            }
            .sortedWith(compareBy({ it.hops }, { it.slackDays }, { it.projectId }))
        val pairs = links.filter { it.id in result.criticalDependencies }
            .mapNotNull { link ->
                val predecessor = resolve(link.predecessor)
                val successor = resolve(link.successor)
                if (predecessor == null || successor == null || predecessor == successor) null else predecessor to successor
            }
            .distinct()
            .sortedWith(compareBy({ it.first }, { it.second }))
            .map { RoadmapCriticalPair(it.first, it.second) }
        return RoadmapCriticalPath(root, upstream, pairs)
    }
}

/**
 * The chain toward [root] over the snapshot's own rows, the ONE step both `?criticalPath=N` views call (the roadmap's, 1.7, and the
 * programs view's, 1.16): no further statement. A plain `400` (no typed problem) when [root] is no ACTIVE project of the snapshot -
 * the id is a query value, plan ids are no secret and the page clears its own selection.
 */
internal fun RoadmapSnapshot.criticalPathTo(root: UInt): RoadmapCriticalPath {
    if (projects.none { it.id == root }) throw BadRequestException("Unknown or deleted project id: $root")
    val result = CriticalPathKernels.analyse(root, facts, linkFacts, calendar)
    return RoadmapCriticalPathKernels.rollUp(root, result, facts, linkFacts)
}
