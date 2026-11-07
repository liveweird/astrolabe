package ch.nokillswit

import ch.nokillswit.jira.DeviationKind
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncRunList
import ch.nokillswit.sync.SyncRunRequest
import ch.nokillswit.sync.SyncRunResponse
import ch.nokillswit.sync.SyncRunnerKey
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.AfterClass
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * An acknowledgement across a REAL run over the stub: `jira-day2` makes `E2E-6` vanish from the scope, the sweep flags the bound issue
 * `gone`, and the acknowledged item - whose Jira side changed - reads `current = false` with its old stamp and is open again. Like
 * `JiraRunTest` this flips the process-wide scenario, so it resets ALL scenarios in a `finally` and once more in `@AfterClass`.
 */
class JiraAcknowledgeRunTest {
    companion object {
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

    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    private suspend fun ApplicationTestBuilder.runAndAwait(client: HttpClient, connectionId: UInt): SyncRunResponse {
        val accepted = client.postJson(SYNC_RUNS, SyncRunRequest(SyncKind.JIRA, connectionId))
        assertEquals(HttpStatusCode.Accepted, accepted.status, accepted.bodyAsText())
        val started = jbJson.decodeFromString<SyncRunResponse>(accepted.bodyAsText())
        withTimeout(120_000) { application.attributes[SyncRunnerKey].await(started.id) }
        val listed = jbJson.decodeFromString<SyncRunList>(client.get("$SYNC_RUNS?kind=JIRA&connectionId=$connectionId").bodyAsText())
        return listed.items.single { it.id == started.id }
    }

    @Test
    fun `a run that changes the observation reopens an acknowledged item with its old stamp, and a new acknowledgement closes it again`() =
        testApplication {
            configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
            startApplication()
            val w = planWorld("ackrun", teams = true)
            val admin = w.admin.client
            val connection = ledger.track(admin.jbConnection().id)
            val milestone = TestPlan.milestone(w.projectId, w.requireTeams().teamId, planName("ms"))
            val binding = w.projectOwner.client.jbBind(connection, JiraLevel.MILESTONE, milestone, "E2E-6").jbBinding().id
            val first = admin.ackItem(connection, binding)
            assertTrue(first.deviations.isNotEmpty(), "the milestone's name is not the issue's summary")
            val given = w.projectOwner.client.ack(binding, first.fingerprint).acknowledgement()
            assertTrue(admin.dvView("connectionId=$connection").items.isEmpty(), "acknowledged: not open")
            try {
                JiraStubServer.setScenarioState("jira-day2", "day2")
                val run = runAndAwait(admin, connection)
                assertEquals(SyncOutcome.SUCCEEDED, run.outcome, run.errorDetail)
                val reopened = admin.dvView("connectionId=$connection").items.single()
                assertEquals(binding, reopened.bindingId)
                assertEquals(listOf(DeviationKind.GONE), reopened.deviations.map { it.kind }, "a gone issue raises GONE alone")
                assertFalse(reopened.fingerprint == first.fingerprint)
                val stamp = assertNotNull(reopened.acknowledgement)
                assertEquals(listOf(given.acknowledgedAt, given.acknowledgedBy, false), listOf(stamp.at, stamp.by, stamp.current))
                assertEquals(1, admin.dvView("connectionId=$connection").totals.gone, "an open gone issue counts")

                w.projectOwner.client.ack(binding, reopened.fingerprint).acknowledgement()
                val closed = admin.dvView("connectionId=$connection")
                assertTrue(closed.items.isEmpty())
                assertEquals(0, closed.totals.gone, "an acknowledged gone issue is not counted open")
                assertEquals(1, closed.totals.acknowledged)

                JiraStubServer.resetScenarios()
                assertEquals(SyncOutcome.SUCCEEDED, runAndAwait(admin, connection).outcome)
                val back = admin.ackItem(connection, binding)
                assertFalse(assertNotNull(back.acknowledgement).current, "the issue is back: the list changed again")
                assertFalse(back.jira.gone)
            } finally {
                JiraStubServer.resetScenarios()
            }
        }
}
