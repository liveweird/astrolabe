package ch.nokillswit

import ch.nokillswit.auth.LoginResponse
import ch.nokillswit.flow.CapacityDeviationServiceKey
import ch.nokillswit.flow.FlowFlagSource
import ch.nokillswit.jira.DeviationViewServiceKey
import ch.nokillswit.jira.JiraFlagSource
import ch.nokillswit.planning.CompositeExternalFlagSource
import ch.nokillswit.planning.HomeCaller
import ch.nokillswit.planning.HomeView
import ch.nokillswit.planning.HomeViewService
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsBytes
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The size gate and the cost figures of `GET /views/home` (1.18.0) at the sample plan's density ([CrossTeamSampleFixture]: 5 work
 * streams, 20 programs, 100 projects, 1,000 milestones of which a tenth unscheduled, 15 teams with capacity and WIP limits, about 300
 * links, ONE owner). Four callers read the same plan:
 *
 * - the WORST case, one person who owns the whole plan (5 + 20 + 100 rows) and manages all 15 teams: the document is at most
 *   [MAX_BYTES] bytes uncompressed (calculated about 25 KB, plan 1.6) and its median stays under the tripwire [P50_TRIPWIRE_MS];
 * - a manager of one team, a person who owns and manages nothing and a login without a person (the plan block alone): every team's
 *   weekly load runs for EVERY caller, so the person-less login pays the load loop too and carries the same tripwire.
 *
 * Each caller is read once through the conformance-checked client (the shape), then once more as a warm-up and [RUNS] timed times
 * through a bare bearer client, as `JiraFlagsScaleTest` times its views. The statements of each caller's read are counted (a
 * service built on a database whose connection factory records every statement, [countingDatabase], over the app's own flag sources;
 * the count is pinned: the plan block's 13, one more for a person, one more per managed team while no Flow connection exists).
 * The roadmap view is timed on the same plan for comparison (what Home adds to the loader it runs). The sizes (plain and
 * gzip), the medians and the statement counts are `scale-figure` lines ([ScaleFigures]), recorded in `timeline.md` "Measured figures
 * (1.18)". The asserted time bounds are loose tripwires (at least 5x the figure measured on the dev machine), never the machine's
 * speed. No Jira or Flow stub: the plan has no binding and no connection, so the seam's Jira half answers nothing; the bound-plan
 * figure comes from `JiraFlagsScaleTest`'s own `scale-figure` lines on CI. Every row is hard-deleted in a `finally`.
 */
class HomeViewSizeTest {
    private class Caller(val userId: UInt, val conformant: HttpClient, val bare: HttpClient)

    private class Reading(val document: HomeView, val bytes: Int, val gzip: Int, val p50: Double, val max: Double)

    /** A seeded login with a bare bearer client beside the conformance-checked one. */
    private suspend fun ApplicationTestBuilder.caller(prefix: String): Caller {
        val email = uniqueEmail(prefix)
        val userId = TestUsers.seed(email = email, password = "pw")
        val token = jsonClient().login(email, "pw").body<LoginResponse>().token
        return Caller(
            userId,
            authedClient(email, "pw"),
            createClient { install(DefaultRequest) { header(HttpHeaders.Authorization, "Bearer $token") } },
        )
    }

    /** The shape through the conformance client, then the size, the gzip size and [RUNS] warm timed reads through the bare one. */
    private suspend fun Caller.read(label: String): Reading {
        val shape = conformant.get(PATH)
        assertEquals(HttpStatusCode.OK, shape.status, label)
        val document = shape.body<HomeView>()
        val first = bare.get(PATH)
        assertEquals(HttpStatusCode.OK, first.status, label)
        val bytes = first.bodyAsBytes().size
        val gzip = bare.get(PATH) { header(HttpHeaders.AcceptEncoding, "gzip") }.bodyAsBytes().size
        val timings = List(RUNS) {
            val started = System.nanoTime()
            assertEquals(HttpStatusCode.OK, bare.get(PATH).status)
            (System.nanoTime() - started) / NANOS_PER_MILLI
        }
        ScaleFigures.printBytes("home $label size", bytes)
        ScaleFigures.printBytes("home $label gzip", gzip)
        ScaleFigures.printSeries("home $label", timings)
        return Reading(document, bytes, gzip, ScaleFigures.median(timings), timings.max())
    }

