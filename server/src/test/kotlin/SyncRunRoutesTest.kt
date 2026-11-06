package ch.nokillswit

import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncRunList
import ch.nokillswit.sync.SyncRunRequest
import ch.nokillswit.sync.SyncRunResponse
import ch.nokillswit.sync.SyncRunnerKey
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
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST/GET /api/v1/integrations/sync/runs`: the guard before the body, the connection check, the claim's 409, abandonment through the
 * route, the 202 and the audit event, and the open read. The runs here have no bindings to read, so they end without a Jira call; the
 * connection itself is made against the stub (the Test connection needs it). Runs are awaited through `SyncRunner.await`.
 */
class SyncRunRoutesTest {
    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
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
            setBody("""{"kind":"FLOW","connectionId":${f.connectionId}}""")
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
        assertEquals(HttpStatusCode.BadRequest, admin.get("$SYNC_RUNS?kind=FLOW").status)
        assertEquals(HttpStatusCode.BadRequest, admin.get("$SYNC_RUNS?connectionId=x").status)
        assertEquals(HttpStatusCode.BadRequest, admin.get("$SYNC_RUNS?connectionId=1&connectionId=2").status)
    }
}
