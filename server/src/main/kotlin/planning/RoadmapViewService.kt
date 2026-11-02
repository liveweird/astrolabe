package ch.nokillswit.planning

import io.ktor.util.AttributeKey
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val RoadmapViewServiceKey = AttributeKey<RoadmapViewService>("RoadmapViewService")

/**
 * The roadmap document (`GET /views/roadmap`): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the project view's protocol)
 * that takes the RANKING's revision (V18, not the plan's) FIRST and the rows after ([loadRoadmapSnapshot]: the plan's rows through the
 * pure [RoadmapKernels]), then splits the projects into the ranked ones in position order and the unranked ones by name
 * (case-insensitive, then id). The snapshot keeps the revision and the rows consistent: a write that commits after the
 * transaction began is invisible to every statement of it. Reads `Projects ⋈ Programs ⋈ WorkStreams ⋈ People`,
 * `Milestones ⋈ Teams`, `Dependencies`, `RoadmapEntries` and `PublicHolidays` and writes nothing (`persistence.md`).
 */
class RoadmapViewService(private val database: R2dbcDatabase) {
    suspend fun view(actor: PlanActor, baselineId: UInt? = null): RoadmapView = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readRankingRevision()
        val header = baselineId?.let { requireActiveBaseline(it) }
        val snapshot = loadRoadmapSnapshot(actor)
        val overlay = header?.let { overlayRoadmap(it, snapshot.projects, snapshot.spans, snapshot.calendar) }
        val (ranked, unranked) = (overlay?.projects ?: snapshot.projects).partition { it.rankPosition != null }
        RoadmapView(
            revision = revision,
            can = RoadmapViewCan(PlanPermissions.canEditRank(actor)),
            teams = snapshot.teams,
            ranked = ranked.sortedBy { it.rankPosition }.map { RoadmapRankedProject(checkNotNull(it.rankPosition), it) },
            unranked = unranked.sortedWith(compareBy({ it.name.lowercase() }, { it.id })),
            links = snapshot.links,
            baseline = header?.let { RoadmapBaseline(it.id, it.name, it.planRevision, checkNotNull(overlay).removed) },
        )
    }
}
