package ch.nokillswit.planning

import ch.nokillswit.teams.CapacityPeriodResponse
import kotlinx.serialization.Serializable

/**
 * `GET /api/v1/views/team/{id}` - one team's schedule, capacity and load in one document (the documented view-endpoint shape
 * exception, `list-endpoints.md`; bounded by ONE team's milestones, about 100, their links and at most [MAX_LOAD_WEEKS] weeks). The
 * team's milestones are split like the page's two surfaces: [scheduled] (the timeline rows) and [unscheduled] (the tray), both in the
 * team's EFFECTIVE order ([effectiveOrder]: the team's own override first, then the global project rank).
 */
@Serializable
data class TeamView(
    /** The plan revision read FIRST, before the rows; the schedule PUT's `expectedRevision`. */
    val revision: Long,
    val team: TeamViewTeam,
    val order: TeamViewOrder,
    val capacity: TeamViewCapacity,
    /** One row per ISO week from the earliest scheduled start's Monday to the latest end's Sunday; empty while nothing is scheduled. */
    val weeks: List<WeekLoadView>,
    /** Whether the range was cut at [MAX_LOAD_WEEKS] weeks. */
    val weeksTruncated: Boolean,
    val scheduled: List<TeamMilestone>,
    val unscheduled: List<TeamMilestone>,
    /**
     * Every ACTIVE link with a MILESTONE end among the team's milestones, both ends resolved and checked, VIOLATED first - the project
     * view's [ProjectDependency] shape. Ends are resolved, not listed: there are no ghost rows.
     */
    val dependencies: List<ProjectDependency>,
)

/** The [ch.nokillswit.teams.TeamResponse] fields plus what the caller may do with the team's plan. */
@Serializable
data class TeamViewTeam(
    val id: UInt,
    val name: String,
    val description: String?,
    val managerPersonId: UInt?,
    val managerName: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val can: TeamViewCan,
)

/** Three names, one arithmetic ([PlanPermissions.canSchedule]): ADMIN, or the caller manages THIS team. */
@Serializable
data class TeamViewCan(val schedule: Boolean, val editCapacity: Boolean, val editOrder: Boolean)

/**
 * [custom]: the team has overridden the default order; [revision]: the team's order revision (`PUT /teams/{id}/milestone-order`'s);
 * [milestoneIds]: the stored custom order itself - the team's ACTIVE milestones currently on it that the manager listed, scheduled or not,
 * in stored position order (empty when not [custom]). The client needs the unscheduled listed ids to keep their places on its next PUT.
 */
@Serializable
data class TeamViewOrder(val custom: Boolean, val revision: Long, val milestoneIds: List<UInt>)

@Serializable
data class TeamViewCapacity(val periods: List<CapacityPeriodResponse>)

/** [WeekLoad] on the wire: man-day figures as numbers with two decimals, the week as its Monday's ISO date. */
@Serializable
data class WeekLoadView(
    val weekStart: String,
    val load: Double,
    val capacity: Double?,
    val overloaded: Boolean,
    val overloadMd: Double?,
    val maxWip: Int,
    val wipExceeded: Boolean,
)

/** A milestone of the team view: the [MilestoneResponse] fields plus the names of its project chain and its project's rank. */
@Serializable
data class TeamMilestone(
    val id: UInt,
    val projectId: UInt,
    val name: String,
    val description: String?,
    val teamId: UInt,
    val teamName: String,
    val estimateMd: Double,
    val startDate: String?,
    val endDate: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val projectName: String,
    val programName: String,
    val workStreamName: String,
    /** The project's position in the global project rank (1-based); null = unranked. */
    val rankPosition: Int?,
)

internal fun WeekLoad.toView() = WeekLoadView(
    weekStart = weekStart.toString(),
    load = load.toDouble(),
    capacity = capacity?.toDouble(),
    overloaded = overloaded,
    overloadMd = overloadMd?.toDouble(),
    maxWip = maxWip,
    wipExceeded = wipExceeded,
)
