package ch.nokillswit

import ch.nokillswit.flow.FlowConnectionRequest
import ch.nokillswit.flow.FlowConnectionResponse
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncRunList
import ch.nokillswit.sync.SyncRunRequest
import ch.nokillswit.sync.SyncRunResponse
import ch.nokillswit.sync.SyncRunnerKey
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.BeforeClass
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST/GET /api/v1/integrations/sync/runs`: the guard before the body, the connection check, the claim's 409, abandonment through the
 * route, the 202 and the audit event, and the open read. The runs here have no bindings to read, so they end without a Jira call; the
 * connection itself is made against the stub (the Test connection needs it). Runs are awaited through `SyncRunner.await`. The FLOW cases
 * at the end drive the same routes against the Flow stub: the kind dispatches to the Flow connector, audits `flow.sync_requested`, runs
 * for real and never lets the token reach a log line.
 */
class SyncRunRoutesTest {
    companion object {
        private const val FLOW_PREFIX = "srflow"
        private const val FLOW_CONNECTIONS = "/api/v1/integrations/flow/connections"

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
            FlowStubFixture.warm()
        }
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt)

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
        val w = planWorld(prefix)
        return Fixture(w, w.admin.client.jbConnection(jbRequest()).id)
    }

    private fun unfinishedRun(connectionId: UInt, startedAt: Long) = jbSql(
        "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at) VALUES ('JIRA', ?, 'MANUAL', ?)",
        connectionId.toInt(), startedAt,
    )

    private suspend fun HttpClient.request(connectionId: UInt) = postJson(SYNC_RUNS, SyncRunRequest(SyncKind.JIRA, connectionId))

    private suspend fun HttpClient.runs(connectionId: UInt): List<SyncRunResponse> =
        jbJson.decodeFromString<SyncRunList>(get("$SYNC_RUNS?kind=JIRA&connectionId=$connectionId").bodyAsText()).items

    @Test
    fun `only ADMIN may start a run - the guard comes before the body, and the connection must be runnable`() = testApplication {
        val f = fixture("srguard")
        val malformed = "{"
        for ((who, caller) in f.w.outsiders + listOf("owner" to f.w.projectOwner)) {
            val denied = caller.client.post(SYNC_RUNS) {
                contentType(ContentType.Application.Json)
                setBody(malformed)
            }
            assertEquals(HttpStatusCode.Forbidden, denied.status, "$who: 403 before the body is read")
            assertEquals(HttpStatusCode.Forbidden, caller.client.request(f.connectionId).status, who)
        }
        val admin = f.w.admin.client
        val broken = admin.post(SYNC_RUNS) {
            contentType(ContentType.Application.Json)
            setBody(malformed)
        }
        assertEquals(HttpStatusCode.BadRequest, broken.status)
        val unknownKind = admin.post(SYNC_RUNS) {
            contentType(ContentType.Application.Json)
            setBody("""{"kind":"GITLAB","connectionId":${f.connectionId}}""")
        }
        assertEquals(HttpStatusCode.BadRequest, unknownKind.status)
        assertEquals(HttpStatusCode.BadRequest, admin.request(999_999u).status, "an unknown connection")
        jbSql("UPDATE jira_connections SET enabled = false WHERE id = ?", f.connectionId.toInt())
        assertEquals(HttpStatusCode.BadRequest, admin.request(f.connectionId).status, "a disabled connection")
        jbSql("UPDATE jira_connections SET enabled = true, marked_as_deleted = true WHERE id = ?", f.connectionId.toInt())
        assertEquals(HttpStatusCode.BadRequest, admin.request(f.connectionId).status, "a deleted connection")
        assertTrue(admin.runs(f.connectionId).isEmpty(), "a refused request claims nothing")
    }

    @Test
    fun `a request answers 202 with the claimed run, audits it, and the run ends in the background`() = testApplication {
        val f = fixture("sraccept")
        withAuditCapture { audit ->
            val response = f.w.admin.client.request(f.connectionId)
            assertEquals(HttpStatusCode.Accepted, response.status, response.bodyAsText())
            val accepted = jbJson.decodeFromString<SyncRunResponse>(response.bodyAsText())
            assertNull(accepted.finishedAt)
            assertNull(accepted.outcome)
            assertEquals(f.w.admin.userId, accepted.requestedByUserId)
            assertEquals(f.connectionId, accepted.connectionId)
            val event = assertNotNull(
                audit.awaitEvent { it.message == "jira.sync_requested" && it.hasKeyValue("runId", accepted.id.toLong()) },
            )
            assertTrue(event.hasKeyValue("byUserId", f.w.admin.userId.toLong()))
            assertTrue(event.hasKeyValue("connectionId", f.connectionId.toLong()))
            withTimeout(60_000) { application.attributes[SyncRunnerKey].await(accepted.id) }
            val finished = f.w.admin.client.runs(f.connectionId).single()
            assertEquals(accepted.id, finished.id)
            assertEquals(SyncOutcome.SUCCEEDED, finished.outcome)
            assertTrue(accepted.running, "the 202 row is the claimed run: running")
            assertFalse(finished.running, "a finished run is not running")
            assertEquals(0, finished.callCount, "nothing bound: nothing to ask Jira")
            assertNotNull(finished.finishedAt)
        }
    }

    @Test
    fun `a second request while one is unfinished is 409 run-in-progress, and a stale unfinished run is abandoned by the next claim`() =
        testApplication {
            val f = fixture("srclaim")
            val admin = f.w.admin.client
            unfinishedRun(f.connectionId, System.currentTimeMillis())
            assertTrue(admin.runs(f.connectionId).single().running, "an unfinished run inside the claim window is running")
            withAuditCapture { audit ->
                val refused = admin.request(f.connectionId)
                assertEquals(HttpStatusCode.Conflict, refused.status)
                assertEquals("urn:astrolabe:problem:run-in-progress", refused.jbProblem().type)
                assertEquals(1, admin.runs(f.connectionId).size, "the refused request left nothing behind")
                assertTrue(
                    audit.events.none { it.message == "jira.sync_requested" && it.hasKeyValue("connectionId", f.connectionId.toLong()) },
                    "a refused request is not audited as requested",
                )
            }
            // The same unfinished row, now older than sync.maxRunMinutes (10 by default): the claim abandons it and goes through.
            val old = System.currentTimeMillis() - 11 * 60_000L
            jbSql("UPDATE sync_runs SET started_at = ? WHERE connection_id = ?", old, f.connectionId.toInt())
            val interrupted = admin.runs(f.connectionId).single()
            assertNull(interrupted.finishedAt)
            assertFalse(interrupted.running, "unfinished but older than the claim window: interrupted, not running")
            val accepted = admin.request(f.connectionId)
            assertEquals(HttpStatusCode.Accepted, accepted.status, accepted.bodyAsText())
            val id = jbJson.decodeFromString<SyncRunResponse>(accepted.bodyAsText()).id
            withTimeout(60_000) { application.attributes[SyncRunnerKey].await(id) }
            val rows = admin.runs(f.connectionId)
            assertEquals(listOf(SyncOutcome.SUCCEEDED, SyncOutcome.ABANDONED), rows.map { it.outcome }, "newest first")
            assertEquals("ABANDONED", rows.last().errorCode)
        }

    @Test
    fun `any signed-in user lists the runs, newest first, filtered by kind and connection`() = testApplication {
        val f = fixture("srlist")
        val admin = f.w.admin.client
        val ids = (1..2).map {
            val id = jbJson.decodeFromString<SyncRunResponse>(admin.request(f.connectionId).bodyAsText()).id
            withTimeout(60_000) { application.attributes[SyncRunnerKey].await(id) }
            id
        }
        for ((who, caller) in f.w.outsiders) {
            val response = caller.client.get("$SYNC_RUNS?kind=JIRA&connectionId=${f.connectionId}")
            assertEquals(HttpStatusCode.OK, response.status, who)
            assertEquals(ids.reversed(), jbJson.decodeFromString<SyncRunList>(response.bodyAsText()).items.map { it.id }, who)
        }
        val other = admin.jbConnection().id
        assertEquals(emptyList(), admin.runs(other))
        assertTrue(jbJson.decodeFromString<SyncRunList>(admin.get(SYNC_RUNS).bodyAsText()).items.map { it.id }.containsAll(ids))
        assertEquals(HttpStatusCode.BadRequest, admin.get("$SYNC_RUNS?kind=GITLAB").status)
        assertEquals(HttpStatusCode.BadRequest, admin.get("$SYNC_RUNS?connectionId=x").status)
        assertEquals(HttpStatusCode.BadRequest, admin.get("$SYNC_RUNS?connectionId=1&connectionId=2").status)
    }

    // ---- kind FLOW ----------------------------------------------------------------------------------------------------

    private class FlowFixture(val admin: HttpClient, val adminId: UInt, val connectionId: UInt)

    private suspend fun ApplicationTestBuilder.flowFixture(prefix: String, enabled: Boolean = true): FlowFixture {
        configureApp("flow.insecureOrigins" to FlowStubFixture.warm(), "flow.maxRetries" to "0")
        startApplication()
        val email = uniqueEmail(prefix)
        val adminId = TestUsers.seed(email = email, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(email, "pw")
        val created = admin.postJson(
            FLOW_CONNECTIONS,
            FlowConnectionRequest(flowUnique(FLOW_PREFIX), FlowStubServer.baseUrl, "Europe/Warsaw", FlowStubServer.token, enabled, null),
        )
        assertEquals(HttpStatusCode.Created, created.status, created.bodyAsText())
        return FlowFixture(admin, adminId, jbJson.decodeFromString<FlowConnectionResponse>(created.bodyAsText()).id)
    }

    @AfterTest
    fun removeFlowFixtures() = removeFlowFixtureRows(FLOW_PREFIX)

    private suspend fun HttpClient.flowRequest(connectionId: UInt) = postJson(SYNC_RUNS, SyncRunRequest(SyncKind.FLOW, connectionId))

    @Test
    fun `a FLOW request dispatches to the Flow connector, audits flow sync_requested, runs against the stub and lists under its kind`() =
        testApplication {
            val f = flowFixture("srflow")
            val root = LogCapture("ROOT")
            try {
                withAuditCapture { audit ->
                    val response = f.admin.flowRequest(f.connectionId)
                    assertEquals(HttpStatusCode.Accepted, response.status, response.bodyAsText())
                    val accepted = jbJson.decodeFromString<SyncRunResponse>(response.bodyAsText())
                    assertEquals(SyncKind.FLOW, accepted.kind)
                    val runId = accepted.id.toLong()
                    val event = assertNotNull(audit.awaitEvent { it.message == "flow.sync_requested" && it.hasKeyValue("runId", runId) })
                    assertTrue(event.hasKeyValue("byUserId", f.adminId.toLong()))
                    assertTrue(event.hasKeyValue("connectionId", f.connectionId.toLong()))
                    assertTrue(audit.events.none { it.message == "jira.sync_requested" && it.hasKeyValue("runId", accepted.id.toLong()) })
                    withTimeout(60_000) { application.attributes[SyncRunnerKey].await(accepted.id) }
                }
                val listed = jbJson.decodeFromString<SyncRunList>(
                    f.admin.get("$SYNC_RUNS?kind=FLOW&connectionId=${f.connectionId}").bodyAsText(),
                ).items.single()
                assertEquals(Triple(SyncOutcome.SUCCEEDED, SyncKind.FLOW, 1), Triple(listed.outcome, listed.kind, listed.callCount))
                val teams = FlowStubServer.expected.getValue("totals").jsonObject.getValue("teams").jsonPrimitive.content.toInt()
                assertEquals(teams, listed.observedCount)
                assertTrue(
                    root.events.none { event -> FlowStubServer.token in event.formattedMessage || "flow_int_" in event.formattedMessage },
                    "no log line of the whole request-and-run carries the token",
                )
            } finally {
                root.detach()
            }
        }

    @Test
    fun `a FLOW request is ADMIN only before its body, needs a runnable Flow connection and meets the claim's 409`() = testApplication {
        val f = flowFixture("srflowguard")
        val stranger = seededClient("srflowuser", UserRole.USER)
        assertEquals(HttpStatusCode.Forbidden, stranger.flowRequest(f.connectionId).status)
        assertEquals(HttpStatusCode.BadRequest, f.admin.flowRequest(999_999u).status, "an unknown connection")
        val off = f.admin.postJson(
            FLOW_CONNECTIONS,
            FlowConnectionRequest(flowUnique(FLOW_PREFIX), FlowStubServer.baseUrl, "Europe/Warsaw", FlowStubServer.token, false, null),
        )
        val disabled = jbJson.decodeFromString<FlowConnectionResponse>(off.bodyAsText()).id
        assertEquals(HttpStatusCode.BadRequest, f.admin.flowRequest(disabled).status, "a disabled connection")
        assertTrue(
            jbJson.decodeFromString<SyncRunList>(f.admin.get("$SYNC_RUNS?kind=FLOW&connectionId=$disabled").bodyAsText()).items.isEmpty(),
            "a refused request claims nothing",
        )
        jbSql(
            "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at) VALUES ('FLOW', ?, 'MANUAL', ?)",
            f.connectionId.toInt(), System.currentTimeMillis(),
        )
        val refused = f.admin.flowRequest(f.connectionId)
        assertEquals(HttpStatusCode.Conflict, refused.status)
        assertEquals("urn:astrolabe:problem:run-in-progress", refused.jbProblem().type)
    }
}
