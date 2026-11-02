package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import kotlinx.serialization.Serializable

/**
 * `GET /views/project/{id}?baseline=N`: the project against baseline [id]. [project] is the project's own span then and its movement
 * (null = the project is newer than the baseline); [milestones] has one entry per LIVE milestone of the project that the baseline also
 * froze (scheduled or in the tray; a live milestone without an entry is new since the baseline); [removed] are the baseline's
 * milestones of this project that are gone now.
 */
@Serializable
data class ProjectBaseline(
    val id: UInt,
    val name: String,
    val planRevision: Long,
    val project: SpanBaseline?,
    val milestones: List<BaselineMilestone>,
    val removed: List<RemovedMilestone>,
)

/**
 * Builds the overlay inside the view's snapshot: the frozen project row (one primary-key read), the project's frozen milestones
 * (`idx_baseline_milestones_project`) and the names of the teams the removed ones sat on. [live] are the project's ACTIVE milestones.
 */
internal suspend fun projectBaseline(
    header: BaselineHeader,
    projectId: UInt,
    liveSpan: DaySpan?,
    live: List<LiveMilestone>,
    calendar: WorkingCalendar,
): ProjectBaseline {
    val frozenProject = frozenProject(header.id, projectId)
    val frozen = frozenMilestonesOfProject(header.id, projectId)
    val liveById = live.associateBy { it.id }
    val removed = frozen.filter { it.id !in liveById }
    val teams = teamNames(removed.map { it.teamId })
    return ProjectBaseline(
        id = header.id,
        name = header.name,
        planRevision = header.planRevision,
        project = frozenProject?.let {
            SpanBaseline(it.span?.toDateSpan(), BaselineKernels.spanMovement(it.span, liveSpan, calendar).toView())
        },
        milestones = frozen.mapNotNull { f -> liveById[f.id]?.let { frozenFigures(f, it, calendar) } },
        removed = removed.map { it.toRemoved(teams.getValue(it.teamId), now = null) }.inAppendOrder(),
    )
}
