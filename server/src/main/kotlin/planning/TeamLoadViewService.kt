package ch.nokillswit.planning

import io.ktor.util.AttributeKey
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val TeamLoadViewServiceKey = AttributeKey<TeamLoadViewService>("TeamLoadViewService")

/**
 * The team-load document (`GET /views/team-load`, 1.19.0): ONE read-only REPEATABLE READ transaction ([SNAPSHOT], the views' protocol)
 * that takes the PLAN's revision FIRST and the rows after, takes no lock and writes nothing. SIX statements: the revision, the working
 * calendar ([loadWorkingCalendar], the holiday dictionary), the ACTIVE teams left-joined to their manager's person
 * ([activeTeamsWithManagers]), the milestone counts ([teamMilestoneCounts]) and the weeks - the home view's own loader
 * ([teamWeeks]: the scheduled milestones, then those teams' ACTIVE capacity periods). No external source, no caller: the document is
 * the same for every login. Reads `Teams`, `People`, `Milestones`, `CapacityPeriods`, `PublicHolidays` and `PlanState`
 * (`persistence.md` matrix); nothing is written. [maxRows] caps the rows ([MAX_TEAM_LOAD_ROWS]) and [maxWarningWeeks] the weeks
 * the rows list in all ([MAX_TEAM_LOAD_WARNING_WEEKS]); the weeks are the loader's own, so they add no statement.
 */
class TeamLoadViewService(
    private val database: R2dbcDatabase,
    private val maxRows: Int = MAX_TEAM_LOAD_ROWS,
    private val maxWarningWeeks: Int = MAX_TEAM_LOAD_WARNING_WEEKS,
) {
    suspend fun view(): TeamLoadView = suspendTransaction(database, SNAPSHOT, readOnly = true) {
        val revision = readPlanRevision()
        val calendar = loadWorkingCalendar()
        val teams = activeTeamsWithManagers()
        val counts = teamMilestoneCounts()
        TeamLoadKernels.view(revision, teams, counts, teamWeeks(calendar), maxRows, maxWarningWeeks)
    }
}
