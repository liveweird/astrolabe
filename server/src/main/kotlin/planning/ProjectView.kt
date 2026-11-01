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
    /**
     * Every ACTIVE link with an end in this project (the project itself or one of its milestones), both ends resolved and checked,
     * VIOLATED first ([ProjectDependency], `ProjectViewDependencies.kt`). Bounded by one project's links and the external projects
     * they touch.
     */
    val dependencies: List<ProjectDependency>,
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
data class ProjectViewCan(
    val edit: Boolean,
    val delete: Boolean,
    val editTargetWindow: Boolean,
    val createMilestone: Boolean,
    val createDependency: Boolean,
)

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

/**
 * A link of the project view: both [predecessor] and [successor] resolved ([DependencyEndpoint]; a project end carries its DERIVED
 * span, an end in another project its own project's name), the stored [type] and [lagDays], its [check] and the caller's `can`.
 */
@Serializable
data class ProjectDependency(
    val id: UInt,
    val predecessor: DependencyEndpoint,
    val successor: DependencyEndpoint,
    val type: DependencyType,
    val lagDays: Int,
    val check: DependencyCheck,
    val can: ProjectDependencyCan,
)

/** [delete]: the caller may delete the link (`canManage` on the SUCCESSOR's project chain, `PlanPermissions.canDeleteDependency`). */
@Serializable
data class ProjectDependencyCan(val delete: Boolean)
