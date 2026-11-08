package ch.nokillswit

import ch.nokillswit.infra.db.R2dbcDatabaseKey
import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraConnectionServiceKey
import ch.nokillswit.jira.JiraConnectorKey
import ch.nokillswit.jira.JiraIssueStore
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraObserver
import ch.nokillswit.jira.JiraRunStore
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunList
import ch.nokillswit.sync.SyncRunServiceKey
import ch.nokillswit.sync.SyncTrigger
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.equalTo
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo
import com.github.tomakehurst.wiremock.stubbing.Scenario
import com.github.tomakehurst.wiremock.stubbing.StubMapping
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.AfterClass
import org.junit.BeforeClass
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals

/**
 * How a run fails against the stub: a transport failure on a later page (the typed code, whole chunks written and nothing more), an
 * expired page cursor (one restart from the same query, then the typed failure). The stub's request shapes are pinned in
 * `sample-data/jira/README.md`: the sample scope's typed full read is 12 pages whose cursors are
 * `sample-fulltypes-eip-started-p<n>`. Every override
 * is removed, and every scenario reset, in a `finally`; see `JiraRunTest` for why that is the rule for this shared stub.
 */
class JiraRunFailureTest {
    companion object {
        private const val SEARCH = "/ex/jira/${JiraStubServer.CLOUD_ID}/rest/api/3/search/jql"
        private val SAMPLE = listOf("CE", "PF", "CG", "DI", "OE")

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }

        @JvmStatic
        @AfterClass
        fun leaveStubAsFound() {
            JiraStubServer.resetScenarios()
        }
    }

    private suspend fun ApplicationTestBuilder.start() {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt) {
        suspend fun bind(key: String): JiraBindingResponse =
            w.admin.client.jbBind(connectionId, JiraLevel.MILESTONE, node(w), key).jbBinding()
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        start()
        val w = planWorld(prefix, teams = true)
        return Fixture(w, w.admin.client.jbConnection(jbRequest(keys = SAMPLE)).id)
    }

    /** A page of the sample full read answers [status] (once when [once], else every time) for its cursor; removed by the caller. */
    private fun failPage(page: Int, status: Int, once: Boolean): StubMapping {
        val builder = get(urlPathEqualTo(SEARCH)).atPriority(1)
            .withQueryParam("nextPageToken", equalTo("sample-fulltypes-eip-started-p$page"))
        if (once) builder.inScenario("cursor-${UUID.randomUUID()}").whenScenarioStateIs(Scenario.STARTED).willSetStateTo("spent")
        return JiraStubServer.addOverride(builder.willReturn(aResponse().withStatus(status).withBody("{}")))
    }

    private suspend fun ApplicationTestBuilder.run(chunkSize: Int, connectionId: UInt): SyncResult {
        val app = application
        val runs = app.attributes[SyncRunServiceKey]
        val observer = JiraObserver(
            app.attributes[JiraConnectorKey], app.attributes[JiraConnectionServiceKey],
            JiraRunStore(app.attributes[R2dbcDatabaseKey]),
            JiraIssueStore(app.attributes[R2dbcDatabaseKey]), runs, chunkSize = chunkSize,
        )
        val claimed = runs.claim(SyncKind.JIRA, connectionId, SyncTrigger.MANUAL, null)
        return observer.run(claimed).also { runs.finish(claimed.id, it) }
    }

    private fun summaryOf(id: UInt): String? =
        jbScalar("SELECT summary FROM jira_observations WHERE binding_id = ?", id.toInt()) { it.getString(1) }

    private fun stale(id: UInt) = jbSql("UPDATE jira_observations SET observed_at = 1, summary = 'stale' WHERE binding_id = ?", id.toInt())

    @Test
    fun `a fetch failure ends the run FAILED with its code and leaves whole chunks only, and the next run recovers`() = testApplication {
        val f = fixture("jrfail")
        // Three epics on the first page; a chunk of two: the first two are written, the third was still pending when page 3 failed.
        val bound = listOf("CE-25", "CE-26", "CE-27").map { f.bind(it).also { b -> stale(b.id) } }
        val override = failPage(page = 3, status = 503, once = false)
        try {
            val failed = run(chunkSize = 2, connectionId = f.connectionId)
            assertEquals(SyncOutcome.FAILED, failed.outcome)
            assertEquals("UPSTREAM_UNAVAILABLE", failed.errorCode)
            assertEquals(2, failed.counts.observed, "whole chunks only")
            assertEquals(4, failed.counts.calls, "tenant_info and pages 1, 2 and the failing 3")
            assertEquals(0, failed.counts.gone, "the sweep never ran, so nothing was flagged")
            assertEquals("stale", summaryOf(bound[2].id), "the pending third is untouched")
            assertNotEquals("stale", summaryOf(bound[0].id))
            assertNotEquals("stale", summaryOf(bound[1].id))
            val ids = bound.joinToString(",") { it.id.toString() }
            assertEquals(0, jbScalar("SELECT count(*) FROM jira_observations WHERE gone AND binding_id IN ($ids)") { it.getInt(1) })
        } finally {
            JiraStubServer.removeOverride(override)
            JiraStubServer.resetScenarios()
        }
        val recovered = run(chunkSize = 2, connectionId = f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, recovered.outcome, recovered.errorDetail)
        assertEquals(3, recovered.counts.observed)
        assertNotEquals("stale", summaryOf(bound[2].id))
    }

    @Test
    fun `a failed run's detail, as every signed-in user reads it from the runs list, names the code and no URL`() = testApplication {
        val f = fixture("jrdetail")
        f.bind("CE-25")
        val override = failPage(page = 3, status = 503, once = false)
        try {
            val failed = run(chunkSize = 2, connectionId = f.connectionId)
            assertEquals("UPSTREAM_UNAVAILABLE", failed.errorCode)
            // Read as the plain login the list is open to: the stored text is the code and the status, never the endpoint or a host.
            val listed = f.w.stranger.client.get("$SYNC_RUNS?kind=JIRA&connectionId=${f.connectionId}")
            assertEquals(HttpStatusCode.OK, listed.status)
            val row = jbJson.decodeFromString<SyncRunList>(listed.bodyAsText()).items.single()
            assertEquals(SyncOutcome.FAILED, row.outcome)
            assertEquals("Jira fetch failed: UPSTREAM_UNAVAILABLE (503)", row.errorDetail)
            val text = "${row.errorCode} ${row.errorDetail}"
            assertFalse("http" in text || "/rest/" in text || "search/jql" in text || "api.atlassian.com" in text, text)
        } finally {
            JiraStubServer.removeOverride(override)
            JiraStubServer.resetScenarios()
        }
    }

    @Test
    fun `an expired cursor restarts the read once from its first page`() = testApplication {
        val f = fixture("jrcursor")
        listOf("CE-25", "CE-26").forEach { f.bind(it) }
        val once = failPage(page = 2, status = 410, once = true)
        try {
            val restarted = run(chunkSize = 100, connectionId = f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, restarted.outcome, restarted.errorDetail)
            // tenant_info, page 1, the expired page 2, then the 12 pages again, then the 12-page sweep, then the child level's typed read
            // (the first run is full: sample/fulltypes/s/started, 6 pages).
            assertEquals(1 + (1 + 1 + 12) + 12 + 6, restarted.counts.calls)
            assertEquals(2, restarted.counts.observed)
        } finally {
            JiraStubServer.removeOverride(once)
            JiraStubServer.resetScenarios()
        }
    }

    @Test
    fun `a second expiry fails the run CURSOR_EXPIRED - the restart is once`() = testApplication {
        val f = fixture("jrcursor2")
        f.bind("CE-25")
        // A 400 on a page that carries a cursor is the expiry (Jira answers 400 or 410); no run has succeeded yet, so this is a full read.
        val always = failPage(page = 2, status = 400, once = false)
        try {
            val failed = run(chunkSize = 100, connectionId = f.connectionId)
            assertEquals(SyncOutcome.FAILED, failed.outcome)
            assertEquals("CURSOR_EXPIRED", failed.errorCode)
            // tenant_info, page 1, the expired page 2, page 1 again, the expired page 2 again: one restart, no more.
            assertEquals(5, failed.counts.calls)
        } finally {
            JiraStubServer.removeOverride(always)
            JiraStubServer.resetScenarios()
        }
    }

    @Test
    fun `a refused token fails the run AUTHENTICATION_FAILED at the first search and writes nothing`() = testApplication {
        start()
        val w = planWorld("jrauth", teams = true)
        val request = jbRequest(keys = SAMPLE)
        val connection = w.admin.client.jbConnection(request)
        val binding = w.admin.client.jbBind(connection.id, JiraLevel.MILESTONE, node(w), "CE-25").jbBinding()
        stale(binding.id)
        // The token is rotated to the stub's refused credential (`wrong-token`, sample-data/jira/README.md).
        val rotated = w.admin.client.putJson("$JB_CONNECTIONS/${connection.id}", request.copy(apiToken = "wrong-token"))
        assertEquals(HttpStatusCode.NoContent, rotated.status)
        val result = run(chunkSize = 100, connectionId = connection.id)
        assertEquals(SyncOutcome.FAILED, result.outcome)
        assertEquals("AUTHENTICATION_FAILED", result.errorCode)
        assertEquals(2, result.counts.calls, "tenant_info is unauthenticated, the first search is refused")
        assertEquals(0, result.counts.observed)
        assertEquals("stale", summaryOf(binding.id))
    }
}

private suspend fun node(w: PlanWorld) = TestPlan.milestone(w.projectId, w.requireTeams().teamId)
