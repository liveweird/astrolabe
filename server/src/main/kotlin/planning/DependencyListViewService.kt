package ch.nokillswit.planning

import io.ktor.util.AttributeKey
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val DependencyListViewServiceKey = AttributeKey<DependencyListViewService>("DependencyListViewService")

/**
 * The dependency list document (`GET /views/dependencies`, 1.20.0): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the views'
 * protocol) that takes the PLAN's revision FIRST and the rows after, takes no lock and writes nothing. FIVE statements: the revision,
 * the working calendar ([loadWorkingCalendar], the holiday dictionary), the ACTIVE milestones with their team's name
 * ([milestoneFacts]), the ACTIVE links ([linkFacts]) and the ACTIVE projects' names ([activeProjectNames]) - the roadmap view's own
 * loaders, then [RoadmapKernels.projectSpans] and [RoadmapKernels.checkedLinks] run once. The project set is "every active project":
 * it equals the roadmap's (an active project under an active program and work stream) because a program with active projects, and a
 * work stream with active programs, cannot be deleted (`planning-model.md`); the kernel reads the projects' ids only, so they are
 * handed over as [PlanProjectFact]s without rank or target. No external source, no caller: the document is the same for every
 * login. Reads `Milestones`, `Teams`, `Dependencies`, `Projects`, `PublicHolidays` and `PlanState` (`persistence.md` matrix); nothing
 * is written. [maxRows] caps the rows ([MAX_DEPENDENCY_ROWS]).
 */
class DependencyListViewService(
    private val database: R2dbcDatabase,
    private val maxRows: Int = MAX_DEPENDENCY_ROWS,
) {
    suspend fun view(): DependencyListView = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val calendar = loadWorkingCalendar()
        val milestones = milestoneFacts()
        val links = linkFacts()
        val projectNames = activeProjectNames()
        val facts = milestones.map { it.fact }
        val spans = RoadmapKernels.projectSpans(facts)
        val projects = projectNames.keys.map { PlanProjectFact(it, null, null) }
        val checked = RoadmapKernels.checkedLinks(links, projects, facts, spans, calendar)
        DependencyListKernels.view(revision, checked, milestones, projectNames, maxRows)
    }
}