    /**
     * The statements one read of a Home service sends for [userId], counted below Exposed on a database of its own (the service opens
     * its own transaction, which an interceptor of another transaction cannot see); the source is the app's own composite.
     */
    private suspend fun ApplicationTestBuilder.statements(label: String, userId: UInt): List<String> {
        val (database, factory) = countingDatabase()
        val jira = JiraFlagSource(application.attributes[DeviationViewServiceKey])
        val flow = FlowFlagSource(application.attributes[CapacityDeviationServiceKey])
        val service = HomeViewService(database, CompositeExternalFlagSource(listOf(jira, flow)))
        service.view(HomeCaller(userId))
        // Every statement is a SELECT; the first read on a fresh database also asks its name (the dialect probe), which is not the view's.
        val sql = factory.sql.filter { !it.startsWith("SELECT current_database()") }
        println("scale-figure\thome $label statements\t${sql.size}")
        return sql
    }

    @Test
    fun `the home view at the sample's density stays under 40000 bytes and inside its tripwires`() = testApplication {
        usePostgresTestcontainer()
        val prefix = planName("homesize")
        val users = mutableListOf<UInt>()
        try {
            val sample = CrossTeamSampleFixture.seed(prefix)
            assertEquals(15, sample.teamIds.size)
            assertEquals(1000, sample.milestones)

            // The worst case: the fixture's owner, linked to a login and the manager of every team.
            val worst = caller("homesize-w").also { users += it.userId }
            val manager = caller("homesize-m").also { users += it.userId }
            val nothing = caller("homesize-n").also { users += it.userId }
            val personless = caller("homesize-p").also { users += it.userId }
            val ownerName = "$prefix-owner"
            sql("UPDATE people SET user_id = ? WHERE name = ?", worst.userId.toInt(), ownerName)
            sql("UPDATE teams SET manager_person_id = (SELECT id FROM people WHERE name = ?) WHERE name LIKE ?", ownerName, "$prefix-t%")
            TestPeople.seed("$prefix-nobody", nothing.userId)
            val managerPerson = TestPeople.seed("$prefix-manager", manager.userId)

            val w = worst.read("worst case (one person, 5 + 20 + 100 + 15 rows)")
            val worstSql = statements("worst case", worst.userId)
            // The typical manager: one team, taken from the owner after the worst case was read.
            sql("UPDATE teams SET manager_person_id = ? WHERE name = ?", managerPerson.toInt(), "$prefix-t1")
            val m = manager.read("one manager of one team")
            val n = nothing.read("a person with nothing")
            val p = personless.read("a login without a person")
            personless.bare.get(ROADMAP_PATH)
            val roadmap = List(RUNS) {
                val started = System.nanoTime()
                assertEquals(HttpStatusCode.OK, personless.bare.get(ROADMAP_PATH).status)
                (System.nanoTime() - started) / NANOS_PER_MILLI
            }
            ScaleFigures.printSeries("home comparison: the roadmap view on the same plan", roadmap)

            val me = assertNotNull(w.document.me, "the worst-case caller has a person")
            assertEquals(5, me.workStreams.size)
            assertEquals(20, me.programs.size)
            assertEquals(100, me.projects.size)
            assertEquals(15, me.teams.size)
            assertFalse(me.truncated, "nothing is cut at the sample's density")
            assertEquals(1, assertNotNull(m.document.me).teams.size)
            assertEquals(0, assertNotNull(n.document.me).let { it.workStreams.size + it.programs.size + it.projects.size + it.teams.size })
            assertNull(p.document.me, "a login without a person has no 'me'")

            val managerSql = statements("one manager of one team", manager.userId)
            val nothingSql = statements("a person with nothing", nothing.userId)
            val personlessSql = statements("a login without a person", personless.userId)
            println("scale-figure\thome statements, the person-less login\n${personlessSql.joinToString("\n")}")
            // The plan block is the same statements whoever asks (the roadmap's loader, the streams, the programs, the scheduled
            // milestones, all the capacity periods) plus the caller's person; a person adds the managed teams' select, and each managed
            // team the seam's team half (one read here: no Flow connection; at most six with one).
            assertEquals(PLAN_STATEMENTS, personlessSql.size, "the plan block's statements:\n${personlessSql.joinToString("\n")}")
            assertEquals(personlessSql.size + 1, nothingSql.size, "a person with nothing adds the managed teams' select")
            val perTeam = managerSql.size - nothingSql.size
            assertTrue(perTeam in 1..SEAM_STATEMENTS_PER_TEAM, "a managed team adds $perTeam statements")
            assertEquals(nothingSql.size + 15 * perTeam, worstSql.size, "the statements grow by $perTeam a managed team, nothing else")

            // The gated figures on their own lines first, so a CI log carries them even when a gate fails.
            ScaleFigures.printBytes("home worst case (gated) size", w.bytes)
            ScaleFigures.printBytes("home worst case (gated) gzip", w.gzip)
            assertTrue(w.bytes <= MAX_BYTES, "the worst-case document is ${w.bytes} bytes, over the $MAX_BYTES gate")
            for ((label, reading) in listOf("worst case" to w, "manager" to m, "nothing" to n, "personless" to p)) {
                assertTrue(reading.p50 <= P50_TRIPWIRE_MS, "$label p50 ${reading.p50} ms")
            }
        } finally {
            // NonCancellable: a test cancelled by the 60 s limit must still take its rows out of the shared plan.
            withContext(NonCancellable) {
                sql("UPDATE people SET user_id = NULL WHERE name LIKE ?", "$prefix-%")
                CrossTeamSampleFixture.remove(prefix)
                sql("DELETE FROM people WHERE name LIKE ?", "$prefix-%")
                users.forEach { TestUsers.softDelete(it) }
            }
        }
        assertEquals(0, CrossTeamSampleFixture.remaining(prefix), "the synthetic plan is hard-deleted")
    }

