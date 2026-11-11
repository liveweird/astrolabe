package ch.nokillswit

import ch.nokillswit.infra.db.R2dbcDatabaseKey
import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraRunStore
import ch.nokillswit.sync.SyncOutcome
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
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

    private fun keyOf(binding: JiraBindingResponse): String? =
        jbScalar("SELECT gone_probed_key FROM jira_observations WHERE binding_id = ?", binding.id.toInt()) { it.getString(1) }

    private fun bindingKeyOf(binding: JiraBindingResponse): String =
        jbScalar("SELECT jira_issue_key FROM jira_bindings WHERE id = ?", binding.id.toInt()) { it.getString(1) }

    /** The binding as the API answers it now: the key, the browse URL and the derived gone reason. */
    private suspend fun apiRow(f: Fixture, binding: JiraBindingResponse): Triple<String, String, String?> {
        val row = jbJson.decodeFromString<JiraBindingResponse>(f.w.admin.client.get("$JB_BINDINGS/${binding.id}").bodyAsText())
        return Triple(row.issueKey, row.url, assertNotNull(row.observation).goneReason)
    }

    @Test
    fun `a 200 keeps the key it carries and the binding follows it, a foreign document keeps none`() = testApplication {
        val f = fixture("jrpkey")
        val moved = f.bound[0]
        val listed = f.bound[1]
        val otherId = f.bound[2]
        val malformed = f.bound[3]
        val deleted = f.bound[4]
        val bodies = mapOf(
            moved.issueId to """{"id":"${moved.issueId}","key":"OUT-7"}""",
            listed.issueId to """{"id":"${listed.issueId}","key":"E2E-90"}""",
            otherId.issueId to """{"id":"999999","key":"OUT-8"}""",
            malformed.issueId to """{"id":"${malformed.issueId}","key":"out-1; DROP"}""",
        )
        val mock = MockJiraRun(application) { request ->
            when {
                request.isIssueRead() ->
                    bodies[request.issueId()]?.let { jsonOk(it) } ?: failure(HttpStatusCode.NotFound)
                request.url.parameters["fields"] == "id" -> jsonOk(idsPage())
                else -> jsonOk(searchPage())
            }
        }
        val result = mock.run(f.connectionId)
        assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
        assertEquals(listOf("OUT-7", "E2E-90", null, null, null), f.bound.map { keyOf(it) })
        assertTrue(f.bound.all { probed(it) }, "a 200 without a usable key is still an answer")
        assertEquals(
            listOf("OUT-7", "E2E-90", "E2E-6", "E2E-7", "E2E-8"), f.bound.map { bindingKeyOf(it) }, "only a kept key moves the binding",
        )
        val (key, url, reason) = apiRow(f, moved)
        assertEquals("OUT-7", key)
        assertTrue(url.endsWith("/browse/OUT-7"), "the link follows the key")
        assertEquals("MOVED_OUT", reason, "outside the connection's keys")
        assertEquals("NOT_LISTED", apiRow(f, listed).third, "inside them")
        assertEquals("MOVED_OUT", apiRow(f, otherId).third, "no key: 1.12's inference")
        assertEquals("MOVED_OUT", apiRow(f, malformed).third)
        assertEquals("DELETED", apiRow(f, deleted).third)

        // The sweep lists everything again: every flag is cleared and so is the key; the binding keeps the key it followed.
        val relist = MockJiraRun(application) { request ->
            if (request.url.parameters["fields"] == "id") {
                jsonOk(idsPage(*f.bound.map { it.issueId }.toTypedArray()))
            } else {
                jsonOk(searchPage())
            }
        }
        assertEquals(SyncOutcome.SUCCEEDED, relist.run(f.connectionId).outcome)
        assertEquals(List(5) { false }, f.bound.map { reasonOf(it).first })
        assertEquals(List(5) { null }, f.bound.map { keyOf(it) })
        assertEquals("OUT-7", bindingKeyOf(moved))
    }

    @Test
    fun `a later verdict clears the key a former 200 kept, and an answer for a binding that is no longer gone writes nothing`() =
        testApplication {
            val f = fixture("jrpclear")
            val (first, second) = f.bound
            val mock = MockJiraRun(application) { request ->
                when {
                    request.isIssueRead() -> jsonOk("""{"id":"${request.issueId()}","key":"OUT-${request.issueId().takeLast(3)}"}""")
                    request.url.parameters["fields"] == "id" -> jsonOk(idsPage())
                    else -> jsonOk(searchPage())
                }
            }
            assertEquals(SyncOutcome.SUCCEEDED, mock.run(f.connectionId).outcome)
            assertNotNull(keyOf(first))
            val store = JiraRunStore(application.attributes[R2dbcDatabaseKey])
            runBlocking { store.recordProbe(first.id, "DELETED", null, 42) }
            assertNull(keyOf(first), "a 404 or 403 clears the key")
            assertEquals(true to "DELETED", reasonOf(first))
            jbSql(
                "UPDATE jira_observations SET gone = FALSE, gone_reason = NULL, gone_probed_at = NULL, gone_probed_key = NULL " +
                    "WHERE binding_id = ?",
                second.id.toInt(),
            )
            val keyBefore = bindingKeyOf(second)
            runBlocking { store.recordProbe(second.id, null, "OUT-1", 43) }
            assertNull(keyOf(second), "a binding that is not gone keeps no key")
            assertEquals(keyBefore, bindingKeyOf(second), "and its key does not follow an answer that was not recorded")
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
        assertEquals(List(5) { null }, f.bound.map { keyOf(it) }, "the 200's {id 1, key X-1} is no key")
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
