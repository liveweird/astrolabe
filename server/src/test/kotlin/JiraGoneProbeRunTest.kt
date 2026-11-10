package ch.nokillswit

import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.sync.SyncOutcome
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The gone probe's run-level behaviour (`probeGone`) over a scripted `MockEngine` (`MockJiraRun`): the sweep lists nothing in scope, so
 * every bound milestone is newly flagged, and the handler answers each by-id read. The stub-backed cases (404, 200, 500, 403 and the
 * no-second-probe rule) are `JiraRunTest`'s.
 */
class JiraGoneProbeRunTest {
    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt, val bound: List<JiraBindingResponse>)

    /** A connection with E2E-4..E2E-8 bound as milestones (binding ids ascend in that order); their observations are the bind's. */
    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
        val w = planWorld(prefix, teams = true)
        val connectionId = w.admin.client.jbConnection(jbRequest()).id
        val teamId = w.requireTeams().teamId
        val bound = (4..8).map {
            w.admin.client.jbBind(connectionId, JiraLevel.MILESTONE, TestPlan.milestone(w.projectId, teamId), "E2E-$it").jbBinding()
        }
        return Fixture(w, connectionId, bound)
    }

    private fun HttpRequestData.isIssueRead() = url.encodedPath.contains("/rest/api/3/issue/")

    private fun HttpRequestData.issueId() = url.encodedPath.substringAfterLast('/')

    private fun reasonOf(binding: JiraBindingResponse): Pair<Boolean, String?> =
        jbScalar("SELECT gone, gone_reason FROM jira_observations WHERE binding_id = ?", binding.id.toInt()) {
            it.getBoolean(1) to it.getString(2)
        }

    @Test
    fun `a stop before the second probe keeps the first verdict`() = testApplication {
        val f = fixture("jrpstop")
        val mock = MockJiraRun(application) { request ->
            when {
                request.isIssueRead() -> {
                    // The first probe's answer arrives while the administrator disables the connection: the next call must not be sent.
                    jbSql("UPDATE jira_connections SET enabled = FALSE WHERE id = ?", f.connectionId.toInt())
                    failure(HttpStatusCode.NotFound)
                }
                request.url.parameters["fields"] == "id" -> jsonOk(idsPage())
                else -> jsonOk(searchPage())
            }
        }
        val result = mock.run(f.connectionId)
        assertEquals(SyncOutcome.FAILED, result.outcome)
        assertEquals("CONNECTION_DISABLED", result.errorCode)
        assertEquals(listOf(f.bound[0].issueId), mock.requests.filter { it.isIssueRead() }.map { it.issueId() }, "one probe was sent")
        assertEquals(true to "DELETED", reasonOf(f.bound[0]), "the verdict was written as it arrived")
        f.bound.drop(1).forEach { assertEquals(true to "OUT_OF_SCOPE", reasonOf(it)) }
    }

    @Test
    fun `three failures in a row stop the probe, the run still succeeds and the rest stay out of scope`() = testApplication {
        val f = fixture("jrpbreak")
        val log = LogCapture("ch.nokillswit.sync")
        try {
            val mock = MockJiraRun(application) { request ->
                when {
                    request.isIssueRead() -> failure(HttpStatusCode.InternalServerError)
                    request.url.parameters["fields"] == "id" -> jsonOk(idsPage())
                    else -> jsonOk(searchPage())
                }
            }
            val result = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
            assertEquals(5, result.counts.gone)
            assertEquals(3, mock.requests.count { it.isIssueRead() }, "the probe gave up after three failures")
            f.bound.forEach { assertEquals(true to "OUT_OF_SCOPE", reasonOf(it)) }
            val stopped = "probe stopped after 3 failures in a row: 2 binding(s) left unprobed"
            assertEquals(1, log.events.count { stopped in it.formattedMessage })
        } finally {
            log.detach()
        }
    }

    @Test
    fun `a 200 or a verdict resets the failure count`() = testApplication {
        val f = fixture("jrpreset")
        val error = HttpStatusCode.InternalServerError
        val answers = ArrayDeque(listOf(error, error, HttpStatusCode.OK, error, HttpStatusCode.NotFound))
        val mock = MockJiraRun(application) { request ->
            when {
                request.isIssueRead() -> answers.removeFirst().let {
                    if (it == HttpStatusCode.OK) jsonOk("""{"id":"1","key":"X-1"}""") else failure(it)
                }
                request.url.parameters["fields"] == "id" -> jsonOk(idsPage())
                else -> jsonOk(searchPage())
            }
        }
        val result = mock.run(f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
        assertEquals(5, mock.requests.count { it.isIssueRead() }, "never three failures in a row, so every binding was probed")
        assertEquals(true to "DELETED", reasonOf(f.bound[4]))
        assertTrue(f.bound.take(4).all { reasonOf(it) == true to "OUT_OF_SCOPE" })
    }
}
