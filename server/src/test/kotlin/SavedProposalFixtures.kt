package ch.nokillswit

import ch.nokillswit.planning.CrossTeamProposal
import ch.nokillswit.planning.CrossTeamProposalRequest
import ch.nokillswit.planning.SavedProposalSaveRequest
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import kotlin.test.assertEquals

const val SAVED_PATH = "/api/v1/saved-schedule-proposals"

/** A Sunday: the first candidate day of every run in the saved-proposal tests is Monday 2027-02-01 (10 MD a week is 2 MD a day). */
const val SAVED_AS_OF = "2027-01-31"

/**
 * The saved-proposal world: a run over TWO teams ([t1], [t2]) that one login ([both]) manages and only ADMIN and [both] may run or
 * save; a third team ([t3]) managed by [m3], outside the run. [a1] (team 1, 4 MD, stored late) precedes [b1] (team 2, unscheduled) by
 * a finish-to-start link, and [b2] (team 2) is movable, so the run has three moves; [c1] belongs to the outside team.
 */
class SavedWorld(
    val w: PlanWorld,
    val both: PlanCaller,
    val m3: PlanCaller,
    val t1: UInt,
    val t2: UInt,
    val t3: UInt,
    val a1: UInt,
    val b1: UInt,
    val b2: UInt,
    val c1: UInt,
) {
    val pair = listOf(t1, t2)
}

suspend fun ApplicationTestBuilder.savedWorld(prefix: String): SavedWorld {
    usePostgresTestcontainer()
    val w = planWorld(prefix)
    val both = planCaller("$prefix-both")
    val m3 = planCaller("$prefix-m3")
    val t1 = TestTeams.seed(planName("$prefix-t1"), both.personId)
    val t2 = TestTeams.seed(planName("$prefix-t2"), both.personId)
    val t3 = TestTeams.seed(planName("$prefix-t3"), m3.personId)
    for (team in listOf(t1, t2, t3)) TestPlan.capacityPeriod(team, "2027-01-04", 10.0)
    val a1 = TestPlan.milestone(w.projectId, t1, planName("a1"), 4.0)
    TestPlan.schedule(a1, "2027-03-01", "2027-03-02")
    val b1 = TestPlan.milestone(w.projectId, t2, planName("b1"), 2.0)
    val b2 = TestPlan.milestone(w.projectId, t2, planName("b2"), 2.0)
    TestPlan.schedule(b2, "2027-04-05", "2027-04-06")
    val c1 = TestPlan.milestone(w.projectId, t3, planName("c1"), 2.0)
    TestPlan.schedule(c1, "2027-02-01", "2027-02-05")
    TestPlan.dependency(milestoneRef(a1), milestoneRef(b1))
    return SavedWorld(w, both, m3, t1, t2, t3, a1, b1, b2, c1)
}

/** The run over [teamIds] as the client would have fetched it. */
suspend fun HttpClient.savedRun(teamIds: List<UInt>): CrossTeamProposal {
    val response = postJson("/api/v1/schedule-proposals", CrossTeamProposalRequest(SAVED_AS_OF, teamIds))
    assertEquals(HttpStatusCode.OK, response.status)
    return response.body()
}

/** Every move of the run, in placement order. */
fun CrossTeamProposal.moveIds(): List<UInt> = teams.flatMap { it.moves }.map { it.milestoneId }

/** Saves [run] (taken over [teamIds]) with [selected] ticked; every other part of the body can be overridden to probe a refusal. */
suspend fun HttpClient.saveProposal(
    run: CrossTeamProposal,
    teamIds: List<UInt>,
    selected: List<UInt> = run.moveIds(),
    name: String = "Saved ${selected.size}",
    revision: Long = run.revision,
    hash: String = run.scopeHash,
    asOf: String = SAVED_AS_OF,
): HttpResponse = postJson(SAVED_PATH, SavedProposalSaveRequest(name, asOf, teamIds, revision, hash, selected))

/**
 * Saves are 10 a minute per login (the `schedule-proposal-save` bucket, spent by EVERY request that reaches the route, refused ones
 * included), so a test that sends more spreads them over fresh logins: [next] answers a new login of [role] after every [PER_LOGIN]
 * requests. ADMIN passes every guard; a USER (with a person) passes none of a run's.
 */
class CallerPool(private val builder: ApplicationTestBuilder, private val prefix: String, private val role: UserRole) {
    private var current: PlanCaller? = null
    private var used = 0

    suspend fun next(): PlanCaller {
        val caller = current?.takeIf { used < PER_LOGIN } ?: with(builder) { planCaller(prefix, role) }.also {
            current = it
            used = 0
        }
        used++
        return caller
    }

    private companion object {
        const val PER_LOGIN = 8
    }
}

fun ApplicationTestBuilder.callerPool(prefix: String, role: UserRole = UserRole.ADMIN) = CallerPool(this, prefix, role)

/** The saved-proposal table over raw JDBC (a hard-delete table nobody else touches). */
object TestSavedProposals {
    fun clear() {
        PostgresTestSupport.connect().use { c -> c.createStatement().use { it.executeUpdate("DELETE FROM saved_schedule_proposals") } }
    }

    fun count(): Int = TestPlan.scalar("SELECT count(*) FROM saved_schedule_proposals") { it.getInt(1) }

    fun exists(id: UInt): Boolean = TestPlan.scalar("SELECT count(*) FROM saved_schedule_proposals WHERE id = $id") { it.getInt(1) } == 1

    /** A scalar over the saved row [id] (`select` is a column list, e.g. `format`). */
    fun <T> scalar(id: UInt, select: String, read: (java.sql.ResultSet) -> T): T =
        TestPlan.scalar("SELECT $select FROM saved_schedule_proposals WHERE id = $id", read)

    fun execute(sql: String) {
        PostgresTestSupport.connect().use { c -> c.createStatement().use { it.executeUpdate(sql) } }
    }
}
