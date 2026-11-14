package ch.nokillswit

import ch.nokillswit.auth.LoginResponse
import ch.nokillswit.flow.CapacityDeviationServiceKey
import ch.nokillswit.flow.FlowFlagSource
import ch.nokillswit.jira.DeviationViewServiceKey
import ch.nokillswit.jira.JiraFlagSource
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.planning.CompositeExternalFlagSource
import ch.nokillswit.planning.HomeCaller
import ch.nokillswit.planning.HomeView
import ch.nokillswit.planning.ExternalFlagSource
import ch.nokillswit.planning.HomeViewService
import ch.nokillswit.planning.PlanActor
import ch.nokillswit.planning.RoadmapViewService
import ch.nokillswit.planning.TeamLoadView
import ch.nokillswit.planning.TeamLoadViewService
import ch.nokillswit.users.UserRole
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
import kotlinx.serialization.json.Json
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
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
 * the count is pinned RELATIVE to the roadmap service's on the same database, because the Jira fold's statements depend on what
 * earlier classes left in the shared database (CI: 43 against 13 alone): Home = the roadmap's + 5, one more for a person, and per
 * managed team the seam's bounded team half; ten projects and ten milestones are bound to a live connection in the test itself, so
 * the leak is reproduced in every run).
 * The roadmap view is timed on the same plan for comparison (what Home adds to the loader it runs). The sizes (plain and
 * gzip), the medians and the statement counts are `scale-figure` lines ([ScaleFigures]), recorded in `timeline.md` "Measured figures
 * (1.18)". The asserted time bounds are loose tripwires (at least 5x the figure measured on the dev machine), never the machine's
 * speed. The team-load document (`GET /views/team-load`, 1.19.0) is read once more on the same plan (bytes, median, statements, pinned
 * at [TEAM_LOAD_STATEMENTS]: it runs no external source, so its count does not depend on what other classes left behind). No Jira or
 * Flow stub: the plan has no binding and no connection, so the seam's Jira half answers nothing; the bound-plan
 * figure comes from `JiraFlagsScaleTest`'s own `scale-figure` lines on CI. Every row is hard-deleted in a `finally`.
 */
class HomeViewSizeTest {
    private class Caller(val userId: UInt, val conformant: HttpClient, val bare: HttpClient)

    private class LoadReading(val document: TeamLoadView, val bytes: Int, val p50: Double)

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
     * The shape through the conformance client, then [RUNS] warm timed reads of the team-load view; its plain and gzip sizes are
     * only printed ([LoadReading] keeps the plain size), because the endpoint's document holds every team of the shared database
     * (cut at 200), not the sample's 15: the GATED size is [sampleTeamLoadBytes].
     */
    private suspend fun Caller.readTeamLoad(): LoadReading {
        val shape = conformant.get(TEAM_LOAD_PATH)
        assertEquals(HttpStatusCode.OK, shape.status)
        val document = shape.body<TeamLoadView>()
        val bytes = bare.get(TEAM_LOAD_PATH).bodyAsBytes().size
        val gzip = bare.get(TEAM_LOAD_PATH) { header(HttpHeaders.AcceptEncoding, "gzip") }.bodyAsBytes().size
        val timings = List(RUNS) {
            val started = System.nanoTime()
            assertEquals(HttpStatusCode.OK, bare.get(TEAM_LOAD_PATH).status)
            (System.nanoTime() - started) / NANOS_PER_MILLI
        }
        ScaleFigures.printBytes("team load size", bytes)
        ScaleFigures.printBytes("team load gzip", gzip)
        ScaleFigures.printSeries("team load", timings)
        return LoadReading(document, bytes, ScaleFigures.median(timings))
    }

    /** The statements [read] sends on a counting database of its own (every statement is a SELECT; the dialect probe is not the view's). */
    private suspend fun ApplicationTestBuilder.statements(
        label: String,
        read: suspend (R2dbcDatabase, ExternalFlagSource) -> Unit,
    ): List<String> {
        val (database, factory) = countingDatabase()
        val jira = JiraFlagSource(application.attributes[DeviationViewServiceKey])
        val flow = FlowFlagSource(application.attributes[CapacityDeviationServiceKey])
        read(database, CompositeExternalFlagSource(listOf(jira, flow)))
        val sql = factory.sql.filter { !it.startsWith("SELECT current_database()") }
        println("scale-figure\t$label statements\t${sql.size}")
        return sql
    }

