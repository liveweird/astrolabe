package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import kotlinx.serialization.Serializable

/*
 * The seam through which the timeline views carry what an external tracker says about their rows (1.3: Jira). `planning` declares it
 * and may not name `jira` (`PackageBoundaryTest`): the Jira module implements it (`JiraFlagSource`) and the composition root
 * (`infra/db/Database.kt`) wires the implementation into the four view services - the `SyncConnectors` shape, inverted. The types
 * name the PRODUCT ("Jira"), not the package. A view built without a source (a test, a build without the Jira module) answers
 * [NoExternalFlags]: no link, no flag, no site.
 */

/**
 * A bound epic's children as the last census holds them (1.4): how many ([children], at least 1), how many are done, their story-points
 * sum ([points], never converted to man-days; null when no child carries a value) and the newest observation ([observedAt], epoch
 * millis). The source reads it from the same loader the deviations view uses.
 */
@Serializable
data class JiraRollup(val children: Int, val done: Int, val points: Double?, val observedAt: Long)

/**
 * A plan node's Jira item as the views show it. [start] and [end] are the dates Jira was last observed to hold (ISO), null when the
 * item was never observed or is gone. The browse URL is NOT per row: [JiraSite.siteUrl] is carried once per document and the client
 * builds `siteUrl + "/browse/" + issueKey`. [rollup] is always present (no default, so the response encoder writes it): null for a
 * project link, a disabled connection, a gone issue, or an epic with no mirrored child.
 */
@Serializable
data class JiraLink(
    val bindingId: UInt,
    val connectionId: UInt,
    val issueKey: String,
    val start: String?,
    val end: String?,
    val rollup: JiraRollup?,
)

/** A Jira connection a binding in the document's scope links to: the site its keys belong to. Never its name or any credential. */
@Serializable
data class JiraSite(val connectionId: UInt, val siteUrl: String)

/** What the source answers for ONE node: its [jira] link (null = not bound, or bound through a disabled connection) and its [flags]. */
data class NodeExternal(val jira: JiraLink?, val flags: List<PlanFlag>) {
    companion object {
        val NONE = NodeExternal(null, emptyList())
    }
}

/** The answer for a request: the [projects] and [milestones] that have something to show, by id, and the [sites] they link to. */
class ExternalFlags(
    val projects: Map<UInt, NodeExternal> = emptyMap(),
    val milestones: Map<UInt, NodeExternal> = emptyMap(),
    val sites: List<JiraSite> = emptyList(),
) {
    fun project(id: UInt): NodeExternal = projects[id] ?: NodeExternal.NONE

    fun milestone(id: UInt): NodeExternal = milestones[id] ?: NodeExternal.NONE
}

/**
 * Which rows a view is about to answer. [projectIds] and [milestoneIds] name them; null = every one of that kind, an EMPTY collection =
 * none (never "every"); either BOTH are null (the whole plan: the roadmap and programs views) or both are named (the project view: the
 * project and ALL its milestones; the team view: no project, its milestones). A project's `JIRA_MILESTONES` roll-up is exact only when
 * the request names ALL of that project's milestones, so a source raises it only for the projects the request names. [calendar] is the
 * working calendar the view already read in its snapshot.
 */
class ExternalFlagRequest(val projectIds: Collection<UInt>?, val milestoneIds: Collection<UInt>?, val calendar: WorkingCalendar) {
    init {
        require((projectIds == null) == (milestoneIds == null)) { "Either both id sets are named or neither is (the whole plan)" }
    }

    /** Nothing is asked about: a source answers [ExternalFlags] without reading. */
    val isEmpty: Boolean get() = projectIds?.isEmpty() == true && milestoneIds?.isEmpty() == true
}

interface ExternalFlagSource {
    /**
     * The links and flags of the requested rows, read INSIDE the caller's `READ ONLY REPEATABLE READ` snapshot (the view's transaction,
     * after its calendar): one source of truth with the view's own rows. Reads only.
     */
    suspend fun flagsInTransaction(request: ExternalFlagRequest): ExternalFlags
}

/** The source of a view with no external tracker. */
object NoExternalFlags : ExternalFlagSource {
    override suspend fun flagsInTransaction(request: ExternalFlagRequest): ExternalFlags = ExternalFlags()
}

/** [this] row with the node's [external] link and flags folded in, the flags in [FLAG_ORDER]. */
internal fun RoadmapProject.withExternal(external: NodeExternal): RoadmapProject =
    copy(jira = external.jira, flags = (flags + external.flags).sortedWith(FLAG_ORDER))

internal fun ProjectMilestone.withExternal(external: NodeExternal): ProjectMilestone = copy(jira = external.jira, flags = external.flags)

internal fun TeamMilestone.withExternal(external: NodeExternal): TeamMilestone = copy(jira = external.jira, flags = external.flags)
