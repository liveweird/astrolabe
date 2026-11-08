package ch.nokillswit

import ch.nokillswit.flow.FlowConnectionPageResponse
import ch.nokillswit.flow.FlowConnectionRequest
import ch.nokillswit.flow.FlowConnectionResponse
import ch.nokillswit.flow.FlowObserverKey
import ch.nokillswit.sync.Connector
import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.SyncConnectors
import ch.nokillswit.sync.SyncRunServiceKey
import ch.nokillswit.sync.SyncScheduler
import ch.nokillswit.sync.SyncTrigger
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncRunRequest
import ch.nokillswit.sync.SyncRunResponse
import ch.nokillswit.sync.SyncRunnerKey
import ch.nokillswit.sync.SyncState
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.AfterClass
import org.junit.BeforeClass
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The `status` and `lastRun` a Flow connection answers (the Jira registry's `JiraConnectionStatusTest`, for Flow): derived per read from
 * the connection row and its own runs, never stored. A real run against the stub takes NEVER_SYNCED to CURRENT, an outage reads FAILED
 * with its code and the doubling wait, a passing test makes the connection due at once and a PUT can disable it.
 */
class FlowConnectionStatusTest {
    private companion object {
        const val PREFIX = "flow-status"
        const val BASE = "/api/v1/integrations/flow/connections"
        const val MINUTE = 60_000L

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            FlowStubFixture.warm()
        }

        @JvmStatic
        @AfterClass
        fun resetStub() {
            FlowStubServer.resetScenarios()
        }
    }

    private val json = Json { ignoreUnknownKeys = true }

    @AfterTest
    fun cleanUp() {
        FlowStubServer.resetScenarios()
        removeFlowFixtureRows(PREFIX)
    }

    private suspend fun ApplicationTestBuilder.admin(): HttpClient {
        configureApp(
            "flow.insecureOrigins" to FlowStubFixture.warm(), "flow.maxRetries" to "0", "security.rateLimit.flowTestPerMinute" to "100",
        )
        startApplication()
        return seededClient("flowstatus", UserRole.ADMIN)
    }

    private suspend fun HttpClient.create(enabled: Boolean = true): FlowConnectionResponse {
        val request = FlowConnectionRequest(flowUnique(PREFIX), FlowStubServer.baseUrl, "Europe/Warsaw", FlowStubServer.token, enabled, 60)
        val response = postJson(BASE, request)
        assertEquals(HttpStatusCode.Created, response.status, response.bodyAsText())
        return json.decodeFromString(response.bodyAsText())
    }

    private suspend fun HttpClient.connection(id: UInt): FlowConnectionResponse = json.decodeFromString(get("$BASE/$id").bodyAsText())

    private suspend fun ApplicationTestBuilder.refresh(admin: HttpClient, id: UInt): SyncRunResponse {
        val accepted = admin.postJson(SYNC_RUNS, SyncRunRequest(SyncKind.FLOW, id))
        assertEquals(HttpStatusCode.Accepted, accepted.status, accepted.bodyAsText())
        val run = json.decodeFromString<SyncRunResponse>(accepted.bodyAsText())
        withTimeout(60_000) { application.attributes[SyncRunnerKey].await(run.id) }
        return run
    }

    @Test
    fun `a new connection reads NEVER_SYNCED with no run, and a passing test makes it due at once`() = testApplication {
        val admin = admin()
        val created = admin.create()
        val fresh = admin.connection(created.id)
        assertEquals(SyncState.NEVER_SYNCED, fresh.status.state)
        assertNull(fresh.lastRun)
        assertNull(fresh.status.lastRun)
        assertNull(fresh.status.nextPollAt, "an untested connection is never polled")
        assertEquals(0, fresh.status.consecutiveFailures)
        assertNull(fresh.teamsAt)

        assertEquals(HttpStatusCode.OK, admin.post("$BASE/${created.id}/test").status)
        val tested = admin.connection(created.id).status
        assertEquals(SyncState.NEVER_SYNCED, tested.state)
        assertTrue(tested.nextPollAt!! <= System.currentTimeMillis(), "a tested connection with no run is due")
    }

    @Test
    fun `a real run reads CURRENT with its lastRun and teamsAt, the list agrees, and a PUT can disable it`() = testApplication {
        val admin = admin()
        val created = admin.create()
        admin.post("$BASE/${created.id}/test")
        val run = refresh(admin, created.id)

        val after = admin.connection(created.id)
        assertEquals(SyncState.CURRENT, after.status.state)
        assertEquals(after.status.lastRun, after.lastRun, "lastRun is the status's own newest run")
        assertEquals(Pair(run.id, SyncOutcome.SUCCEEDED), Pair(after.lastRun!!.id, after.lastRun!!.outcome))
        assertEquals(false, after.lastRun!!.running)
        assertEquals(after.lastRun!!.startedAt, after.status.lastSucceededAt)
        assertNotNull(after.teamsAt)
        val finished = after.lastRun!!.finishedAt!!
        val nextPollAt = after.status.nextPollAt!!
        assertTrue(nextPollAt in finished + 60 * MINUTE..finished + 61 * MINUTE, "one interval after the finish: no failure, no jitter")

        val page = json.decodeFromString<FlowConnectionPageResponse>(admin.get("$BASE?pageSize=100").bodyAsText())
        assertEquals(after.status, page.items.single { it.id == created.id }.status)

        val put = admin.put("$BASE/${created.id}") {
            contentType(ContentType.Application.Json)
            val replace = FlowConnectionRequest(
                created.name, created.baseUrl, created.timeZone, apiToken = null, enabled = false, pollIntervalMinutes = 60,
            )
            setBody(json.encodeToString(FlowConnectionRequest.serializer(), replace))
        }
        assertEquals(HttpStatusCode.NoContent, put.status)
        val disabled = admin.connection(created.id).status
        assertEquals(SyncState.DISABLED, disabled.state)
        assertNull(disabled.nextPollAt)
    }

    @Test
    fun `an outage reads FAILED with its code and the wait, and a passing test afterwards makes it due at once`() = testApplication {
        val admin = admin()
        val created = admin.create()
        admin.post("$BASE/${created.id}/test")
        val scenarios = FlowStubServer.expected.getValue("scenarios").jsonObject
        val (outage, down) = scenarios.getValue("outage").jsonPrimitive.content to scenarios.getValue("outageState").jsonPrimitive.content
        FlowStubServer.setScenarioState(outage, down)
        // The test above passed while the stub was up; the outage now fails the run, not the recorded test.
        refresh(admin, created.id)

        val failed = admin.connection(created.id)
        assertEquals(SyncState.FAILED, failed.status.state)
        assertEquals("UPSTREAM_UNAVAILABLE", failed.lastRun!!.errorCode)
        assertEquals(1, failed.status.consecutiveFailures)
        val finished = failed.lastRun!!.finishedAt!!
        assertTrue(failed.status.nextPollAt!! - finished in 60 * MINUTE..90 * MINUTE, "one interval plus the jitter")
        assertNull(failed.teamsAt, "nothing was ever mirrored")

        FlowStubServer.resetScenarios()
        assertEquals(HttpStatusCode.OK, admin.post("$BASE/${created.id}/test").status)
        val retested = admin.connection(created.id).status
        assertEquals(SyncState.FAILED, retested.state, "the streak stands until a run succeeds")
        assertTrue(retested.nextPollAt!! <= System.currentTimeMillis(), "a fresh passing test overrides the back-off")
        refresh(admin, created.id)
        assertEquals(SyncState.CURRENT, admin.connection(created.id).status.state)
    }

    // ---- ready is sticky ----------------------------------------------------------------------------------------------

    /**
     * One hand-driven scheduler tick over the app's REAL Flow connector, restricted to connection [id] (the shared database holds other
     * tests' connections): answers the runs of [id], newest first, once the ones the tick started have ended.
     */
    private suspend fun ApplicationTestBuilder.tick(id: UInt): List<SyncRunResponse> {
        val real = application.attributes[FlowObserverKey]
        val only = object : Connector by real {
            override suspend fun connections(): List<ConnectorConnection> = real.connections().filter { it.id == id }

            override suspend fun connections(queryTimeoutSeconds: Int): List<ConnectorConnection> = connections()
        }
        val runs = application.attributes[SyncRunServiceKey]
        val runner = application.attributes[SyncRunnerKey]
        SyncScheduler(runs, runner, SyncConnectors().also { it.register(only) }, tickMillis = 60_000, firstTickDelayMillis = 0).tick()
        runs.list(SyncKind.FLOW, id).forEach { withTimeout(60_000) { runner.await(it.id) } }
        return runs.list(SyncKind.FLOW, id)
    }

    private suspend fun HttpClient.replace(created: FlowConnectionResponse, token: String?, zone: String = created.timeZone) {
        val put = put("$BASE/${created.id}") {
            contentType(ContentType.Application.Json)
            val request = FlowConnectionRequest(created.name, created.baseUrl, zone, token, enabled = true, pollIntervalMinutes = 60)
            setBody(json.encodeToString(FlowConnectionRequest.serializer(), request))
        }
        assertEquals(HttpStatusCode.NoContent, put.status)
    }

    /** A connection that has been tested and has run once (CURRENT). */
    private suspend fun ApplicationTestBuilder.current(admin: HttpClient): FlowConnectionResponse {
        val created = admin.create()
        admin.post("$BASE/${created.id}/test")
        refresh(admin, created.id)
        assertEquals(SyncState.CURRENT, admin.connection(created.id).status.state)
        return created
    }

    @Test
    fun `a rotated token keeps a connection that has run pollable and due at once, though the PUT cleared the test verdict`() =
        testApplication {
            val admin = admin()
            val created = current(admin)

            admin.replace(created, token = FlowStubServer.token)

            val after = admin.connection(created.id)
            assertNull(after.lastTestOk, "the PUT cleared the verdict of the test that judged the old token")
            assertTrue(after.status.nextPollAt!! <= System.currentTimeMillis(), "due at once")
            val runs = tick(created.id)
            assertEquals(2, runs.size, "the scheduler claimed it")
            assertEquals(Pair(SyncTrigger.SCHEDULED, SyncOutcome.SUCCEEDED), Pair(runs.first().trigger, runs.first().outcome))
        }

    @Test
    fun `a zone-only PUT does not stop the polling of a connection that has run`() = testApplication {
        val admin = admin()
        val created = current(admin)

        admin.replace(created, token = null, zone = "Pacific/Auckland")

        assertNull(admin.connection(created.id).lastTestOk)
        assertTrue(admin.connection(created.id).status.nextPollAt!! <= System.currentTimeMillis())
        val runs = tick(created.id)
        assertEquals(Pair(2, SyncTrigger.SCHEDULED), Pair(runs.size, runs.first().trigger))
    }

    @Test
    fun `a failed Test that hit a Flow outage leaves a connection that has run in the polling`() = testApplication {
        val admin = admin()
        val created = current(admin)
        val scenarios = FlowStubServer.expected.getValue("scenarios").jsonObject
        FlowStubServer.setScenarioState(
            scenarios.getValue("outage").jsonPrimitive.content, scenarios.getValue("outageState").jsonPrimitive.content,
        )
        assertEquals(HttpStatusCode.OK, admin.post("$BASE/${created.id}/test").status)
        FlowStubServer.resetScenarios()

        assertEquals(false, admin.connection(created.id).lastTestOk, "the failed test is recorded")
        val runs = tick(created.id)
        assertEquals(2, runs.size, "still polled: a run has mirrored a document")
        assertEquals(SyncOutcome.SUCCEEDED, runs.first().outcome)
    }

    @Test
    fun `a connection never tested and never run is not polled`() = testApplication {
        val admin = admin()
        val created = admin.create()
        assertEquals(emptyList(), tick(created.id))
        assertNull(admin.connection(created.id).status.nextPollAt)
        // A failed first test does not make it pollable either: nothing has ever answered.
        FlowStubServer.setScenarioState(
            FlowStubServer.expected.getValue("scenarios").jsonObject.getValue("outage").jsonPrimitive.content, "down",
        )
        admin.post("$BASE/${created.id}/test")
        FlowStubServer.resetScenarios()
        assertEquals(emptyList(), tick(created.id))
    }
}
