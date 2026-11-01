package ch.nokillswit.planning

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/** The most projects one ranking PUT may list (the plan's scale is about 100 projects). */
const val MAX_RANKED_PROJECTS = 1000

/**
 * `GET /api/v1/views/roadmap` — the global project rank in one document (the documented view-endpoint shape exception,
 * `list-endpoints.md`; bounded by the plan's scale of about 100 projects). [ranked] is the dense position order; [unranked] are the
 * active projects without a position, by name. [revision] is the plan revision read BEFORE the rows — the `expectedRevision` of the
 * ranking PUT.
 */
@Serializable
data class RoadmapView(
    val revision: Long,
    val can: RoadmapViewCan,
    val ranked: List<RoadmapRankedProject>,
    val unranked: List<RoadmapProject>,
)

/** [editRank]: the caller may `PUT /roadmap/ranking` (ADMIN or a `ROADMAP_EDITOR`, as `requireRoadmapEditorOrAdmin`). */
@Serializable
data class RoadmapViewCan(val editRank: Boolean)

@Serializable
data class RoadmapRankedProject(val position: Int, val project: RoadmapProject)

@Serializable
data class RoadmapProject(
    val id: UInt,
    val name: String,
    val programId: UInt,
    val programName: String,
    val workStreamId: UInt,
    val workStreamName: String,
    val ownerName: String,
    val targetStart: String?,
    val targetEnd: String?,
)

/**
 * The wholesale ranking: [projectIds] in rank order become positions 1..n and every other project becomes unranked; [expectedRevision]
 * is the plan revision the client's list was read at (a different current revision is a 409).
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
