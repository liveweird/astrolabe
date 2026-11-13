package ch.nokillswit

import ch.nokillswit.auth.LoginResponse
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.jira.DeviationViewServiceKey
import ch.nokillswit.jira.JiraFlagSource
import ch.nokillswit.planning.ExternalFlagRequest
import ch.nokillswit.planning.JiraRollup
import ch.nokillswit.planning.PlanActor
import ch.nokillswit.planning.RoadmapViewService
import ch.nokillswit.planning.TeamView
import ch.nokillswit.planning.TeamViewService
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * What the Jira links and flags cost the four timeline views at the sample plan's scale (1.3): 20 programs, 100 projects and 1,000
 * milestones, ALL bound, every milestone deviating three times (its dates shifted a week from Jira's, `START_DIFFERS` and `END_DIFFERS`,
 * and Jira has it in progress while the plan starts in 2045, `PROGRESS_MISMATCH`: three flags a row; the kernel's ceiling is seven),
 * 15 teams with the largest at 301 milestones like the sample plan's Platform. ONE world, built once through the import (a
 * scripted Jira site, [applyScaleImport]) with FIVE mirrored children under every bound epic (1.4: [seedScaleChildren], two done, 3
 * points each, so every milestone link carries a roll-up; they raise no `CHILDREN_DONE`); each view is then read plain and with
 * `?baseline=`, with the connection enabled and then DISABLED (a disabled connection's rows keep a dateless `jira` link but raise no
 * flag, so the second pass, plain only, is the same documents without the flags and the dates: the difference is what the flags and
 * dates cost, not the link itself); the roadmap service is also timed with and without the source, to isolate the Jira computation.
 * Sizes (plain and gzipped) and the median of five warm reads are `scale-figure` lines ([ScaleFigures]), recorded in `timeline.md`
 * "Measured figures (1.3)" (before the roll-up) and "(1.4)". The asserted bounds are the documented size gates and loose time
 * tripwires (at least 5x the dev-machine figure), never the machine's speed. The Jira source's statement count is pinned too
 * ([assertLoaderStatementsAreFlat]): the same number whatever the size, which the timing of 1,000 rows cannot show.
 */
class JiraFlagsScaleTest {
    private class Reading(val bytes: Int, val gzip: Int, val p50: Double, val max: Double)

    /** One view read [runs] times after a warm-up, plus its gzip size; the status must be 200. */
    private suspend fun HttpClient.read(label: String, path: String, runs: Int = RUNS): Reading {
        val first = get(path)
        assertEquals(HttpStatusCode.OK, first.status, path)
        val bytes = first.bodyAsBytes().size
        val gzip = get(path) { header(HttpHeaders.AcceptEncoding, "gzip") }.bodyAsBytes().size
        val timings = List(runs) {
            val started = System.nanoTime()
            assertEquals(HttpStatusCode.OK, get(path).status)
            (System.nanoTime() - started) / NANOS_PER_MILLI
        }
        ScaleFigures.printBytes("flags $label size", bytes)
        ScaleFigures.printBytes("flags $label gzip", gzip)
        ScaleFigures.printSeries("flags $label", timings)
        return Reading(bytes, gzip, ScaleFigures.median(timings), timings.max())
    }

    /** The roadmap and team views built WITHOUT a source against the ones the app wires, on the same rows: what the Jira fold adds. */
    private suspend fun ApplicationTestBuilder.printSourceCost(platform: UInt) {
        val actor = PlanActor(isAdmin = true, personId = null, roadmapEditor = false, managedTeamIds = emptySet())
        val db = sharedDatabaseForTests()
        val jira = JiraFlagSource(application.attributes[DeviationViewServiceKey])

        suspend fun p50(read: suspend () -> Any?): Double {
            read()
            return ScaleFigures.median(
                List(RUNS) {
                    val started = System.nanoTime()
                    read()
                    (System.nanoTime() - started) / NANOS_PER_MILLI
                },
            )
        }
        ScaleFigures.print("flags roadmap service without a source median", p50 { RoadmapViewService(db).view(actor) })
        ScaleFigures.print("flags roadmap service with the Jira source median", p50 { RoadmapViewService(db, jira).view(actor) })
        ScaleFigures.print("flags team service without a source median", p50 { TeamViewService(db).view(platform, actor) })
        ScaleFigures.print("flags team service with the Jira source median", p50 { TeamViewService(db, jira).view(platform, actor) })
    }

