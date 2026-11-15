package ch.nokillswit.planning

import io.ktor.util.AttributeKey
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val DependencyListViewServiceKey = AttributeKey<DependencyListViewService>("DependencyListViewService")

/**
 * The dependency list document (`GET /views/dependencies`, 1.20.0): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the views'
 * protocol) that takes the PLAN's revision FIRST and the rows after, takes no lock and writes nothing. FIVE statements: the revision,
 * the working calendar ([loadWorkingCalendar], the holiday dictionary), the ACTIVE milestones with their team's name
 * ([milestoneFacts]), the ACTIVE links ([linkFacts]) and the ACTIVE projects' names with their owner chains
 * ([activeProjectNamesAndChains], 1.22.0; the names half is [activeProjectNames]'s row set) - the roadmap view's own
 * loaders, then [RoadmapKernels.projectSpans] and [RoadmapKernels.checkedLinks] run once. The project set is "every active project":
 * it equals the roadmap's (an active project under an active program and work stream) because a program with active projects, and a
 * work stream with active programs, cannot be deleted (`planning-model.md`); the kernel reads the projects' ids only, so they are
 * handed over as [PlanProjectFact]s without rank or target. No external source. The ONE caller-shaped member is each row's `can`
 * ([actor], resolved by the route as the plan view's is, outside this transaction): the successor project's chain never leaves the
 * kernel, and nothing else differs between logins. Reads `Milestones`, `Teams`, `Dependencies`, `Projects`, `Programs`, `WorkStreams`
 * (their owner ids), `PublicHolidays` and `PlanState` (`persistence.md` matrix); nothing is written. [maxRows] caps the rows
 * ([MAX_DEPENDENCY_ROWS]).
 */
class DependencyListViewService(
    private val database: R2dbcDatabase,
    private val maxRows: Int = MAX_DEPENDENCY_ROWS,
) {
    suspend fun view(actor: PlanActor): DependencyListView = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val calendar = loadWorkingCalendar()
        val milestones = milestoneFacts()
        val links = linkFacts()
        val projectChains = activeProjectNamesAndChains()
        val facts = milestones.map { it.fact }
        val spans = RoadmapKernels.projectSpans(facts)
        val projects = projectChains.keys.map { PlanProjectFact(it, null, null) }
        val checked = RoadmapKernels.checkedLinks(links, projects, facts, spans, calendar)
        DependencyListKernels.view(revision, checked, milestones, projectChains, actor, maxRows)
    }
}
