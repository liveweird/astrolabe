package ch.nokillswit

import ch.nokillswit.jira.JiraConnectionPageResponse
import ch.nokillswit.jira.JiraConnectionResponse
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A connection's `lastRun` (the list and the single GET) is its OWN newest run with the SERVER's `running` verdict - the same rule as the
 * Deviations view's - so a client never judges a run's age by its own clock. Runs are written straight into `sync_runs` (it has no
 * foreign key): no Jira call is needed to read them back.
 */
class JiraConnectionLastRunTest {
    private val minute = 60_000L

    private suspend fun HttpClient.newConnection(): UInt =
        jbJson.decodeFromString<JiraConnectionResponse>(postJson(JB_CONNECTIONS, jbRequest()).bodyAsText()).id

    private suspend fun HttpClient.single(id: UInt): JiraConnectionResponse =
        jbJson.decodeFromString(get("$JB_CONNECTIONS/$id").bodyAsText())

    private suspend fun HttpClient.listed(id: UInt): JiraConnectionResponse {
        val page = jbJson.decodeFromString<JiraConnectionPageResponse>(get("$JB_CONNECTIONS?sort=-id&pageSize=100").bodyAsText())
        return page.items.single { it.id == id }
    }

    private fun finishedRun(connectionId: UInt, startedAt: Long, outcome: SyncOutcome, errorCode: String? = null) {
        jbSql(
            "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome) " +
                "VALUES ('JIRA', ?, 'MANUAL', ?, ?, ?)",
            connectionId.toInt(), startedAt, startedAt + 5_000, outcome.name,
        )
        if (errorCode != null) {
            jbSql(
                "UPDATE sync_runs SET error_code = ? WHERE connection_id = ? AND started_at = ?",
                errorCode, connectionId.toInt(), startedAt,
            )
        }
    }

    private fun unfinishedRun(connectionId: UInt, startedAt: Long) = jbSql(
        "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at) VALUES ('JIRA', ?, 'MANUAL', ?)",
        connectionId.toInt(), startedAt,
    )

    @Test
    fun `a connection with no runs has a null lastRun, on the single GET and in the list`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("lastrun-none", UserRole.ADMIN)
        val id = admin.newConnection()
        assertNull(admin.single(id).lastRun)
        assertNull(admin.listed(id).lastRun)
    }

    @Test
    fun `lastRun is the connection's own newest run - the other connections' runs never leak in`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("lastrun-scope", UserRole.ADMIN)
        val a = admin.newConnection()
        val b = admin.newConnection()
        val now = System.currentTimeMillis()
        try {
            finishedRun(a, now - 60 * minute, SyncOutcome.SUCCEEDED)
            finishedRun(a, now - 30 * minute, SyncOutcome.FAILED, errorCode = "TIMEOUT")
            // B has the NEWEST run overall and an unfinished one: none of it is A's.
            finishedRun(b, now - minute, SyncOutcome.SUCCEEDED)
            unfinishedRun(b, now - 2_000)
            val lastA = assertNotNull(admin.single(a).lastRun)
            assertEquals(SyncOutcome.FAILED, lastA.outcome)
            assertEquals("TIMEOUT", lastA.errorCode)
            assertFalse(lastA.running)
            assertEquals(lastA, admin.listed(a).lastRun, "the list and the single GET agree")
            val lastB = assertNotNull(admin.single(b).lastRun)
            assertNull(lastB.outcome)
            assertNull(lastB.finishedAt)
            assertTrue(lastB.running)
            assertEquals(lastB, admin.listed(b).lastRun)
        } finally {
            listOf(a, b).forEach { jbSql("DELETE FROM sync_runs WHERE connection_id = ?", it.toInt()) }
        }
    }

    @Test
    fun `running is the server's verdict - true only for an unfinished run inside the claim window`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("lastrun-running", UserRole.ADMIN)
        val fresh = admin.newConnection()
        val stale = admin.newConnection()
        val finished = admin.newConnection()
        val now = System.currentTimeMillis()
        try {
            unfinishedRun(fresh, now - minute)
            // Older than sync.maxRunMinutes (10 in the suite): interrupted, never "running".
            unfinishedRun(stale, now - 11 * minute)
            finishedRun(finished, now - minute, SyncOutcome.SUCCEEDED)
            val freshRun = assertNotNull(admin.single(fresh).lastRun)
            assertTrue(freshRun.running, "unfinished and young")
            val staleRun = assertNotNull(admin.single(stale).lastRun)
            assertNull(staleRun.finishedAt)
            assertFalse(staleRun.running, "unfinished but stale: interrupted")
            assertFalse(assertNotNull(admin.single(finished).lastRun).running, "a finished run is not running")
            assertEquals(
                listOf(true, false, false),
                listOf(fresh, stale, finished).map { assertNotNull(admin.listed(it).lastRun).running },
            )
        } finally {
            listOf(fresh, stale, finished).forEach { jbSql("DELETE FROM sync_runs WHERE connection_id = ?", it.toInt()) }
        }
    }

    @Test
    fun `a missing connection is still 404 - lastRun adds no read before the existence check`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("lastrun-404", UserRole.ADMIN)
        assertEquals(HttpStatusCode.NotFound, admin.get("$JB_CONNECTIONS/987654").status)
    }
}
