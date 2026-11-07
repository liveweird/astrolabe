@file:OptIn(ExperimentalSerializationApi::class)

package ch.nokillswit.planning

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
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
    /** The runs of 3 or more working days inside [span] on which none of the project's milestones is in progress, by start. */
    val idleGaps: List<IdleGapView>,
    /** The entities of OTHER projects upstream of this project's end ([CriticalPath], `CriticalPathView.kt`). */
    val criticalPath: CriticalPath,
    /** The Jira connections a binding in scope links to (empty without a binding), once per document ([JiraSite]). */
    val jiraSites: List<JiraSite> = emptyList(),
    /** Present only for `?baseline=N`: the project against that baseline ([ProjectBaseline]); absent otherwise (bytes unchanged). */
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val baseline: ProjectBaseline? = null,
)

/** [DaySpan] on the wire: ISO `YYYY-MM-DD` strings, inclusive. */
@Serializable
data class DateSpan(val start: String, val end: String)

/**
 * The [PlanProject] fields plus the names of the project's program and work stream, and the project-level actions. [jira] is the
 * project's own Jira link (null = unbound; a disabled connection keeps it, dates null); [flags] its Jira flags
 * ([FlagKind.JIRA_DEVIATION] per open deviation of its own binding and the [FlagKind.JIRA_MILESTONES] roll-up of its milestones' - the
 * SAME list the roadmap row carries for the Jira kinds; the drift and rank flags are the roadmap's).
 */
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
    val jira: JiraLink? = null,
    val flags: List<PlanFlag> = emptyList(),
)

@Serializable
data class ProjectViewCan(
    val edit: Boolean,
    val delete: Boolean,
    val editTargetWindow: Boolean,
    val createMilestone: Boolean,
    val createDependency: Boolean,
)

/**
 * A milestone as the project view shows it: the [MilestoneResponse] fields (dates null = unscheduled) plus the caller's `can`, its Jira
 * link ([jira]: null = unbound; a disabled connection's dates are null) and its open Jira [flags] ([FlagKind.JIRA_DEVIATION] per
 * deviation).
 */
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
    /** Working days this milestone could slip before THIS project's end moves ([CriticalPathKernels]); null = unscheduled. */
    val slackDays: Int?,
    /** On the critical path: zero [slackDays] (every milestone ending on the project's end, and any driving chain into it). */
    val critical: Boolean,
    val can: ProjectMilestoneCan,
    val jira: JiraLink? = null,
    val flags: List<PlanFlag> = emptyList(),
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
    /** A zero-slack link on the viewed project's critical chain; always false on the team view (no per-project path is computed there). */
    val critical: Boolean,
    val can: ProjectDependencyCan,
)

/**
 * [edit]: the caller may change the link's type and lag (`PlanPermissions.canEditDependency`); [delete]: the caller may delete it
 * (`canDeleteDependency`). Both are `canManage` on the SUCCESSOR's project chain today - two flags so that the day the rules diverge no
 * client has to change.
 */
@Serializable
data class ProjectDependencyCan(val edit: Boolean, val delete: Boolean)