    /**
     * One read of a Home service for [userId], counted below Exposed (the service opens its own transaction, which an interceptor of
     * another transaction cannot see) over the app's own flag sources.
     */
    private suspend fun ApplicationTestBuilder.homeStatements(label: String, userId: UInt) =
        statements("home $label") { database, source -> HomeViewService(database, source).view(HomeCaller(userId)) }

    /**
     * One read of the roadmap service for the actor that may do nothing, counted the same way: the part of Home's cost that is the
     * roadmap loader PLUS the Jira and Flow sources, which depends on what earlier classes left in the shared database (live
     * connections and bindings add statements to the Jira fold), so Home is pinned RELATIVE to it, never to an absolute number.
     */
    private suspend fun ApplicationTestBuilder.roadmapStatements(label: String) =
        statements("home reference: the roadmap $label") { database, source -> RoadmapViewService(database, source).view(NEUTRAL_ACTOR) }

    @Test
    fun `the home view at the sample's density stays under 40000 bytes and inside its tripwires`() = testApplication {
        usePostgresTestcontainer()
        val prefix = planName("homesize")
        val users = mutableListOf<UInt>()
        var connection: UInt? = null
        try {
            val sample = CrossTeamSampleFixture.seed(prefix)
            assertEquals(15, sample.teamIds.size)
            assertEquals(1000, sample.milestones)

            // The Jira fold's cost is whatever the shared database holds; bind a few nodes to a live connection HERE so the leak that
            // other classes cause (the statement count of the source moves) is reproduced deterministically, and prove it moved.
            val admin = planCaller("homesize-a", UserRole.ADMIN, withPerson = false).also { users += it.userId }
            val unbound = roadmapStatements("before binding").size
            connection = admin.client.dvConnection()
            bind(connection, JiraLevel.PROJECT, "SELECT id FROM projects WHERE name LIKE ? ORDER BY id LIMIT $BOUND", "$prefix-pj%")
            bind(connection, JiraLevel.MILESTONE, "SELECT id FROM milestones WHERE name LIKE ? ORDER BY id LIMIT $BOUND", "$prefix-m%")
            val reference = roadmapStatements("after binding")
            assertTrue(reference.size > unbound, "the bindings must have moved the source's statements ($unbound -> ${reference.size})")

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
            val worstSql = homeStatements("worst case", worst.userId)
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

            // The team-load view on the same plan: every team, whoever asks; six statements (revision, calendar, teams with managers,
            // milestone counts, scheduled milestones, capacity periods) and a small document.
            val load = personless.readTeamLoad()
            val loadSql = statements("team load") { database, _ -> TeamLoadViewService(database).view() }
            assertEquals(TEAM_LOAD_STATEMENTS, loadSql.size, "the team-load view's statements:\n${loadSql.joinToString("\n")}")
            assertTrue(load.p50 <= P50_TRIPWIRE_MS, "team load p50 ${load.p50} ms")
            // The gated size is a FIXED document: the uncapped view reduced to the sample's 15 teams (the endpoint's own document holds
            // every team of the shared database, cut at 200, so its size depends on what other classes left behind).
            val whole = TeamLoadViewService(sharedDatabaseForTests(), maxRows = Int.MAX_VALUE).view()
            assertFalse(whole.truncated)
            val sampleRows = whole.teams.filter { it.id in sample.teamIds }
            assertEquals(sample.teamIds.size, sampleRows.size, "the sample's 15 teams are rows")
            val sampleBytes = Json.encodeToString(TeamLoadView.serializer(), whole.copy(teams = sampleRows)).toByteArray().size
            ScaleFigures.printBytes("team load (sample's 15 teams, gated) size", sampleBytes)
            assertTrue(sampleBytes <= TEAM_LOAD_MAX_BYTES, "the team-load document is $sampleBytes bytes for 15 teams, over the gate")

            val managerSql = homeStatements("one manager of one team", manager.userId)
            val nothingSql = homeStatements("a person with nothing", nothing.userId)
            val personlessSql = homeStatements("a login without a person", personless.userId)
            println("scale-figure\thome statements, the person-less login\n${personlessSql.joinToString("\n")}")
            // Relative to the roadmap read on the same database (its loader and both sources): the plan block adds the streams, the
            // programs, the scheduled milestones, ALL the capacity periods and the caller's person lookup, whoever asks (a read per
            // team would break this); a person adds the managed teams' select, and each managed team the seam's team half (one read
            // here: no Flow connection of ours; at most six with one).
            val shown = personlessSql.joinToString("\n")
            assertEquals(reference.size + HOME_ONLY_STATEMENTS, personlessSql.size, "Home against the roadmap:\n$shown")
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
                connection?.let { id ->
                    val bindings = "SELECT id FROM jira_bindings WHERE connection_id = ?"
                    sql("DELETE FROM jira_observations WHERE binding_id IN ($bindings)", id.toInt())
                    sql("DELETE FROM jira_bindings WHERE connection_id = ?", id.toInt())
                    sql("UPDATE jira_connections SET marked_as_deleted = TRUE WHERE id = ?", id.toInt())
                }
                CrossTeamSampleFixture.remove(prefix)
                sql("DELETE FROM people WHERE name LIKE ?", "$prefix-%")
                users.forEach { TestUsers.softDelete(it) }
            }
        }
        assertEquals(0, CrossTeamSampleFixture.remaining(prefix), "the synthetic plan is hard-deleted")
    }

    /** Binds the [BOUND] nodes [query] finds (ids of the fixture's rows) to a fresh issue each on [connectionId]. */
    private fun bind(connectionId: UInt, level: JiraLevel, query: String, like: String) {
        val ids = PostgresTestSupport.connect().use { c ->
            c.prepareStatement(query).use { st ->
                st.setString(1, like)
                st.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getInt(1).toUInt()) } }
            }
        }
        assertEquals(BOUND, ids.size)
        ids.forEach { nextIssue().let { (issueId, key) -> dvBind(connectionId, level, it, issueId, key) } }
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
        const val TEAM_LOAD_PATH = "/api/v1/views/team-load"

        /** The team-load view's gate for the sample's 15 teams (calculated about 2.6 KB, measured about 2.9 KB): 1.5 times the figure. */
        const val TEAM_LOAD_MAX_BYTES = 4_500

        /** The team-load view's statements: revision, calendar, teams with managers, milestone counts, scheduled milestones, periods. */
        const val TEAM_LOAD_STATEMENTS = 6
        const val RUNS = 5

        /** The plan's gate (calculated about 25 KB, plan 1.6). */
        const val MAX_BYTES = 40_000

        /**
         * A loose tripwire for every caller's median, the person-less login included (every team's load runs for every caller):
         * about eight times the worst case measured on the dev machine (`timeline.md` "Measured figures (1.18)"). The plan's STOP LINE
         * is 250 ms on the dev machine: a median past it is reported before anything is tuned, so it is not asserted on a CI runner.
         */
        const val P50_TRIPWIRE_MS = 500.0

        /** The statements Home adds to the roadmap read: work streams, programs, scheduled milestones, capacity periods, the person. */
        const val HOME_ONLY_STATEMENTS = 5

        /** Projects and milestones bound to a live connection before anything is counted (see the test). */
        const val BOUND = 10

        /** The actor that may do nothing: what Home hands the roadmap loader. */
        val NEUTRAL_ACTOR = PlanActor(isAdmin = false, personId = null, roadmapEditor = false, managedTeamIds = emptySet())

        /** The seam's team half per managed team: Flow's at most six reads (one while no connection exists, as here). */
        const val SEAM_STATEMENTS_PER_TEAM = 6
        const val NANOS_PER_MILLI = 1_000_000.0
    }
}
