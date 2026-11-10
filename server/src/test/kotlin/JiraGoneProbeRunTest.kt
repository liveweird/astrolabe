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

    private fun probed(binding: JiraBindingResponse): Boolean =
        jbScalar("SELECT gone_probed_at IS NOT NULL FROM jira_observations WHERE binding_id = ?", binding.id.toInt()) { it.getBoolean(1) }

    private fun reasonOf(binding: JiraBindingResponse): Pair<Boolean, String?> =
        jbScalar("SELECT gone, gone_reason FROM jira_observations WHERE binding_id = ?", binding.id.toInt()) {
            it.getBoolean(1) to it.getString(2)
        }

    @Test
    fun `a stop before the second probe keeps the first verdict, and a later run probes the four unanswered bindings`() = testApplication {
        val f = fixture("jrpstop")
        var disable = true
        val mock = MockJiraRun(application) { request ->
            when {
                request.isIssueRead() -> {
                    // The first probe's answer arrives while the administrator disables the connection: the next call must not be sent.
                    if (disable) jbSql("UPDATE jira_connections SET enabled = FALSE WHERE id = ?", f.connectionId.toInt())
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
        assertEquals(listOf(true, false, false, false, false), f.bound.map { probed(it) })

        // A cut probe is retried: the connection is back, and exactly the four unanswered bindings are probed (the answered one is not).
        disable = false
        jbSql("UPDATE jira_connections SET enabled = TRUE WHERE id = ?", f.connectionId.toInt())
        val before = mock.requests.size
        val second = mock.run(f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, second.outcome, second.errorDetail)
        assertEquals(
            f.bound.drop(1).map { it.issueId },
            mock.requests.drop(before).filter { it.isIssueRead() }.map { it.issueId() },
            "the four unanswered bindings, by binding id",
        )
        f.bound.forEach { assertEquals(true to "DELETED", reasonOf(it)) }
        assertTrue(f.bound.all { probed(it) })
    }

    @Test
    fun `three failures in a row stop the probe, the run still succeeds, and a later run probes all five`() = testApplication {
        val f = fixture("jrpbreak")
        val log = LogCapture("ch.nokillswit.sync")
        try {
            var healthy = false
            val mock = MockJiraRun(application) { request ->
                when {
                    request.isIssueRead() -> failure(if (healthy) HttpStatusCode.NotFound else HttpStatusCode.InternalServerError)
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
            assertTrue(f.bound.none { probed(it) }, "a failure stamps nothing")

            // Jira answers again: the next run probes every one of the five (none had an answer) and all read DELETED.
            healthy = true
            val before = mock.requests.size
            val second = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, second.outcome, second.errorDetail)
            assertEquals(5, mock.requests.drop(before).count { it.isIssueRead() })
            f.bound.forEach { assertEquals(true to "DELETED", reasonOf(it)) }
            assertTrue(f.bound.all { probed(it) })
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
        assertEquals(listOf(false, false, true, false, true), f.bound.map { probed(it) }, "the 200 and the 404 answered; the 500s did not")
    }

    @Test
    fun `retries whose read keeps failing trip the breaker after the newly flagged bindings, which are probed in their own run`() =
        testApplication {
            val f = fixture("jrpfirst")
            val stuck = f.bound.take(3)
            val fresh = f.bound.drop(3)
            val stuckIds = stuck.map { it.issueId }
            // Three old, unanswered gone bindings (lower ids) whose by-id read fails; the two higher-id ones are flagged by THIS run.
            stuck.forEach {
                jbSql(
                    "UPDATE jira_observations SET gone = TRUE, gone_reason = 'OUT_OF_SCOPE', gone_probed_at = NULL WHERE binding_id = ?",
                    it.id.toInt(),
                )
            }
            val mock = MockJiraRun(application) { request ->
                when {
                    request.isIssueRead() ->
                        failure(if (request.issueId() in stuckIds) HttpStatusCode.InternalServerError else HttpStatusCode.NotFound)
                    request.url.parameters["fields"] == "id" -> jsonOk(idsPage())
                    else -> jsonOk(searchPage())
                }
            }
            val result = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
            assertEquals(
                fresh.map { it.issueId } + stuck.map { it.issueId },
                mock.requests.filter { it.isIssueRead() }.map { it.issueId() },
                "the newly flagged first, then the retries, each by binding id; the breaker then stops the probe",
            )
            fresh.forEach { assertEquals(true to "DELETED", reasonOf(it)) }
            assertEquals(listOf(false, false, false, true, true), f.bound.map { probed(it) })
        }

    @Test
    fun `a probe beyond the per-run cap waits for a later run - two, two, one across three runs`() = testApplication {
        val f = fixture("jrpcap")
        val mock = MockJiraRun(application, probeCap = 2) { request ->
            when {
                request.isIssueRead() -> failure(HttpStatusCode.NotFound)
                request.url.parameters["fields"] == "id" -> jsonOk(idsPage())
                else -> jsonOk(searchPage())
            }
        }
        val probedByRun = (1..3).map {
            val before = mock.requests.size
            val result = mock.run(f.connectionId)
            assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
            mock.requests.drop(before).filter { it.isIssueRead() }.map { it.issueId() }
        }
        assertEquals(listOf(2, 2, 1), probedByRun.map { it.size })
        assertEquals(f.bound.map { it.issueId }, probedByRun.flatten(), "by binding id, each once")
        f.bound.forEach { assertEquals(true to "DELETED", reasonOf(it)) }
        val fourth = mock.requests.size
        assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
        assertEquals(0, mock.requests.drop(fourth).count { it.isIssueRead() }, "everything answered: nothing is probed again")
    }

    @Test
    fun `a row flagged gone before 1_10 - gone, OUT_OF_SCOPE, no stamp - is probed by the next run`() = testApplication {
        val f = fixture("jrpold")
        val planted = f.bound[2]
        jbSql(
            "UPDATE jira_observations SET gone = TRUE, gone_reason = 'OUT_OF_SCOPE', gone_probed_at = NULL WHERE binding_id = ?",
            planted.id.toInt(),
        )
        // Only the planted binding is gone on the site's side: the sweep lists the other four.
        val others = f.bound.filter { it != planted }
        val mock = MockJiraRun(application) { request ->
            when {
                request.isIssueRead() -> failure(HttpStatusCode.NotFound)
                request.url.parameters["fields"] == "id" -> jsonOk(idsPage(*others.map { it.issueId }.toTypedArray()))
                else -> jsonOk(searchPage())
            }
        }
        val result = mock.run(f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
        assertEquals(listOf(planted.issueId), mock.requests.filter { it.isIssueRead() }.map { it.issueId() })
        assertEquals(true to "DELETED", reasonOf(planted))
        assertTrue(probed(planted))
    }
}
