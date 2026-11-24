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
 * `Users`/`People` for `createdBy`, the V33 frozen links and capacity (and live `Dependencies` and `CapacityPeriods` in live mode, only
 * when the baseline captured them), and writes nothing (`persistence.md`).
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
        val frozenProjects = frozenProjects(id)
        val now = if (otherHeader != null) againstSide(otherHeader) else liveSide(header)
        val thenLinks = if (header.dependencyCount != null) frozenLinks(id) else null
        val thenCapacity = if (header.capacityPeriodCount != null) frozenCapacity(id) else null
        val capacityTeams = thenCapacity.orEmpty().map { it.teamId } + now.capacity.orEmpty().map { it.teamId }
        val names = teamNames(frozenMilestones.map { it.teamId } + now.milestones.map { it.teamId } + capacityTeams)
        BaselineComparison.assemble(
            revision = revision,
            baseline = header.toResponse(creators),
            against = otherHeader?.toResponse(creators),
            frozenProjects = frozenProjects,
            nowProjects = now.projects,
            frozenMilestones = frozenMilestones,
            nowMilestones = now.milestones,
            teamNames = names,
            calendar = now.calendar,
            links = BaselineCaptureComparison.links(
                thenLinks, now.links, LinkEndNames(now.projects, frozenProjects, now.milestones, frozenMilestones),
            ),
            capacity = BaselineCaptureComparison.capacity(thenCapacity, now.capacity, names),
        )
    }

    /** The "now" side of a comparison, whichever it is. */
    private class NowSide(
        val projects: List<CompareProject>,
        val milestones: List<MilestoneCapture>,
        val calendar: WorkingCalendar,
        /** Null = this side holds no links / capacity to compare (a baseline that did not capture them); the live side always does. */
        val links: List<PlanLinkFact>?,
        val capacity: List<CapacityCapture>?,
    )

    private suspend fun liveSide(then: BaselineHeader): NowSide {
        val snapshot = loadRoadmapSnapshot(CAPTURE_ACTOR, withLinks = false)
        val known = snapshot.projects.mapTo(HashSet()) { it.id }
        return NowSide(
            projects = snapshot.projects.map { it.toCompare(snapshot.spans) },
            milestones = baselineMilestoneFacts().filter { it.projectId in known },
            calendar = snapshot.calendar,
            // Only what the baseline captured is read (a pre-1.26 one compares nothing of either), the live ACTIVE links and periods.
            links = if (then.dependencyCount != null) linkFacts() else null,
            capacity = if (then.capacityPeriodCount != null) liveCapacityCaptures() else null,
        )
    }

    private suspend fun againstSide(other: BaselineHeader) = NowSide(
        projects = frozenProjects(other.id).map { it.toCompare() },
        milestones = frozenMilestones(other.id).map { it.toCapture() },
        calendar = loadWorkingCalendar(),
        links = if (other.dependencyCount != null) frozenLinks(other.id) else null,
        capacity = if (other.capacityPeriodCount != null) frozenCapacity(other.id) else null,
    )
}
