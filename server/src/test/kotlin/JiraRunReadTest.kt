package ch.nokillswit

import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncRunner
import ch.nokillswit.sync.SyncTrigger
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.request.HttpResponseData
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.withTimeout
import org.junit.BeforeClass
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * What the run reads and how, with the REAL observer over a scripted `MockEngine` (`MockJiraRun`): the clock-relative bound and its
 * restart, a sweep that fails, hits its ceiling or is not a listing, an incremental that outgrows its ceiling, a moved issue's key, the
 * throttling figures and the counters of a run that is cut. The connection and its bindings are made against the stub (the Test
 * connection needs it); the runs never touch it.
 */
class JiraRunReadTest {
    companion object {
        private const val DAY = 86_400_000L
        private const val MINUTE = 60_000L

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt) {
        suspend fun bind(key: String): JiraBindingResponse =
            w.admin.client.jbBind(connectionId, JiraLevel.MILESTONE, milestone(), key).jbBinding()

        private suspend fun milestone() = TestPlan.milestone(w.projectId, w.requireTeams().teamId)

        suspend fun binding(id: UInt): JiraBindingResponse =
            jbJson.decodeFromString(w.admin.client.get("$JB_BINDINGS/$id").also { assertEquals(HttpStatusCode.OK, it.status) }.bodyAsText())
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
        val w = planWorld(prefix, teams = true)
        return Fixture(w, w.admin.client.jbConnection(jbRequest()).id)
    }

    private fun goneOf(bindingId: UInt): Boolean =
        jbScalar("SELECT gone FROM jira_observations WHERE binding_id = ?", bindingId.toInt()) { it.getBoolean(1) }

    private fun isSweep(request: io.ktor.client.request.HttpRequestData) = request.url.parameters["fields"] == "id"

    private fun finishedRun(connectionId: UInt, startedAt: Long, outcome: String) = jbSql(
        "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome) VALUES ('JIRA', ?, 'MANUAL', ?, ?, ?)",
        connectionId.toInt(), startedAt, startedAt + 1_000, outcome,
    )

    // --- the relative bound -------------------------------------------------------------------------------------------------------

    @Test
    fun `the incremental bound counts from the last SUCCEEDED run's start and is recomputed from the clock at a restart`() =
        testApplication {
            val f = fixture("jrrbound")
            f.bind("E2E-5")
            // A day ahead: later than the connection's own edits, so nothing forces a full read.
            var clock = System.currentTimeMillis() + DAY
            val lastSucceeded = clock - 125 * MINUTE - MINUTE / 2
            finishedRun(f.connectionId, lastSucceeded - 3 * DAY, "SUCCEEDED") // an older success: the NEWEST one counts
            finishedRun(f.connectionId, lastSucceeded, "SUCCEEDED")
            finishedRun(f.connectionId, clock - 30 * MINUTE, "FAILED") // a failure after it moves nothing
            val expired = AtomicInteger(0)
            val mock = MockJiraRun(application, now = { clock }) { request ->
                when {
                    isSweep(request) -> jsonOk(idsPage("90005"))
                    request.url.parameters["nextPageToken"] == null -> jsonOk(searchPage(issueDoc("90005", "E2E-5"), next = "t2"))
                    expired.getAndIncrement() == 0 -> {
                        clock += 5 * MINUTE // the cursor dies five minutes into the read
                        failure(HttpStatusCode.BadRequest)
                    }
                    else -> jsonOk(searchPage(issueDoc("90005", "E2E-5")))
                }
            }
            val result = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
            val reads = mock.searches.filter { it.url.parameters["nextPageToken"] == null && !isSweep(it) }
            // ceil(125.5 min) = 126, plus the 10-minute overlap; after five more minutes ceil(130.5) = 131 + 10.
            assertEquals("""project in ("E2E") AND updated >= "-136m" ORDER BY updated ASC""", reads.first().url.parameters["jql"])
            assertEquals("""project in ("E2E") AND updated >= "-141m" ORDER BY updated ASC""", reads.last().url.parameters["jql"])
            assertEquals(2, reads.size, "one restart, from the first page")
        }

    // --- the sweep ----------------------------------------------------------------------------------------------------------------

