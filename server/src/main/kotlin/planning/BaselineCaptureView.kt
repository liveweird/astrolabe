package ch.nokillswit.planning

import kotlinx.serialization.Serializable

/*
 * The wire pieces of what a baseline froze besides the dated structure (V33): the comparison view's `links` and `capacity` blocks
 * (`BaselineView`) and the team overlay's `capacity` (`TeamBaseline`). `captured` false = the baseline (or, with `?against=`, one of the
 * two) was taken before 1.26 and froze none of it: the block is then empty, which means UNKNOWN, never "nothing changed".
 */

/** [MAX_BASELINE_LINK_ROWS] and [MAX_BASELINE_CAPACITY_ROWS]: the most changed rows the blocks list; the totals always cover every row. */
const val MAX_BASELINE_LINK_ROWS = 1_000
const val MAX_BASELINE_CAPACITY_ROWS = 2_000

/**
 * One end of a changed link: its [kind] and [id], its [name] (the "now" side's when it exists there) and, for a milestone, its
 * project ([projectId] and [projectName]; null for a project end, whose [id] is the project).
 */
@Serializable
data class BaselineLinkEnd(val kind: EndpointKind, val id: UInt, val name: String, val projectId: UInt?, val projectName: String?)

/** A link's terms on one side. */
@Serializable
data class LinkTerms(val type: DependencyType, val lagDays: Int)

/** One changed link: [then] is null for an ADDED one, [now] for a REMOVED one. */
@Serializable
data class BaselineLinkItem(
    val dependencyId: UInt,
    val change: LinkChangeKind,
    val predecessor: BaselineLinkEnd,
    val successor: BaselineLinkEnd,
    val then: LinkTerms?,
    val now: LinkTerms?,
)

@Serializable
data class BaselineLinkTotals(val added: Int, val removed: Int, val changed: Int, val unchanged: Int)

/** The links block: [totals] over every link, [items] the changed ones by dependency id (at most [MAX_BASELINE_LINK_ROWS]). */
@Serializable
data class BaselineLinks(
    val captured: Boolean,
    val totals: BaselineLinkTotals,
    val items: List<BaselineLinkItem>,
    val truncated: Boolean,
)

/** A capacity figure: man-days per week and the WIP limit (null = none). */
@Serializable
data class BaselineCapacityFigure(val mdPerWeek: Double, val wipLimit: Int?)

/** A range on which a team's capacity differs: [to] null = without end, [then]/[now] null = no capacity in force on that side. */
@Serializable
data class BaselineCapacityChange(val from: String, val to: String?, val then: BaselineCapacityFigure?, val now: BaselineCapacityFigure?)

@Serializable
data class BaselineCapacityTeam(val teamId: UInt, val teamName: String, val changes: List<BaselineCapacityChange>)

/** [teams] counts the teams with capacity on either side, [changedTeams] those whose capacity differs. */
@Serializable
data class BaselineCapacityTotals(val teams: Int, val changedTeams: Int)

/** The capacity block of the comparison: the changed teams by name, at most [MAX_BASELINE_CAPACITY_ROWS] change rows in all. */
@Serializable
data class BaselineCapacity(
    val captured: Boolean,
    val totals: BaselineCapacityTotals,
    val teams: List<BaselineCapacityTeam>,
    val truncated: Boolean,
)

/** One stretch of a team's frozen capacity: [to] null = without end (the team view's "was" capacity). */
@Serializable
data class BaselineCapacityRange(val from: String, val to: String?, val mdPerWeek: Double, val wipLimit: Int?)

/** `TeamBaseline.capacity`: the viewed team's capacity as the baseline froze it, by start; [periods] is empty when not [captured]. */
@Serializable
data class BaselineTeamCapacity(val captured: Boolean, val periods: List<BaselineCapacityRange>)
