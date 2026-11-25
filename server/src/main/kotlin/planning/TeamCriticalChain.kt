package ch.nokillswit.planning

import kotlinx.serialization.Serializable
import java.util.TreeSet

/** At most this many members of the team view's chain block are listed, the nearest to the team's milestones first. */
const val MAX_TEAM_CHAIN_MEMBERS = 100

/** At most this many links of the team view's chain block are listed (both ends are listed members). */
const val MAX_TEAM_CHAIN_LINKS = 500

/**
 * The team view's `criticalChain` (1.27, `?criticalChain=true` only): the critical chain's members that are NOT the team's own
 * milestones - other teams' milestones, and a whole project when a chain link names it - and the chain's [links] between two such
 * members ([links] with an end among the team's milestones are already `dependencies[]` rows, `critical: true`). [truncated]: either
 * list was cut at [MAX_TEAM_CHAIN_MEMBERS] / [MAX_TEAM_CHAIN_LINKS].
 */
@Serializable
data class TeamCriticalChain(val members: List<TeamChainMember>, val links: List<TeamChainLink>, val truncated: Boolean)

/**
 * One member: a milestone ([teamId]/[teamName] its team, [projectId] its project) or a whole project ([projectId] its own id, no
 * team; the dates its derived span). [hops] is the fewest links to one of the team's milestones, [chainOf] the ids of the team's
 * projects (ascending) whose chain holds it.
 */
@Serializable
data class TeamChainMember(
    val kind: EndpointKind,
    val id: UInt,
    val name: String,
    val projectId: UInt,
    val projectName: String,
    val teamId: UInt?,
    val teamName: String?,
    val startDate: String,
    val endDate: String,
    val hops: Int,
    val chainOf: List<UInt>,
)

/** One chain link between two listed members, by id and kind (the members carry the names). */
@Serializable
data class TeamChainLink(val id: UInt, val predecessor: EndpointRef, val successor: EndpointRef, val type: DependencyType, val lagDays: Int)

/** Nearest first, then like the project view's chain: start date, end date, name (case-insensitive), kind, id. */
private val MEMBER_ORDER: Comparator<TeamChainMember> =
    compareBy({ it.hops }, { it.startDate }, { it.endDate }, { it.name.lowercase() }, { it.kind }, { it.id })

/**
 * Assembles the block (pure) from [load], whose results hold one [CriticalChain] per project the team works on: the union of their
 * members (one per kind and id: `hops` the minimum, `chainOf` the union) and links (one per id). Members are ordered by [MEMBER_ORDER]
 * and cut at [maxMembers]; every member with fewer hops is kept, so a cut shortens the far end of the chain. A link is listed only
 * between two kept members, nearest first (the larger of its ends' hops, then the id), at most [maxLinks].
 */
internal fun teamCriticalChain(load: CriticalPathsLoad, maxMembers: Int, maxLinks: Int): TeamCriticalChain {
    val hops = HashMap<EndpointRef, Int>()
    val chainOf = HashMap<EndpointRef, TreeSet<UInt>>()
    val linkIds = HashSet<UInt>()
    for ((projectId, result) in load.results) {
        for (member in result.chain.members) {
            hops.merge(member.ref, member.hops) { a, b -> minOf(a, b) }
            chainOf.getOrPut(member.ref) { TreeSet() }.add(projectId)
        }
        linkIds.addAll(result.chain.linkIds)
    }
    val facts = load.milestones.map { it.fact }
    val milestones = load.milestones.associateBy { it.fact.id }
    val projectSpans by lazy { RoadmapKernels.projectSpans(facts) }
    // Every member has scheduled work, so its row, name and span exist: a miss is a broken invariant, fail closed.
    val members = hops.map { (ref, nearest) ->
        val row = if (ref.kind == EndpointKind.MILESTONE) checkNotNull(milestones[ref.id]) else null
        val projectId = row?.fact?.projectId ?: ref.id
        val span = checkNotNull(if (row != null) row.fact.span else projectSpans[ref.id])
        TeamChainMember(
            kind = ref.kind, id = ref.id, name = row?.name ?: load.projectNames.getValue(ref.id),
            projectId = projectId, projectName = load.projectNames.getValue(projectId),
            teamId = row?.fact?.teamId, teamName = row?.teamName,
            startDate = span.start.toString(), endDate = span.end.toString(), hops = nearest, chainOf = chainOf.getValue(ref).toList(),
        )
    }.sortedWith(MEMBER_ORDER)
    val kept = members.take(maxMembers)
    val keptHops = kept.associate { EndpointRef(it.kind, it.id) to it.hops }
    val between = load.links.filter { it.id in linkIds && it.predecessor in keptHops && it.successor in keptHops }
        .sortedWith(compareBy({ maxOf(keptHops.getValue(it.predecessor), keptHops.getValue(it.successor)) }, { it.id }))
    return TeamCriticalChain(
        members = kept,
        links = between.take(maxLinks).map { TeamChainLink(it.id, it.predecessor, it.successor, it.type, it.lagDays) },
        truncated = members.size > maxMembers || between.size > maxLinks,
    )
}