    @Test
    fun `a sweep that fails, or hits its page ceiling, flags nothing`() = testApplication {
        val f = fixture("jrrsweep")
        val bound = listOf(f.bind("E2E-4"), f.bind("E2E-5"))
        var sweep: suspend MockRequestHandleScope.(Int) -> HttpResponseData = { jsonOk(idsPage()) }
        val sweeps = AtomicInteger(0)
        val mock = MockJiraRun(application) { request ->
            val read = searchPage(issueDoc("90004", "E2E-4"), issueDoc("90005", "E2E-5"))
            if (isSweep(request)) sweep(sweeps.incrementAndGet()) else jsonOk(read)
        }
        sweep = { failure(HttpStatusCode.ServiceUnavailable) }
        val failed = mock.run(f.connectionId)
        assertEquals(SyncOutcome.FAILED, failed.outcome)
        assertEquals("UPSTREAM_UNAVAILABLE", failed.errorCode)
        assertEquals(0, failed.counts.gone)
        assertTrue(bound.none { goneOf(it.id) })

        // Endless pages with a fresh cursor each: the 201st page is the ceiling. Nothing seen so far is a verdict.
        sweeps.set(0)
        sweep = { n -> jsonOk(searchPage("""{"id":"1$n"}""", next = "cursor-$n")) }
        val capped = mock.run(f.connectionId)
        assertEquals(SyncOutcome.FAILED, capped.outcome)
        assertEquals("LIMIT_EXCEEDED", capped.errorCode)
        assertEquals(200, sweeps.get())
        assertTrue(bound.none { goneOf(it.id) })
    }

    @Test
    fun `a 200 that is not a listing is INVALID_RESPONSE, while a genuine empty listing still flags, with a warning`() =
        testApplication {
            val f = fixture("jrrmalformed")
            val bound = listOf(f.bind("E2E-4"), f.bind("E2E-5"))
            var readBody = searchPage(issueDoc("90004", "E2E-4"), issueDoc("90005", "E2E-5"))
            var sweepBody = idsPage("90004", "90005")
            val mock = MockJiraRun(application) { request -> jsonOk(if (isSweep(request)) sweepBody else readBody) }
            sweepBody = """{"isLast":true}"""
            assertEquals("INVALID_RESPONSE", mock.run(f.connectionId).errorCode, "no issues member on the sweep")
            sweepBody = """{"issues":[],"isLast":false}"""
            assertEquals("INVALID_RESPONSE", mock.run(f.connectionId).errorCode, "isLast false and no token to continue from")
            sweepBody = idsPage("90004", "90005")
            readBody = """{"isLast":true}"""
            assertEquals("INVALID_RESPONSE", mock.run(f.connectionId).errorCode, "no issues member on the read")
            assertTrue(bound.none { goneOf(it.id) }, "a malformed answer is never an empty listing")

            readBody = searchPage()
            sweepBody = """{"issues":[],"isLast":true}"""
            val warnings = LogCapture("ch.nokillswit.sync")
            try {
                val result = mock.run(f.connectionId)
                assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
                assertEquals(2, result.counts.gone, "a genuinely empty listing flags (a false flag heals on the next good sweep)")
                val warn = warnings.events.firstOrNull { "sweep listed no issue at all" in it.formattedMessage }
                assertEquals("WARN", assertNotNull(warn).level.toString())
                assertFalse(warnings.events.any { "E2E" in it.formattedMessage }, "the line carries counts, no issue data")
            } finally {
                warnings.detach()
            }
        }

    // --- the read -----------------------------------------------------------------------------------------------------------------

    @Test
    fun `an incremental that outgrows its page ceiling restarts once as the typed full read`() = testApplication {
        val f = fixture("jrrlimit")
        val binding = f.bind("E2E-5")
        val pages = AtomicInteger(0)
        val mock = MockJiraRun(application) { request ->
            val jql = request.url.parameters["jql"].orEmpty()
            when {
                isSweep(request) -> jsonOk(idsPage("90005"))
                "updated >=" in jql -> jsonOk(searchPage("""{"id":"2${pages.incrementAndGet()}"}""", next = "w-${pages.get()}"))
                else -> jsonOk(searchPage(issueDoc("90005", "E2E-5", summary = "from-full")))
            }
        }
        assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
        jbSql("UPDATE jira_observations SET summary = 'stale' WHERE binding_id = ?", binding.id.toInt())
        val second = mock.run(f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, second.outcome, second.errorDetail)
        // tenant_info, 200 incremental pages, the full read, the sweep.
        assertEquals(1 + 200 + 1 + 1, second.counts.calls)
        assertEquals(1, second.counts.observed)
        assertEquals("from-full", f.binding(binding.id).observation?.summary)
        val full = mock.searches.last { !isSweep(it) }.url.parameters["jql"]
        assertEquals("""project in ("E2E") AND issuetype in (10006,10005,10004) ORDER BY id ASC""", full)
    }

