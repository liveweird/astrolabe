package ch.nokillswit

import ch.nokillswit.planning.BaselineResponse
import ch.nokillswit.planning.BaselineView
import ch.nokillswit.plugins.ApiJson
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The baseline copy's plan-lock hold and the comparison's size at the sample plan's density (1.27.0 M1; the cells `POST /baselines` and
 * `GET /views/baseline/{id}` of `timeline.md` "Measured figures"). [CrossTeamSampleFixture] seeds 100 projects, 1,000 milestones (900
 * scheduled), about 300 links and 20 capacity periods of 15 teams over raw JDBC (no plan lock, no revision bump).
 *
 * 1. `POST /baselines` [TAKES] times as ADMIN (the first call, then five warm ones). The request is one plan
 *    write under the global `plan_state` lock, so its wall time over the in-process engine is an upper bound of the time every other
 *    plan writer waits (the argument of `TeamScheduleBatchHoldTimeTest`). Each call is asserted under [TAKE_TRIPWIRE_MS] (a loose
 *    tripwire against a regression of an order of magnitude; 61 ms at 0.9). It prints the counts the response answers and the bytes
 *    the four frozen tables hold for one baseline (`pg_column_size` of every row, indexes and the header not counted).
 * 2. The sample is then changed by raw SQL: every scheduled milestone a week later, a lag on every sample link, every sample team's
 *    capacity raised. `GET /views/baseline/{id}` is read through the shape-checked client, then sized (plain, gzip) and timed through
 *    the bare one (median of [SCALE_RUNS] warm reads, asserted under [VIEW_P50_TRIPWIRE_MS]).
 * 3. The SIZE gate is on the sample's own rows ([VIEW_MAX_BYTES]): the view's `projects[]` is the union of every project of the
 *    shared database and its milestone, link and capacity rows are the changed ones of ALL of it, so the document is reduced to the
 *    rows whose names carry this test's prefix and re-encoded with the application's own `Json` (the `HomeViewSizeTest` technique).
 *    The totals keep their database-wide values (a few bytes either way). Figures are recorded from a run of this class ALONE.
 *
 * Cleanup: the sample is hard-deleted and the [TAKES] baselines soft-deleted in a `NonCancellable` `finally` (the cap of 100 active
 * ones and the unique names are shared state). The FROZEN rows of the baselines stay - the V20/V33 triggers refuse every DELETE and
 * TRUNCATE - so each run leaves about [TAKES] x 1,400 rows in the fork's throwaway container (never a shared database of real data).
 */
class BaselineScaleTest {
    private val json = Json { ignoreUnknownKeys = true }

