@file:OptIn(ExperimentalSerializationApi::class)

package ch.nokillswit.planning

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

/** The most projects one ranking PUT may list (the plan's scale is about 100 projects). */
const val MAX_RANKED_PROJECTS = 1000

/**
 * `GET /api/v1/views/roadmap` — the global project rank in one document (the documented view-endpoint shape exception,
 * `list-endpoints.md`; bounded by the plan's scale of about 100 projects). [ranked] is the dense position order; [unranked] are the
 * active projects without a position, by name. [revision] is the RANKING's revision (V18: the plan revision at which the rank was last
 * written) read BEFORE the rows — the `expectedRevision` of the ranking PUT. Since v0.6: every project carries its derived span, drift
 * and flags, [teams] are the filter's options and [links] the project pairs' rolled-up dependencies (`RoadmapKernels.kt`).
 */
@Serializable
data class RoadmapView(
    val revision: Long,
    val can: RoadmapViewCan,
    val teams: List<RoadmapTeam>,
    val ranked: List<RoadmapRankedProject>,
    val unranked: List<RoadmapProject>,
    val links: List<RoadmapLink>,
    /** The Jira connections a binding in scope links to (empty without a binding), once per document ([JiraSite]). */
    val jiraSites: List<JiraSite> = emptyList(),
    /** Present only for `?baseline=N`: which baseline the projects' `baseline` blocks compare to, and the projects it had that are gone. */
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val baseline: RoadmapBaseline? = null,
)

/** [editRank]: the caller may `PUT /roadmap/ranking` (ADMIN or a `ROADMAP_EDITOR`, as `requireRoadmapEditorOrAdmin`). */
@Serializable
data class RoadmapViewCan(val editRank: Boolean)

/** An ACTIVE team with at least one active milestone in the plan: an option of the roadmap's team filter. */
@Serializable
data class RoadmapTeam(val id: UInt, val name: String)

@Serializable
data class RoadmapRankedProject(val position: Int, val project: RoadmapProject)

/**
 * One project row of the roadmap (and, since v0.6, of the programs view: ONE schema). [span] is DERIVED from its scheduled milestones
 * and [drift] is that span against the target window; [flags] are the drift and rank-inversion flags raised ON this project, WARNING
 * first ([FLAG_ORDER]), plus (1.3) the Jira flags of an ENABLED connection's OPEN deviations ([FlagKind.JIRA_DEVIATION] per deviation
 * of the project's own binding, one [FlagKind.JIRA_MILESTONES] roll-up of its milestones'); [teamIds] are the teams of ALL its active
 * milestones, ascending; [rankPosition] is null while unranked. [jira] is the project's own Jira link, null when it is unbound or its
 * connection is disabled.
 */
@Serializable
data class RoadmapProject(
    val id: UInt,
    val name: String,
    val programId: UInt,
    val programName: String,
    val workStreamId: UInt,
    val workStreamName: String,
    val ownerPersonId: UInt,
    val ownerName: String,
    val targetStart: String?,
    val targetEnd: String?,
    val rankPosition: Int?,
    val teamIds: List<UInt>,
    val span: DateSpan?,
    val drift: Drift?,
    val flags: List<PlanFlag>,
    val can: RoadmapProjectCan,
    val jira: JiraLink? = null,
    /** Present only for `?baseline=N` and a project the baseline also froze (absent = the project is newer than the baseline). */
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val baseline: RoadmapProjectBaseline? = null,
)

/** [editTargetWindow]: the caller may `PUT /projects/{id}/target-window` ([PlanPermissions.canEditTargetWindow]). */
@Serializable
data class RoadmapProjectCan(val editTargetWindow: Boolean)

/**
 * What a flag is about; the declaration order is the flags' order within a severity. The Jira kinds come last (1.3):
 * [JIRA_DEVIATION] is one open deviation between a node and its Jira item, [JIRA_MILESTONES] a project's roll-up of its milestones'.
 */
@Serializable
enum class FlagKind { DRIFT_END_LATE, DRIFT_START_LATE, DRIFT_END_EARLY, RANK_INVERSION, JIRA_DEVIATION, JIRA_MILESTONES }

/** WARNING sorts before INFO. */
@Serializable
enum class FlagSeverity { WARNING, INFO }

/**
 * One flag raised on a project. [days] is the drift in calendar days (always positive) or, for an inversion, how many calendar days
 * earlier this project starts than [otherProjectId]; [teamId] is the shared team of a per-team inversion (null for the no-shared-team
 * INFO and for drift); [otherProjectId] is the higher-ranked project of an inversion. A [FlagKind.JIRA_DEVIATION] carries its
 * [deviation] (the evidence; [days] stays null, the detail holds them) and a [FlagKind.JIRA_MILESTONES] its [count] of milestones with
 * an open deviation (the severity is the worst among them); both members are null on every other kind.
 */
@Serializable
data class PlanFlag(
    val kind: FlagKind,
    val severity: FlagSeverity,
    val days: Int?,
    val teamId: UInt?,
    val otherProjectId: UInt?,
    val deviation: Deviation? = null,
    val count: Int? = null,
)

/** The number of WARNING and INFO flags over a set of projects (a program's or work stream's roll-up). */
@Serializable
data class FlagCounts(val warnings: Int, val infos: Int)

/**
 * The dependencies between two projects, rolled up: ONE entry per ORDERED pair (predecessor project, successor project). [direct] is
 * the project-to-project link (at most one per ordered pair: the partial unique index), [milestoneLinks] counts every link between the
 * pair that has a milestone on either end. Links inside one project are not on the roadmap.
 */
@Serializable
data class RoadmapLink(
    val predecessorProjectId: UInt,
    val successorProjectId: UInt,
    val direct: RoadmapDirectLink?,
    val milestoneLinks: RoadmapLinkBundle,
)

@Serializable
data class RoadmapDirectLink(val id: UInt, val type: DependencyType, val lagDays: Int, val check: DependencyCheck)

/** [count] links with a milestone end, of which [violated] are violated and [unscheduled] could not be evaluated. */
@Serializable
data class RoadmapLinkBundle(val count: Int, val violated: Int, val unscheduled: Int)

/**
 * The wholesale ranking: [projectIds] in rank order become positions 1..n and every other project becomes unranked; [expectedRevision]
 * is the ranking revision the client's list was read at (a 409 when the ranking was written later, or the value exceeds the plan's).
 */
@Serializable
data class RankingUpdateRequest(
    val expectedRevision: Long,
    val projectIds: List<UInt>,
)

@Serializable
data class RankingResponse(val revision: Long)

/** What a ranking write replaced, for the audit trail: the revisions around it and the ranked order BEFORE it. */
data class RankingOutcome(val revisionFrom: Long, val revisionTo: Long, val orderFrom: List<UInt>)

/** The request-shape rules checked before the lock: at most [MAX_RANKED_PROJECTS] ids, no id twice. */
fun validateRanking(request: RankingUpdateRequest) {
    val ids = request.projectIds
    if (ids.size > MAX_RANKED_PROJECTS) throw BadRequestException("projectIds must list at most $MAX_RANKED_PROJECTS projects")
    if (ids.toSet().size != ids.size) throw BadRequestException("projectIds must be distinct")
}