    /** One parameterised statement over raw JDBC (strings and ints only). */
    private fun sql(statement: String, vararg params: Any) {
        PostgresTestSupport.connect().use { c ->
            c.prepareStatement(statement).use { st ->
                params.forEachIndexed { i, value -> st.setObject(i + 1, value) }
                st.executeUpdate()
            }
        }
    }

    private companion object {
        const val PATH = "/api/v1/views/home"
        const val ROADMAP_PATH = "/api/v1/views/roadmap"
        const val RUNS = 5

        /** The plan's gate (calculated about 25 KB, plan 1.6). */
        const val MAX_BYTES = 40_000

        /**
         * A loose tripwire for every caller's median, the person-less login included (every team's load runs for every caller):
         * about eight times the worst case measured on the dev machine (`timeline.md` "Measured figures (1.18)"). The plan's STOP LINE
         * is 250 ms on the dev machine: a median past it is reported before anything is tuned, so it is not asserted on a CI runner.
         */
        const val P50_TRIPWIRE_MS = 500.0

        /** The plan block's SELECTs: the revision, the roadmap loader's 7, streams, programs, scheduled milestones, periods, the person. */
        const val PLAN_STATEMENTS = 13

        /** The seam's team half per managed team: Flow's at most six reads (one while no connection exists, as here). */
        const val SEAM_STATEMENTS_PER_TEAM = 6
        const val NANOS_PER_MILLI = 1_000_000.0
    }
}