    @Test
    fun `a moved issue's new key reaches the binding - its list, url and sort - and only that binding's updated_at`() = testApplication {
        val f = fixture("jrrkey")
        val moved = f.bind("E2E-5")
        val still = f.bind("E2E-4")
        fun updatedAt(id: UInt) = jbScalar("SELECT updated_at FROM jira_bindings WHERE id = ?", id.toInt()) { it.getLong(1) }
        val stillBefore = updatedAt(still.id)
        val movedBefore = updatedAt(moved.id)
        val mock = MockJiraRun(application) { request ->
            jsonOk(if (isSweep(request)) idsPage("90004", "90005") else searchPage(issueDoc("90004", "E2E-4"), issueDoc("90005", "E2E-77")))
        }
        assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
        val after = f.binding(moved.id)
        assertEquals("E2E-77", after.issueKey)
        assertTrue(after.url.endsWith("/browse/E2E-77"), after.url)
        assertEquals("E2E-77", after.observation?.issueKey)
        assertTrue(updatedAt(moved.id) > movedBefore)
        assertEquals(stillBefore, updatedAt(still.id), "a binding whose key did not change is not touched")
        val settled = updatedAt(moved.id)
        assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
        assertEquals(settled, updatedAt(moved.id), "an unchanged key writes nothing")
        val keys = jbJson.decodeFromString<ch.nokillswit.infra.paging.PageResponse<JiraBindingResponse>>(
            f.w.admin.client.get("$JB_BINDINGS?connectionId=${f.connectionId}&sort=-issueKey").bodyAsText(),
        ).items.map { it.issueKey }
        assertEquals(listOf("E2E-77", "E2E-4"), keys)
    }

    @Test
    fun `rate limiting and backoff reach the run's counters`() = testApplication {
        val f = fixture("jrrthrottle")
        f.bind("E2E-5")
        val limited = AtomicInteger(0)
        val mock = MockJiraRun(application, maxRetries = 2) { request ->
            when {
                !isSweep(request) && limited.getAndIncrement() == 0 -> failure(HttpStatusCode.TooManyRequests)
                isSweep(request) -> jsonOk(idsPage("90005"))
                else -> jsonOk(searchPage(issueDoc("90005", "E2E-5")))
            }
        }
        val result = mock.run(f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
        assertEquals(1, result.counts.rateLimited)
        assertTrue(result.counts.backoffMs > 0, "the backoff the 429 asked for is counted")
    }

    // --- a run that is cut keeps what it spent ------------------------------------------------------------------------------------

    @Test
    fun `a run cut by its deadline or by a shutdown still records the calls it had made`() = testApplication {
        val f = fixture("jrrcut")
        f.bind("E2E-5")
        val hanging = Channel<Unit>(Channel.UNLIMITED)
        val mock = MockJiraRun(application) { request ->
            if (isSweep(request)) {
                jsonOk(idsPage("90005"))
            } else {
                hanging.trySend(Unit)
                awaitCancellation()
            }
        }
        val runs = mock.runs
        val deadline = SyncRunner(CoroutineScope(SupervisorJob() + Dispatchers.IO), runs, deadlineMillis = 500)
        val first = runs.claim(ch.nokillswit.sync.SyncKind.JIRA, f.connectionId, SyncTrigger.MANUAL, null)
        deadline.start(mock.connector, first)
        withTimeout(60_000) { deadline.await(first.id) }
        val cut = runs.list(ch.nokillswit.sync.SyncKind.JIRA, f.connectionId).single { it.id == first.id }
        assertEquals("RUN_DEADLINE", cut.errorCode)
        assertEquals(2, cut.callCount, "tenant_info and the search that never answered")
        hanging.receive() // the first run's request

        val shutdown = SyncRunner(CoroutineScope(SupervisorJob() + Dispatchers.IO), runs)
        val second = runs.claim(ch.nokillswit.sync.SyncKind.JIRA, f.connectionId, SyncTrigger.MANUAL, null)
        shutdown.start(mock.connector, second)
        withTimeout(60_000) { hanging.receive() } // the second run's request is in flight
        shutdown.shutdown()
        val stopped = runs.list(ch.nokillswit.sync.SyncKind.JIRA, f.connectionId).single { it.id == second.id }
        assertEquals("SHUTDOWN", stopped.errorCode)
        assertEquals(2, stopped.callCount)
    }

    // --- an odd type id -----------------------------------------------------------------------------------------------------------

    @Test
    fun `a site's issue-type id that is not digits fails the run MAPPING_INVALID before anything is read`() = testApplication {
        val f = fixture("jrrtypeid")
        f.bind("E2E-5")
        jbSql(
            "UPDATE jira_connections SET discovery = jsonb_set(discovery, '{issueTypes}', " +
                "(SELECT jsonb_agg(CASE WHEN t->>'name' = 'Epic' THEN jsonb_set(t, '{id}', '\"1x4\"') ELSE t END) " +
                "FROM jsonb_array_elements(discovery->'issueTypes') t)) WHERE id = ?",
            f.connectionId.toInt(),
        )
        val mock = MockJiraRun(application) { error("no request expected") }
        val result = mock.run(f.connectionId)
        assertEquals(SyncOutcome.FAILED, result.outcome)
        assertEquals("MAPPING_INVALID", result.errorCode)
        assertTrue(mock.requests.isEmpty())
    }
}
