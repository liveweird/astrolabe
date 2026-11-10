package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import kotlinx.serialization.Serializable
import java.time.LocalDate

/*
 * The seam through which the timeline views carry what an external tracker says about their rows (1.3: Jira). `planning` declares it
 * and may not name `jira` (`PackageBoundaryTest`): the Jira module implements it (`JiraFlagSource`) and the composition root
 * (`infra/db/Database.kt`) wires the implementation into the four view services - the `SyncConnectors` shape, inverted. The types
 * name the PRODUCT ("Jira"), not the package. A view built without a source (a test, a build without the Jira module) answers
 * [NoExternalFlags]: no link, no flag, no site. Since 1.9 the seam also carries a TEAM half (the team view's header flag and the weeks
 * strip's marked days, the Flow capacity deviation: `flow/FlowFlagSource`), and the views read every source through
 * [CompositeExternalFlagSource]. A milestone row's own calendar flag (`NO_WORKING_DAY`) is merged with the external ones, never replaced.
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

/** A run of calendar days a source marks, at a [severity]: the team view's strip marks each week it touches ([start], [end] inclusive). */
data class FlaggedRange(val start: LocalDate, val end: LocalDate, val severity: FlagSeverity)

/**
 * What the source answers for ONE team (1.9): its [flags] (the header's) and the day [ranges] behind them (the weeks strip's). A team has
 * no Jira link and the strip needs day ranges, so this is not a [NodeExternal].
 */
data class TeamExternal(val flags: List<PlanFlag>, val ranges: List<FlaggedRange>) {
    companion object {
        val NONE = TeamExternal(emptyList(), emptyList())
    }
}

/**
 * The answer for a request: the [projects] and [milestones] that have something to show, by id, the [sites] they link to, and (1.9) the
 * [teams] asked about.
 */
class ExternalFlags(
    val projects: Map<UInt, NodeExternal> = emptyMap(),
    val milestones: Map<UInt, NodeExternal> = emptyMap(),
    val sites: List<JiraSite> = emptyList(),
    val teams: Map<UInt, TeamExternal> = emptyMap(),
) {
    fun project(id: UInt): NodeExternal = projects[id] ?: NodeExternal.NONE

    fun milestone(id: UInt): NodeExternal = milestones[id] ?: NodeExternal.NONE

    fun team(id: UInt): TeamExternal = teams[id] ?: TeamExternal.NONE
}

/**
 * Which rows a view is about to answer. [projectIds] and [milestoneIds] name them; null = every one of that kind, an EMPTY collection =
 * none (never "every"); either BOTH are null (the whole plan: the roadmap and programs views) or both are named (the project view: the
 * project and ALL its milestones; the team view: no project, its milestones). A project's `JIRA_MILESTONES` roll-up is exact only when
 * the request names ALL of that project's milestones, so a source raises it only for the projects the request names. [calendar] is the
 * working calendar the view already read in its snapshot. [teamId] (1.9) is the one team the view is about (the team view only; null in
 * the other three): a source answers its [TeamExternal] under that id.
 */
class ExternalFlagRequest(
    val projectIds: Collection<UInt>?,
    val milestoneIds: Collection<UInt>?,
    val calendar: WorkingCalendar,
    val teamId: UInt? = null,
) {
    init {
        require((projectIds == null) == (milestoneIds == null)) { "Either both id sets are named or neither is (the whole plan)" }
    }

    /** No plan node is asked about (a node source answers without reading), whatever the team half says. */
    val namesNoNode: Boolean get() = projectIds?.isEmpty() == true && milestoneIds?.isEmpty() == true
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

/** A milestone row keeps its own calendar flag ([MilestoneFlagKernels]) and gains the node's [external] link and flags, in [FLAG_ORDER]. */
internal fun ProjectMilestone.withExternal(external: NodeExternal): ProjectMilestone =
    copy(jira = external.jira, flags = (flags + external.flags).sortedWith(FLAG_ORDER))

internal fun TeamMilestone.withExternal(external: NodeExternal): TeamMilestone =
    copy(jira = external.jira, flags = (flags + external.flags).sortedWith(FLAG_ORDER))

/**
 * [this] week strip with the weeks [ranges] touch marked (1.9): a week `weekStart..weekStart+6` that meets a range's `[start, end]` gets
 * the WORST severity among the ranges that meet it ([FlagSeverity.WARNING] before INFO); every other week is unchanged (no member on
 * the wire).
 */
internal fun List<WeekLoadView>.withFlaggedRanges(ranges: List<FlaggedRange>): List<WeekLoadView> =
    if (ranges.isEmpty()) {
        this
    } else {
        map { week ->
            val monday = LocalDate.parse(week.weekStart)
            val sunday = monday.plusDays(6)
            val worst = ranges.filter { !it.start.isAfter(sunday) && !it.end.isBefore(monday) }.minOfOrNull { it.severity }
            if (worst == null) week else week.copy(flowCapacity = worst)
        }
    }
