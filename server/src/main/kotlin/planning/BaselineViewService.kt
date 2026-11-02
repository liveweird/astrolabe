package ch.nokillswit.planning

import io.ktor.util.AttributeKey
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val BaselineViewServiceKey = AttributeKey<BaselineViewService>("BaselineViewService")

/**
 * The comparison document (`GET /views/baseline/{id}`): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the views' protocol)
 * that takes the PLAN revision FIRST, then the ACTIVE baseline's header (null = the route's 404: the baseline is the addressed
 * resource), the roadmap's rows ([loadRoadmapSnapshot] without its links: the live projects with rank and derived span), the live
 * milestones ([baselineMilestoneFacts]), the baseline's frozen rows and the team names, and hands them to the pure
 * [BaselineComparison]. Reads `Baselines`, `BaselineProjects`, `BaselineMilestones`, the roadmap view's tables (less
 * `Dependencies`) and `Teams`, `Users`/`People` for `createdBy`, and writes nothing (`persistence.md`).
 */
class BaselineViewService(private val database: R2dbcDatabase) {
    suspend fun view(id: UInt): BaselineView? = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val header = activeBaseline(id) ?: return@suspendTransaction null
        val baseline = header.toResponse(creatorsOf(listOfNotNull(header.createdByUserId)))
        val snapshot = loadRoadmapSnapshot(CAPTURE_ACTOR, withLinks = false)
        val known = snapshot.projects.mapTo(HashSet()) { it.id }
        val live = baselineMilestoneFacts().filter { it.projectId in known }
        val frozenMilestones = frozenMilestones(id)
        val teams = teamNames(frozenMilestones.map { it.teamId } + live.map { it.teamId })
        BaselineComparison.assemble(
            revision = revision,
            baseline = baseline,
            frozenProjects = frozenProjects(id),
            liveProjects = snapshot.projects,
            liveSpans = snapshot.spans,
            frozenMilestones = frozenMilestones,
            liveMilestones = live,
            teamNames = teams,
            calendar = snapshot.calendar,
        )
    }
}