    /** The statements [JiraFlagSource.flagsInTransaction] sends for [projectIds]/[milestoneIds] (both null = the whole plan). */
    private suspend fun flagLoadStatements(jira: JiraFlagSource, projectIds: List<UInt>?, milestoneIds: List<UInt>?): List<String> {
        val counter = StatementCounter()
        val flags = suspendTransaction(sharedDatabaseForTests()) {
            registerInterceptor(counter)
            jira.flagsInTransaction(ExternalFlagRequest(projectIds, milestoneIds, WorkingCalendar.MON_FRI))
        }
        assertTrue(flags.milestones.isNotEmpty(), "the load must have found bindings to count anything")
        return counter.sql
    }

    /**
     * Pins the Jira source's statement count (the roll-up loader included) as INDEPENDENT of size: the whole plan (100 projects, 1,000
     * bound milestones, 5,000 mirrored children) and ONE project with its milestones must send the SAME number of statements, so a
     * query per binding, per milestone or per epic fails here although the 1,000-row world's timing hides it. The loader is called
     * directly in a transaction of its own, which isolates it: an unrelated extra query elsewhere in a view cannot move this count.
     * The exact figure is [LOADER_STATEMENTS]; a deliberate new loader raises it with its line in that constant's comment.
     */
    private suspend fun assertLoaderStatementsAreFlat(jira: JiraFlagSource, projectId: UInt) {
        val milestoneIds = jbScalar("SELECT array_agg(id) FROM milestones WHERE project_id = ?", projectId.toInt()) { rs ->
            (rs.getArray(1).array as Array<*>).map { (it as Int).toUInt() }
        }
        val whole = flagLoadStatements(jira, null, null)
        val one = flagLoadStatements(jira, listOf(projectId), milestoneIds)
        println("scale-figure flags loader statements, whole plan: ${whole.size}, one project: ${one.size}\n${whole.joinToString("\n")}")
        assertEquals(whole.size, one.size, "the statement count must not follow the number of bindings:\n${whole.joinToString("\n")}")
        assertEquals(LOADER_STATEMENTS, whole.size, "the loader's statements:\n${whole.joinToString("\n")}")
    }

    @Test
    fun `the four views with every node bound stay inside their documented size gates`() = testApplication {
        val f = importFixture("jfscale")
        val tag = planName("jfscale")
        val teams = List(TEAMS) { TestTeams.seed(planName("jfscale-team")) }
        val platform = teams.first()
        var baseline = 0u
        try {
            // The first 301 milestones are the largest team's (the sample plan's Platform); the rest spread over the other 14.
            val applied = applyScaleImport(f, tag, PROGRAMS, PROJECTS, MILESTONES) { n ->
                if (n <= PLATFORM_ROWS) platform else teams[1 + n % (TEAMS - 1)]
            }
            assertEquals(PROGRAMS + PROJECTS + MILESTONES, applied.created.result.created.size)
            // 1.4: five mirrored children under each bound epic (2 done, 15 points), the roll-up every milestone link now carries.
            seedScaleChildren(f.connectionId, MILESTONES)
            // The baseline freezes the imported plan, so the shift below is movement on every row (the overlay's worst case, as v0.9's).
            baseline = TestPlan.baseline(planName("jfscale"))
            // Every milestone deviates from Jira's dates by a week (a week shift keeps the start and the end on working days).
            jbSql("UPDATE milestones SET start_date = start_date + 7, end_date = end_date + 7 WHERE name LIKE ?", "$tag %")
            val milestoneRow = jbScalar("SELECT project_id FROM milestones WHERE name = ?", "$tag Milestone 1") { it.getInt(1) }.toUInt()

            val email = uniqueEmail("jfscale")
            TestUsers.seed(email = email, password = "pw")
            val token = jsonClient().login(email, "pw").body<LoginResponse>().token
            val client = createClient { install(DefaultRequest) { header(HttpHeaders.Authorization, "Bearer $token") } }

            val views = mapOf(
                "roadmap" to "/api/v1/views/roadmap",
                "programs" to "/api/v1/views/programs",
                "team" to "/api/v1/views/team/$platform",
                "project" to "/api/v1/views/project/$milestoneRow",
            )
            val bound = HashMap<String, Reading>()
            val unbound = HashMap<String, Reading>()
            for ((name, path) in views) {
                bound["$name plain"] = client.read("$name bound", path)
                bound["$name baseline"] = client.read("$name bound baseline", "$path?baseline=$baseline")
            }

            // The platform team's rows, all bound, three flags each.
            val team = jbJson.decodeFromString<TeamView>(client.get(views.getValue("team")).bodyAsText())
            val rows = team.scheduled + team.unscheduled
            assertEquals(PLATFORM_ROWS, rows.size)
            val shapes = rows.groupingBy { "${it.jira != null}/${it.flags.size}" }.eachCount()
            assertEquals(mapOf("true/$FLAGS_PER_MILESTONE" to PLATFORM_ROWS), shapes, "every milestone is bound and deviates three times")
            assertEquals(listOf(f.connectionId), team.jiraSites.map { it.connectionId })
            val rollup = JiraRollup(SCALE_CHILDREN, SCALE_CHILDREN_DONE, SCALE_CHILDREN * POINTS_PER_CHILD, SCALE_CHILD_OBSERVED_AT)
            val rolled = rows.groupingBy { it.jira?.rollup }.eachCount()
            assertEquals(mapOf<JiraRollup?, Int>(rollup to PLATFORM_ROWS), rolled, "every link rolls up")

            assertLoaderStatementsAreFlat(JiraFlagSource(application.attributes[DeviationViewServiceKey]), milestoneRow)

            jbSql("UPDATE jira_connections SET enabled = FALSE WHERE id = ?", f.connectionId.toInt())
            for ((name, path) in views) unbound[name] = client.read("$name disabled", path, DISABLED_RUNS)
            for ((name, reading) in unbound) {
                // The overlay adds the same bytes with and without the Jira blocks, so one delta per view serves both reads.
                ScaleFigures.printBytes("flags $name jira blocks", bound.getValue("$name plain").bytes - reading.bytes)
            }
            printSourceCost(platform)

            val teamBaseline = bound.getValue("team baseline")
            assertTrue(teamBaseline.bytes <= TEAM_VIEW_GATE_BYTES, "team view with the overlay: ${teamBaseline.bytes} B")
            assertTrue(teamBaseline.gzip <= TEAM_VIEW_GZIP_GATE_BYTES, "team view with the overlay, gzip: ${teamBaseline.gzip} B")
            assertTrue(bound.getValue("project baseline").bytes <= PROJECT_VIEW_GATE_BYTES, "project view with the overlay")
            for ((key, reading) in bound) assertTrue(reading.p50 <= P50_TRIPWIRE_MS, "$key p50 ${reading.p50} ms")
        } finally {
            // NonCancellable: a test cancelled by the 60 s limit must still take its thousands of rows out of the shared plan.
            withContext(NonCancellable) {
                removeScaleRows(f.connectionId, tag)
                if (baseline != 0u) TestPlan.deleteBaseline(baseline)
            }
        }
    }

