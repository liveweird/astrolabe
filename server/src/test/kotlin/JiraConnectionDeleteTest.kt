package ch.nokillswit

import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunServiceKey
import ch.nokillswit.sync.SyncTrigger
import io.ktor.client.request.delete
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * What deleting a Jira connection takes with it (1.1.0 F2): its runs (hard-deleted in the delete's transaction, so they are not visible
 * for ever in the unfiltered run list) and, for a run still in flight, every later write - its finish is a no-op and its chunks find no
 * ACTIVE binding to observe. The connection and the one binding are made through the API against the shared stub (the bind reads the
 * issue there); the run itself is scripted over a Ktor `MockEngine` (`MockJiraRun`).
 */
class JiraConnectionDeleteTest {
    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }

    private fun runCount(connectionId: UInt): Int =
        jbScalar("SELECT count(*) FROM sync_runs WHERE connection_id = ?", connectionId.toInt()) { it.getInt(1) }

    private fun summaryOf(bindingId: UInt): String? =
        jbScalar("SELECT summary FROM jira_observations WHERE binding_id = ?", bindingId.toInt()) { it.getString(1) }

    @Test
    fun `deleting a connection removes its runs and a run in flight can neither finish nor observe`() = testApplication {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
        val w = planWorld("jrdel", teams = true)
        val admin = w.admin.client
        val connectionId = admin.jbConnection().id
        val milestone = TestPlan.milestone(w.projectId, w.requireTeams().teamId, planName("ms"))
        val binding = admin.jbBind(connectionId, JiraLevel.MILESTONE, milestone, "E2E-5").jbBinding()
        jbSql("UPDATE jira_observations SET observed_at = 1, summary = 'stale' WHERE binding_id = ?", binding.id.toInt())

        // A finished earlier run of the connection, and the run of this test: the script deletes the connection while its first search is
        // "on the wire", then answers a page that WOULD overwrite the stale summary.
        val runs = application.attributes[SyncRunServiceKey]
        runs.finish(runs.claim(SyncKind.JIRA, connectionId, SyncTrigger.MANUAL, null).id, SyncResult.failed("INTERNAL", "history"))
        assertEquals(1, runCount(connectionId))
        var deleted = false
        val mock = MockJiraRun(application) { request ->
            if (!deleted && request.url.parameters["fields"] != "id") {
                deleted = true
                assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_CONNECTIONS/$connectionId").status)
            }
            val sweep = request.url.parameters["fields"] == "id"
            jsonOk(if (sweep) idsPage(binding.issueId) else searchPage(issueDoc(binding.issueId, binding.issueKey, summary = "fresh")))
        }

        val result = mock.run(connectionId)
        assertTrue(deleted, "the connection was deleted while the run was in flight")
        // The next page request (the sweep's) never left: the token of a deleted connection authenticates nothing more.
        assertEquals(SyncOutcome.FAILED, result.outcome)
        assertEquals("CONNECTION_GONE", result.errorCode)
        assertEquals(1, mock.searches.size, "only the read's page went out; the sweep was not sent")
        assertEquals(0, runCount(connectionId), "the history went with the connection, and the in-flight run's own row with it")
        assertEquals("stale", summaryOf(binding.id), "no observation was written after the delete")
        assertEquals(false, jbActive(binding.id), "the binding went with the connection")
        val fresh = jbScalar("SELECT count(*) FROM jira_observations WHERE binding_id = ? AND observed_at > 1", binding.id.toInt()) {
            it.getInt(1)
        }
        assertEquals(0, fresh)
    }

    @Test
    fun `a run stops before its next page when its connection is disabled meanwhile`() = testApplication {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
        val w = planWorld("jrdis", teams = true)
        val admin = w.admin.client
        val connectionId = admin.jbConnection().id
        val milestone = TestPlan.milestone(w.projectId, w.requireTeams().teamId, planName("ms"))
        val binding = admin.jbBind(connectionId, JiraLevel.MILESTONE, milestone, "E2E-5").jbBinding()
        var disabled = false
        val mock = MockJiraRun(application) { request ->
            if (!disabled) {
                disabled = true
                jbSql("UPDATE jira_connections SET enabled = FALSE WHERE id = ?", connectionId.toInt())
            }
            val sweep = request.url.parameters["fields"] == "id"
            jsonOk(if (sweep) idsPage(binding.issueId) else searchPage(issueDoc(binding.issueId, binding.issueKey, summary = "fresh")))
        }

        val result = mock.run(connectionId)
        assertEquals(SyncOutcome.FAILED, result.outcome)
        assertEquals("CONNECTION_DISABLED", result.errorCode)
        assertEquals(1, mock.searches.size, "the sweep was not sent")
        assertEquals("fresh", summaryOf(binding.id), "the page already read was kept: whole chunks only")
        assertEquals(1, runCount(connectionId), "the run's row is its record; it is finished, not lost")
        admin.delete("$JB_CONNECTIONS/$connectionId")
    }
}
