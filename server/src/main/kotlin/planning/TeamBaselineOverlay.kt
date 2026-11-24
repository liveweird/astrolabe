package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import kotlinx.serialization.Serializable

/**
 * `GET /views/team/{id}?baseline=N`: the team against baseline [id]. [milestones] has one entry per LIVE milestone of the team that the
 * baseline also froze, whatever team it sat on then (`teamIdThen` differing from the viewed team reads "from {team}"); [removed] are
 * the baseline's milestones of THIS team that are not on it any more: gone ([RemovedMilestone.now] absent) or moved to another team.
 * [capacity] is the team's frozen capacity as ranges (`captured: false` and no ranges for a baseline taken before 1.26).
 */
@Serializable
data class TeamBaseline(
    val id: UInt,
    val name: String,
    val planRevision: Long,
    val milestones: List<BaselineMilestone>,
    val removed: List<RemovedMilestone>,
    /** The team's capacity periods as the baseline froze them (1.26): the "was" the capacity chart and the team's figures compare with. */
    val capacity: BaselineTeamCapacity,
)

/**
 * Builds the overlay inside the view's snapshot. The frozen rows are the team's (`idx_baseline_milestones_team`) plus those of the
 * [live] milestones that sat on another team then (the primary key); the removed ones are looked up once for the team they sit on now.
 */
internal suspend fun teamBaseline(
    header: BaselineHeader,
    teamId: UInt,
    teamName: String,
    live: List<LiveMilestone>,
    calendar: WorkingCalendar,
): TeamBaseline {
    val ownFrozen = frozenMilestonesOfTeam(header.id, teamId)
    val ownIds = ownFrozen.mapTo(HashSet()) { it.id }
    val visitors = frozenMilestonesById(header.id, live.map { it.id }.filter { it !in ownIds })
    val frozenById = (ownFrozen + visitors).associateBy { it.id }
    val liveIds = live.mapTo(HashSet()) { it.id }
    val gone = ownFrozen.filter { it.id !in liveIds }
    val now = liveTeamsOfMilestones(gone.map { it.id })
    return TeamBaseline(
        id = header.id,
        name = header.name,
        planRevision = header.planRevision,
        milestones = live.mapNotNull { l -> frozenById[l.id]?.let { frozenFigures(it, l, calendar) } }.sortedBy { it.milestoneId },
        removed = gone.map { it.toRemoved(teamName, now[it.id]) }.inAppendOrder(),
        capacity = teamCapacityThen(header, teamId),
    )
}

/** The team's capacity as [header] froze it, by start (`idx_baseline_capacity_periods_team`); not captured when the header has no count. */
private suspend fun teamCapacityThen(header: BaselineHeader, teamId: UInt): BaselineTeamCapacity {
    if (header.capacityPeriodCount == null) return BaselineTeamCapacity(captured = false, periods = emptyList())
    val ranges = BaselineCapacityKernels.ranges(frozenCapacityOfTeam(header.id, teamId))
    return BaselineTeamCapacity(
        captured = true,
        periods = ranges.map {
            BaselineCapacityRange(it.from.toString(), it.to?.toString(), it.figure.mdPerWeek.toDouble(), it.figure.wipLimit)
        },
    )
}
