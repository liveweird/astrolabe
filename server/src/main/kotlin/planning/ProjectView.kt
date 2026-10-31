package ch.nokillswit.planning

import kotlinx.serialization.Serializable

/**
 * `GET /api/v1/views/project/{id}` — one project and its milestones in one document (the documented view-endpoint shape exception,
 * `list-endpoints.md`; bounded by ONE project's milestones, about 50). The milestones are split like the page's two surfaces: the
 * [scheduled] ones (the timeline rows) and the [unscheduled] ones (the tray). [span] and [drift] are DERIVED, never stored
 * ([SpanKernels]); every node carries the actions the CALLER may take (`can`, [PlanPermissions]).
 */
@Serializable
data class ProjectView(
    /** The plan revision read FIRST, before the rows; the client sends it back as a schedule write's `expectedRevision`. */
    val revision: Long,
    val project: ProjectViewProject,
    /** The earliest start to the latest end over the scheduled milestones; null when nothing is scheduled. */
    val span: DateSpan?,
    /** [span] against the project's target window, positive = later than the target; null unless both exist. */
    val drift: Drift?,
    /** By start, end, name (case-insensitive), id. */
    val scheduled: List<ProjectMilestone>,
    /** By name (case-insensitive), id. */
    val unscheduled: List<ProjectMilestone>,
)

/** [DaySpan] on the wire: ISO `YYYY-MM-DD` strings, inclusive. */
@Serializable
data class DateSpan(val start: String, val end: String)

/** The [PlanProject] fields plus the names of the project's program and work stream, and the project-level actions. */
@Serializable
data class ProjectViewProject(
    val id: UInt,
    val programId: UInt,
    val workStreamId: UInt,
    val programName: String,
    val workStreamName: String,
    val name: String,
    val description: String?,
    val ownerPersonId: UInt,
    val ownerName: String,
    val targetStart: String?,
    val targetEnd: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val can: ProjectViewCan,
)

@Serializable
data class ProjectViewCan(val edit: Boolean, val delete: Boolean, val editTargetWindow: Boolean, val createMilestone: Boolean)

/** A milestone as the project view shows it: the [MilestoneResponse] fields (dates null = unscheduled) plus the caller's `can`. */
@Serializable
data class ProjectMilestone(
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
    val can: ProjectMilestoneCan,
)

@Serializable
data class ProjectMilestoneCan(val edit: Boolean, val delete: Boolean, val schedule: Boolean)
