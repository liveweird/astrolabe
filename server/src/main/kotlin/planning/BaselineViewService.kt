package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val BaselineViewServiceKey = AttributeKey<BaselineViewService>("BaselineViewService")

/**
 * The comparison document (`GET /views/baseline/{id}`): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the views' protocol)
 * that takes the PLAN revision FIRST, then the ACTIVE baseline's header (null = the route's 404: the baseline is the addressed
 * resource), then the "now" side. Without `against` (the live plan): the roadmap's rows ([loadRoadmapSnapshot] without its links:
 * the live projects with rank and derived span) and the live milestones ([baselineMilestoneFacts]). With `against=N` (1.7): the
 * ACTIVE baseline N's header (the typed `400` [UNKNOWN_BASELINE_PROBLEM] when unknown or deleted, a plain `400` when it is the path
 * id itself, both only after the path id's own 404) and its frozen rows, and NO live read at all but the calendar. Then the path
 * baseline's frozen rows, the team names (any team, active or not, over both sides) and the pure [BaselineComparison]. Reads
 * `Baselines`, `BaselineProjects`, `BaselineMilestones`, the roadmap view's tables (less `Dependencies`; live mode only) and `Teams`,
 * `Users`/`People` for `createdBy`, and writes nothing (`persistence.md`).
 */
class BaselineViewService(private val database: R2dbcDatabase) {
    suspend fun view(id: UInt, against: UInt?): BaselineView? = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val header = activeBaseline(id) ?: return@suspendTransaction null
        val otherHeader = against?.let {
            if (it == id) throw BadRequestException("A baseline cannot be compared with itself")
            requireActiveBaseline(it)
        }
        val creators = creatorsOf(listOfNotNull(header.createdByUserId, otherHeader?.createdByUserId))
        val frozenMilestones = frozenMilestones(id)
        val now = if (otherHeader != null) againstSide(otherHeader.id) else liveSide()
        BaselineComparison.assemble(
            revision = revision,
            baseline = header.toResponse(creators),
            against = otherHeader?.toResponse(creators),
            frozenProjects = frozenProjects(id),
            nowProjects = now.projects,
            frozenMilestones = frozenMilestones,
            nowMilestones = now.milestones,
            teamNames = teamNames(frozenMilestones.map { it.teamId } + now.milestones.map { it.teamId }),
            calendar = now.calendar,
        )
    }

    /** The "now" side of a comparison, whichever it is. */
    private class NowSide(val projects: List<CompareProject>, val milestones: List<MilestoneCapture>, val calendar: WorkingCalendar)

    private suspend fun liveSide(): NowSide {
        val snapshot = loadRoadmapSnapshot(CAPTURE_ACTOR, withLinks = false)
        val known = snapshot.projects.mapTo(HashSet()) { it.id }
        return NowSide(
            projects = snapshot.projects.map { it.toCompare(snapshot.spans) },
            milestones = baselineMilestoneFacts().filter { it.projectId in known },
            calendar = snapshot.calendar,
        )
    }

    private suspend fun againstSide(baselineId: UInt) = NowSide(
        projects = frozenProjects(baselineId).map { it.toCompare() },
        milestones = frozenMilestones(baselineId).map { it.toCapture() },
        calendar = loadWorkingCalendar(),
    )
}
