package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import kotlinx.serialization.Serializable

/**
 * `GET /views/roadmap?baseline=N` and `GET /views/programs?baseline=N`: [id]/[name]/[planRevision] name the baseline the projects'
 * [RoadmapProjectBaseline] blocks compare to; [removedProjects] are the baseline's projects that are not active any more (by work
 * stream, program, name, id).
 */
@Serializable
data class RoadmapBaseline(
    val id: UInt,
    val name: String,
    val planRevision: Long,
    val removedProjects: List<RemovedProject>,
)

/**
 * A project the baseline froze that is gone now: its names as they were and the derived span it had ([span] null = nothing
 * scheduled), plus the ids of its program and work stream THEN (either may be gone too; the pages place the row by them).
 */
@Serializable
data class RemovedProject(
    val projectId: UInt,
    val name: String,
    val programId: UInt,
    val programName: String,
    val workStreamId: UInt,
    val workStreamName: String,
    val span: DateSpan?,
)

/**
 * One project row against the baseline: the derived [span] it had ([movement] compares it with the current one), its rank position and
 * target window then. Absent from the row when the project is newer than the baseline.
 */
@Serializable
data class RoadmapProjectBaseline(
    val span: DateSpan?,
    val movement: MovementView,
    val rankPosition: Int?,
    val targetStart: String?,
    val targetEnd: String?,
)

/**
 * The roadmap's (and programs') project rows with their `baseline` block, the baseline's projects that are gone, and the frozen spans
 * of the live projects the baseline also froze ([frozenSpans]: the key is present, the span null when it had nothing scheduled) - the
 * programs tree rolls those up.
 */
internal class RoadmapOverlay(val projects: List<RoadmapProject>, val removed: List<RemovedProject>, val frozenSpans: Map<UInt, DaySpan?>)

/**
 * Lays baseline [header]'s frozen projects over the live [projects] ([spans]: their derived spans, absent = none): one read of the
 * baseline's ~100 frozen project rows inside the view's snapshot, then [BaselineKernels.spanMovement] per project.
 */
internal suspend fun overlayRoadmap(
    header: BaselineHeader,
    projects: List<RoadmapProject>,
    spans: Map<UInt, DaySpan>,
    calendar: WorkingCalendar,
): RoadmapOverlay {
    val frozen = frozenProjects(header.id).associateBy { it.id }
    val rows = projects.map { p ->
        val then = frozen[p.id] ?: return@map p
        p.copy(
            baseline = RoadmapProjectBaseline(
                span = then.span?.toDateSpan(),
                movement = BaselineKernels.spanMovement(then.span, spans[p.id], calendar).toView(),
                rankPosition = then.rankPosition,
                targetStart = then.target?.start?.toString(),
                targetEnd = then.target?.end?.toString(),
            ),
        )
    }
    val live = projects.mapTo(HashSet()) { it.id }
    val removed = frozen.values.filter { it.id !in live }
        .sortedWith(compareBy({ it.workStreamName.lowercase() }, { it.programName.lowercase() }, { it.name.lowercase() }, { it.id }))
        .map { RemovedProject(it.id, it.name, it.programId, it.programName, it.workStreamId, it.workStreamName, it.span?.toDateSpan()) }
    return RoadmapOverlay(rows, removed, projects.filter { it.id in frozen }.associate { it.id to frozen.getValue(it.id).span })
}
