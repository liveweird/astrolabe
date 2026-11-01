package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import kotlinx.serialization.Serializable

/** At most this many NON-critical upstream entities are listed; the critical ones are never cut. */
const val UPSTREAM_CAP = 100

/**
 * The project view's `criticalPath`: the [upstream] entities of OTHER projects whose slip would eventually move this project's end -
 * the critical ones first (the chain, read from its origin by start date), then the rest by slack - and whether the non-critical
 * part was cut at [UPSTREAM_CAP].
 */
@Serializable
data class CriticalPath(val upstream: List<UpstreamEntity>, val upstreamTruncated: Boolean)

/**
 * A milestone or a project of another project that lies upstream of the viewed project's end. For a project [projectId] is its own
 * id; the dates are the STORED ones (a project's derived span). [slackDays] >= 0, [critical] = zero slack, [hops] >= 1 = the fewest
 * links to the viewed project ([UpstreamRef]).
 */
@Serializable
data class UpstreamEntity(
    val kind: EndpointKind,
    val id: UInt,
    val name: String,
    val projectId: UInt,
    val projectName: String,
    val startDate: String,
    val endDate: String,
    val slackDays: Int,
    val critical: Boolean,
    val hops: Int,
)

/** The critical chain from its origin: start date, end date, name (case-insensitive), kind, id. */
private val CHAIN_ORDER: Comparator<UpstreamEntity> =
    compareBy({ it.startDate }, { it.endDate }, { it.name.lowercase() }, { it.kind }, { it.id })

/** The non-critical rest: the least slack first, then like the chain. */
private val SLACK_ORDER: Comparator<UpstreamEntity> =
    compareBy<UpstreamEntity> { it.slackDays }.then(CHAIN_ORDER)

/**
 * Orders [entries] for the wire and applies the cap: every critical entry (never truncated) in [CHAIN_ORDER], then the others by
 * [SLACK_ORDER], at most [cap] of them (`upstreamTruncated` when more existed).
 */
fun orderUpstream(entries: List<UpstreamEntity>, cap: Int = UPSTREAM_CAP): CriticalPath {
    val (critical, rest) = entries.partition { it.critical }
    val others = rest.sortedWith(SLACK_ORDER)
    return CriticalPath(critical.sortedWith(CHAIN_ORDER) + others.take(cap), others.size > cap)
}

/** What [loadCriticalPath] hands the project view: the kernel's per-milestone figures and the wire block. */
internal class ProjectCriticalPath(val result: CriticalPathResult, val view: CriticalPath)

/**
 * Loads the whole active plan graph (every milestone with its name, every link, every project name: the roadmap's shared loaders)
 * INSIDE the view's snapshot and runs [CriticalPathKernels] for project [projectId]. A milestone whose project row is not active
 * (only a hand-edited database has one) is left out, so every upstream entry can name its project.
 */
internal suspend fun loadCriticalPath(projectId: UInt, calendar: WorkingCalendar): ProjectCriticalPath {
    val projectNames = activeProjectNames()
    val rows = milestoneFacts().filter { it.fact.projectId in projectNames }
    val facts = rows.map { it.fact }
    val result = CriticalPathKernels.analyse(projectId, facts, linkFacts(), calendar)
    val milestones = rows.associateBy { it.fact.id }
    val projectSpans = RoadmapKernels.projectSpans(facts)
    // Every upstream entity has scheduled work (it has values), so its row, name and span exist: a miss is a broken invariant, fail closed.
    val entries = result.upstream.map { up ->
        val ref = up.ref
        val milestone = if (ref.kind == EndpointKind.MILESTONE) checkNotNull(milestones[ref.id]) else null
        val owner = milestone?.fact?.projectId ?: ref.id
        val span = checkNotNull(if (milestone != null) milestone.fact.span else projectSpans[ref.id])
        UpstreamEntity(
            kind = ref.kind,
            id = ref.id,
            name = milestone?.name ?: projectNames.getValue(ref.id),
            projectId = owner,
            projectName = projectNames.getValue(owner),
            startDate = span.start.toString(),
            endDate = span.end.toString(),
            slackDays = Math.toIntExact(up.slackDays),
            critical = up.critical,
            hops = up.hops,
        )
    }
    return ProjectCriticalPath(result, orderUpstream(entries))
}
