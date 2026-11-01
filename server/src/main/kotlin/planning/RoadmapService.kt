package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.insertRows
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*

val RoadmapServiceKey = AttributeKey<RoadmapService>("RoadmapService")

/**
 * The global project rank (V13 `roadmap_entries`): dense positions 1..n over the RANKED projects, every other active project is
 * unranked. A hard-delete position join rewritten wholesale (`persistence.md` "Soft delete"). Every write runs in [withPlanWrite], so
 * the revision compare and the rewrite are atomic with every other plan writer (`planning-model.md`).
 */
class RoadmapService(private val database: R2dbcDatabase) {
    object RoadmapEntries : Table("roadmap_entries") {
        val projectId = reference("project_id", ProjectService.Projects)
        val position = integer("position")
        override val primaryKey = PrimaryKey(projectId)
    }

    /**
     * Replaces the whole ranking under the plan lock. [guard] is the caller's `requireRoadmapEditorOrAdmin` re-run INSIDE the lock
     * (the grant is re-read, so a revocation that landed while the request was held open refuses the write: 403, no bump). Then the
     * revision compare against the RANKING's revision (V18: the plan revision at which the rank was last written; a plan write
     * elsewhere does not move it) — stale in both directions, a revision below it or above the current plan revision (409
     * `urn:astrolabe:problem:stale-revision`) — then every id must name an ACTIVE project (400), then the rewrite: the listed projects
     * get positions 1..n in order, every other project becomes unranked, and the ranking is stamped with the new plan revision.
     * Returns the plan revisions and the order it replaced for the audit trail; a throw anywhere rolls the bump back with the rest.
     */
    suspend fun replaceRanking(request: RankingUpdateRequest, guard: suspend () -> Unit): RankingOutcome {
        validateRanking(request)
        val ids = request.projectIds
        val write = database.withPlanWrite { revision ->
            guard()
            // A revision above the plan's current one is a view from the future (never a state the server produced): stale as well.
            if (readRankingRevision() > request.expectedRevision || request.expectedRevision > revision) {
                throw ConflictException(
                    "The ranking changed after revision ${request.expectedRevision}; reload the roadmap",
                    problemType = STALE_REVISION_PROBLEM,
                )
            }
            requireActiveProjects(ids)
            val before = RoadmapEntries.select(RoadmapEntries.projectId).orderBy(RoadmapEntries.position).toList()
                .map { it[RoadmapEntries.projectId].value }
            RoadmapEntries.deleteAll()
            RoadmapEntries.insertRows(ids.withIndex()) { (index, id) ->
                this[RoadmapEntries.projectId] = id
                this[RoadmapEntries.position] = index + 1
            }
            stampRankingRevision(revision + 1)
            before
        }
        return RankingOutcome(revisionFrom = write.revision - 1, revisionTo = write.revision, orderFrom = write.value)
    }
}

/**
 * Every id must name an ACTIVE project whose program and work stream are active too (the same visibility as the view) — a
 * client-supplied id is a 400, never a foreign-key 500.
 */
private suspend fun requireActiveProjects(ids: List<UInt>) {
    if (ids.isEmpty()) return
    val projects = ProjectService.Projects
    val programs = ProgramService.Programs
    val streams = WorkStreamService.WorkStreams
    val found = projects.innerJoin(programs, { projects.programId }, { programs.id })
        .innerJoin(streams, { programs.workStreamId }, { streams.id })
        .select(projects.id)
        .where { (projects.id inList ids) and projects.active() and programs.active() and streams.active() }
        .toList()
        .map { it[projects.id].value }.toSet()
    val missing = ids.filter { it !in found }
    if (missing.isNotEmpty()) {
        throw BadRequestException("Unknown or deleted project ids: ${missing.take(MAX_LISTED_MISSING).joinToString(", ")}")
    }
}

private const val MAX_LISTED_MISSING = 20

/**
 * Takes a deleted project out of the ranking and closes the gap: its `roadmap_entries` row is hard-deleted and the positions above
 * it shift down by one, so the ranking stays dense 1..n. Runs inside the caller's transaction — `ProjectService.delete` calls it in
 * the same plan-locked transaction as the soft delete. The sweep is ONE `UPDATE`, which `uq_roadmap_entries_position` (DEFERRABLE
 * INITIALLY DEFERRED, V13) only checks at commit. A compaction moved positions, so it stamps the ranking revision with
 * [newPlanRevision] (the revision the enclosing plan write leaves behind: `revision + 1`) — a roadmap view held across the delete
 * is stale. An unranked project is a no-op (no stamp: the ranking did not change).
 */
internal suspend fun removeFromRanking(projectId: UInt, newPlanRevision: Long) {
    val entries = RoadmapService.RoadmapEntries
    val position = entries.select(entries.position).where { entries.projectId eq projectId }.toList()
        .singleOrNull()?.get(entries.position) ?: return
    entries.deleteWhere { entries.projectId eq projectId }
    entries.update({ entries.position greater position }) { it[entries.position] = entries.position - 1 }
    stampRankingRevision(newPlanRevision)
}