    private suspend fun HttpClient.take(name: String): Pair<BaselineResponse, Double> {
        val started = System.nanoTime()
        val response = post(BASELINES_PATH) {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"$name"}""")
        }
        val elapsedMs = (System.nanoTime() - started) / NANOS_PER_MILLI
        val text = response.bodyAsText()
        assertEquals(HttpStatusCode.Created, response.status, text.take(300))
        return json.decodeFromString<BaselineResponse>(text) to elapsedMs
    }

    /** Rows and stored bytes of baseline [id] in each of the four frozen tables (the row's own `pg_column_size`). */
    private fun frozen(id: UInt): Map<String, Pair<Int, Int>> = FROZEN_TABLES.associateWith { table ->
        val sql = "SELECT count(*), coalesce(sum(pg_column_size(t.*)), 0) FROM $table t WHERE baseline_id = $id"
        TestPlan.scalar(sql) { it.getInt(1) to it.getLong(2).toInt() }
    }

    /** Changes the sample's own rows and answers how many it changed: (milestones, links, capacity periods). */
    private fun changeSample(prefix: String): Triple<Int, Int, Int> = PostgresTestSupport.connect().use { c ->
        c.createStatement().use { st ->
            val milestones = "SELECT id FROM milestones WHERE name LIKE '$prefix-m%'"
            val teams = "SELECT id FROM teams WHERE name LIKE '$prefix-t%'"
            Triple(
                st.executeUpdate(
                    "UPDATE milestones SET start_date = start_date + 7, end_date = end_date + 7 " +
                        "WHERE name LIKE '$prefix-m%' AND start_date IS NOT NULL",
                ),
                st.executeUpdate("UPDATE dependencies SET lag_days = $LAG_DAYS WHERE pred_milestone_id IN ($milestones)"),
                st.executeUpdate("UPDATE team_capacity_periods SET md_per_week = md_per_week + $RAISE_MD WHERE team_id IN ($teams)"),
            )
        }
    }

    /** [view] reduced to the rows whose names carry [prefix] (this test's own); the totals and the `baseline` block are as they were. */
    private fun BaselineView.sampleOnly(prefix: String): BaselineView = copy(
        projects = projects.filter { it.name.startsWith("$prefix-pj") },
        milestones = milestones.filter { it.name.startsWith("$prefix-m") },
        links = links.copy(
            items = links.items.filter { it.predecessor.name.startsWith("$prefix-m") && it.successor.name.startsWith("$prefix-m") },
        ),
        capacity = capacity.copy(teams = capacity.teams.filter { it.teamName.startsWith("$prefix-t") }),
    )

    private suspend fun takeAll(admin: ScaleCaller, sample: CrossTeamSample, taken: MutableList<UInt>) {
        val calls = List(TAKES) { admin.bare.take(planName("blscale-bl")).also { taken += it.first.id } }
        val first = calls.first().first
        // A baseline copies the WHOLE plan: the shared container may hold more than the sample, never less.
        assertTrue(first.milestoneCount >= sample.milestones, "${first.milestoneCount} milestones frozen")
        assertTrue(first.projectCount >= SAMPLE_PROJECTS, "${first.projectCount} projects frozen")
        assertTrue((first.dependencyCount ?: 0) >= sample.links, "${first.dependencyCount} links frozen")
        assertTrue((first.capacityPeriodCount ?: 0) >= SAMPLE_PERIODS, "${first.capacityPeriodCount} capacity periods frozen")
        println(
            "scale-figure\tPOST /baselines, frozen rows\t${first.milestoneCount} milestones, ${first.projectCount} projects, " +
                "${first.dependencyCount} links, ${first.capacityPeriodCount} capacity periods",
        )
        val stored = frozen(first.id)
        stored.forEach { (table, rows) -> ScaleFigures.printBytes("POST /baselines stored, $table (${rows.first} rows)", rows.second) }
        ScaleFigures.printBytes("POST /baselines stored, the four tables, one baseline", stored.values.sumOf { it.second })
        ScaleFigures.print("POST /baselines first request", calls.first().second)
        val warm = calls.drop(1).map { it.second }
        ScaleFigures.printSeries("POST /baselines warm", warm)
        calls.forEachIndexed { index, call ->
            assertTrue(call.second <= TAKE_TRIPWIRE_MS, "baseline copy #${index + 1} took ${call.second} ms, over the tripwire")
        }
    }

    @Test
    fun `a baseline copy at the sample's size stays inside its tripwires and its comparison under the byte gate`() = testApplication {
        usePostgresTestcontainer()
        val admin = scaleAdmin("blscale-ad")
        val prefix = planName("blscale")
        val taken = mutableListOf<UInt>()
        try {
            val sample = CrossTeamSampleFixture.seed(prefix)
            assertEquals(1000, sample.milestones)
            takeAll(admin, sample, taken)

            val (shifted, relagged, raised) = changeSample(prefix)
            assertEquals(sample.scheduled, shifted, "every scheduled sample milestone moved a week")
            assertEquals(sample.links, relagged, "every sample link got a lag")
            assertEquals(SAMPLE_PERIODS, raised, "every sample capacity period was raised")

            val path = "/api/v1/views/baseline/${taken.last()}"
            val shape = admin.conformant.get(path)
            assertEquals(HttpStatusCode.OK, shape.status)
            val view = shape.body<BaselineView>()
            val reading = admin.bare.readDocument(path)
            ScaleFigures.printBytes("baseline view (every project of the database) size", reading.size)
            ScaleFigures.printBytes("baseline view (every project of the database) gzip", reading.gzip)
            ScaleFigures.printSeries("GET /views/baseline/{id}", reading.timings)

            val mine = view.sampleOnly(prefix)
            assertEquals(SAMPLE_PROJECTS, mine.projects.size, "every sample project is a row")
            assertEquals(sample.scheduled, mine.milestones.size, "every moved sample milestone is a changed row")
            assertEquals(sample.links, mine.links.items.size, "every relagged sample link is a changed row")
            assertEquals(sample.teamIds.size, mine.capacity.teams.size, "every sample team's capacity changed")
            assertTrue(view.links.captured && view.capacity.captured, "the baseline froze links and capacity")
            assertFalse(view.links.truncated || view.capacity.truncated, "the caps are not reached at the sample's size")
            val sampleJson = ApiJson.encodeToString(BaselineView.serializer(), mine).toByteArray()
            ScaleFigures.printBytes("baseline view (sample's rows, gated) size", sampleJson.size)
            ScaleFigures.printBytes("baseline view (sample's rows, gated) gzip", gzipSize(sampleJson))
            println(
                "scale-figure\tbaseline view rows listed for the sample\t${mine.milestones.size} milestones, ${mine.projects.size} " +
                    "projects, ${mine.links.items.size} links, ${mine.capacity.teams.sumOf { it.changes.size }} capacity changes " +
                    "of ${mine.capacity.teams.size} teams",
            )

            assertTrue(sampleJson.size <= VIEW_MAX_BYTES, "the comparison is ${sampleJson.size} bytes, over the $VIEW_MAX_BYTES gate")
            assertTrue(reading.median <= VIEW_P50_TRIPWIRE_MS, "the comparison's median is ${reading.median} ms, over the tripwire")
        } finally {
            // NonCancellable: a test cancelled by the 60 s limit must still soft-delete its baselines and take the sample out. The
            // frozen rows of the baselines are NOT removed: the V20/V33 triggers refuse every DELETE and TRUNCATE on them.
            withContext(NonCancellable) {
                try {
                    taken.forEach { id -> runCatching { TestPlan.deleteBaseline(id) } }
                } finally {
                    CrossTeamSampleFixture.remove(prefix)
                }
            }
        }
        assertEquals(0, CrossTeamSampleFixture.remaining(prefix), "the synthetic plan is hard-deleted")
        val active = TestPlan.scalar("SELECT count(*) FROM baselines WHERE id IN (${taken.joinToString(",")}) AND NOT marked_as_deleted") {
            it.getInt(1)
        }
        assertEquals(0, active, "the baselines are soft-deleted (their frozen rows stay)")
    }

    private companion object {
        const val BASELINES_PATH = "/api/v1/baselines"

        /** The fixture's shape: 100 projects, 20 capacity periods (15 first ones and a second from 2028 on every third team). */
        const val SAMPLE_PROJECTS = 100
        const val SAMPLE_PERIODS = 20

        /** The first copy and five warm ones. */
        const val TAKES = 6
        const val LAG_DAYS = 5
        const val RAISE_MD = 5
        const val NANOS_PER_MILLI = 1_000_000.0

        /** A LOOSE tripwire (the stop line for the lock hold, 250 ms warm median, is in `timeline.md` and not asserted here). */
        const val TAKE_TRIPWIRE_MS = 5_000.0
        const val VIEW_P50_TRIPWIRE_MS = 1_000.0

        /** The measured 432,811 B (three runs alone, `timeline.md` "Measured figures") plus 10 percent. */
        const val VIEW_MAX_BYTES = 476_100

        val FROZEN_TABLES = listOf("baseline_projects", "baseline_milestones", "baseline_dependencies", "baseline_capacity_periods")
    }
}
