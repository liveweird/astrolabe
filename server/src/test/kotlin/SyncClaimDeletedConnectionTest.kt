package ch.nokillswit

import ch.nokillswit.flow.FlowConnectionRequest
import ch.nokillswit.flow.FlowConnectionResponse
import ch.nokillswit.flow.FlowConnectionServiceKey
import ch.nokillswit.flow.FlowObserverKey
import ch.nokillswit.jira.JiraConnectionServiceKey
import ch.nokillswit.jira.JiraObserverKey
import ch.nokillswit.sync.SyncCounts
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunServiceKey
import ch.nokillswit.sync.SyncTrigger
import ch.nokillswit.users.UserRole
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import org.junit.BeforeClass
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * The claim's connection lock through the REAL connectors (`SyncClaimDeleteRaceTest` drives the lock itself): a claim made through the
 * app's `JiraObserver` / `FlowObserver` for a connection that was soft-deleted through its own service (the state a delete that commits
 * between the route's `requireRunnable` and the claim leaves) is a `400`, and no `sync_runs` row exists for it. A live connection of
 * each kind still claims, as the control.
 */
class SyncClaimDeletedConnectionTest {
    private companion object {
        const val PREFIX = "sync-claimdel"
        const val FLOW_CONNECTIONS = "/api/v1/integrations/flow/connections"

        @JvmStatic
        @BeforeClass
        fun warmStubs() {
            JiraStubFixture.warm()
            FlowStubFixture.warm()
        }
    }

    private val json = Json { ignoreUnknownKeys = true }

    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
    }

    private fun runCount(kind: String, id: UInt): Int =
        jbScalar("SELECT count(*) FROM sync_runs WHERE kind = ? AND connection_id = ?", kind, id.toInt()) { it.getInt(1) }

    @Test
    fun `a Jira claim for a connection deleted through its service is a 400 and leaves no run`() = testApplication {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
        val admin = seededClient("sclaimjira", UserRole.ADMIN)
        val id = admin.jbConnection().id
        val runs = application.attributes[SyncRunServiceKey]
        val observer = application.attributes[JiraObserverKey]

        val live = runs.claim(observer, id, SyncTrigger.MANUAL, null)
        assertTrue(runs.finish(live.id, SyncResult.succeeded(SyncCounts())))
        assertEquals(1, runCount("JIRA", id))

        assertEquals(1, application.attributes[JiraConnectionServiceKey].delete(id).affected)
        assertEquals(0, runCount("JIRA", id), "the delete purged the connection's runs")
        assertFailsWith<BadRequestException> { runs.claim(observer, id, SyncTrigger.SCHEDULED, null) }
        assertEquals(0, runCount("JIRA", id), "the refused claim left no orphan")
    }

    @Test
    fun `a Flow claim for a connection deleted through its service is a 400 and leaves no run`() = testApplication {
        configureApp(
            "flow.insecureOrigins" to FlowStubFixture.warm(), "flow.maxRetries" to "0", "security.rateLimit.flowTestPerMinute" to "100",
        )
        startApplication()
        val admin = seededClient("sclaimflow", UserRole.ADMIN)
        val request = FlowConnectionRequest(flowUnique(PREFIX), FlowStubServer.baseUrl, "Europe/Warsaw", FlowStubServer.token, true, 60)
        val created = admin.postJson(FLOW_CONNECTIONS, request)
        assertEquals(HttpStatusCode.Created, created.status, created.bodyAsText())
        val id = json.decodeFromString<FlowConnectionResponse>(created.bodyAsText()).id
        val runs = application.attributes[SyncRunServiceKey]
        val observer = application.attributes[FlowObserverKey]

        val live = runs.claim(observer, id, SyncTrigger.MANUAL, null)
        assertTrue(runs.finish(live.id, SyncResult.succeeded(SyncCounts())))
        assertEquals(1, runCount("FLOW", id))

        assertEquals(1, application.attributes[FlowConnectionServiceKey].delete(id).affected)
        assertEquals(0, runCount("FLOW", id), "the delete purged the connection's runs")
        assertFailsWith<BadRequestException> { runs.claim(observer, id, SyncTrigger.SCHEDULED, null) }
        assertEquals(0, runCount("FLOW", id), "the refused claim left no orphan")
    }
}