    companion object {
        private const val PROGRAMS = 20
        private const val PROJECTS = 100
        private const val MILESTONES = 1_000
        private const val TEAMS = 15
        private const val PLATFORM_ROWS = 301
        private const val FLAGS_PER_MILESTONE = 3
        private const val POINTS_PER_CHILD = 3.0
        private const val RUNS = 5

        /**
         * The statements one [JiraFlagSource.flagsInTransaction] load sends, whole plan or one project alike (measured 2026-11-07, plus the
         * 1.12 stored acknowledgements):
         * the bindings with their latest observation (1), the connections (1), the plan nodes (the project and milestone rows, 2), the
         * derived spans (1), the bound-to map (1), the coverage reads (programs, projects, the Jira children of bound parents and the
         * plan's milestone names: 4), the ONE roll-up `GROUP BY (connection, parent)` (1) and, since 1.12, the per-line stored
         * acknowledgements (`Acknowledgements.storedOf`, 1) = 12. Every one is an `IN (...)` over the scoped ids; none is per
         * binding. A deliberate new loader raises this figure and gets its entry here.
         */
        private const val LOADER_STATEMENTS = 12
        private const val DISABLED_RUNS = 3
        private const val NANOS_PER_MILLI = 1_000_000.0

        /**
         * The documented size gate of the team view WITH the overlay: 301 rows, every one bound with three flags (this world), revised from
         * v0.9's 260 KB to the measurement (`timeline.md` "Measured figures (1.3)"). It is NOT the ceiling: the kernel can raise seven
         * flags on a milestone (about 745 KB on the sample plan), which no realistic plan reaches. The wire is gzip: the realistic
         * projection is about 38 KB there (this synthetic world compresses 50:1, the real Platform view 11.6:1), so the gzip gate has
         * little headroom and slimming (`BACKLOG.md` "Slim the Jira blocks") is the lever.
         */
        private const val TEAM_VIEW_GATE_BYTES = 500_000
        private const val TEAM_VIEW_GZIP_GATE_BYTES = 40_000

        /** The project view with the overlay: a project of ten milestones, about +2 KB for the overlay, +3 KB for the Jira blocks. */
        private const val PROJECT_VIEW_GATE_BYTES = 40_000

        /** Loose: at least 5x the dev-machine figure (the v0.9 gates are 30 ms on the largest team), so a slower runner never flakes it. */
        private const val P50_TRIPWIRE_MS = 1_000.0

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
