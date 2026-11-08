package ch.nokillswit

import ch.nokillswit.flow.FLOW_SPRINT_CAP
import ch.nokillswit.flow.FLOW_TEAM_CAP
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.sync.RunnableState
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncRunResponse
import ch.nokillswit.sync.SyncState
import ch.qos.logback.classic.spi.ThrowableProxyUtil
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.plugins.BadRequestException
import kotlinx.coroutines.runBlocking
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private typealias Reply = suspend MockRequestHandleScope.() -> HttpResponseData

/**
 * `FlowObserver` (the Flow run) over a scripted Ktor `MockEngine` and the real services - no network, no application: the exact request,
 * every failure code and what each leaves in the mirror, a connection disabled or deleted mid-run, the two truncation flags and no token
 * anywhere. The stub-backed run is `FlowRunTest`; the routes and the registry are `SyncRunRoutesTest` / `FlowConnectionStatusTest`.
 */
class FlowRunWireTest {
    private companion object {
        const val PREFIX = "flow-wire"
        const val ORIGIN = "https://flow.wire.test"
        const val MINUTE = 60_000L
        val TEAMS_PATH = "$ORIGIN/api/v1/integration/teams"
        const val UNKNOWN_ID = 999_999_999u
    }

    private val answer = AtomicReference<Reply> { flowOk(flowDocument(flowTeamJson(1), flowTeamJson(2, sprints = 2, members = 3))) }
    private val duringCall = AtomicReference<suspend () -> Unit> {}
    private val openTransactions = mutableListOf<Int>()
    private val flow = MockFlow {
        openTransactions += jbScalar(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'",
        ) { rs -> rs.getInt(1) }
        duringCall.get()()
        answer.get().invoke(this)
    }
    private val harness = flow.harness()

    @AfterTest
    fun cleanUp() {
        harness.cleanUp(PREFIX)
        // The run row of a connection that never was.
        jbSql("DELETE FROM sync_runs WHERE kind = 'FLOW' AND connection_id = ?", UNKNOWN_ID.toInt())
    }

    private fun script(response: Reply) = answer.set(response)

    private suspend fun connect(token: String = flowToken(), timeZone: String = "Europe/Warsaw") =
        harness.connect(PREFIX, ORIGIN, token, timeZone)

    /** A failed run's row says what failed and nothing else: no token, no URL, no query. */
    private fun assertClean(row: SyncRunResponse, token: String) {
        val text = "${row.errorCode} ${row.errorDetail}"
        assertFalse(token in text || "http" in text || "sprintsSince" in text || "flow_int_" in text, text)
    }

    @Test
    fun `a run makes one GET with the bearer token and sprintsSince in the connection's zone, outside any transaction`() =
        runBlocking {
            val token = flowToken('w')
            // 22:30 UTC on 8 November is still the 8th in Warsaw and already the 9th in Auckland: the zone decides the date.
            val at = Instant.parse("2026-11-08T22:30:00Z").toEpochMilli()
            val timed = MockFlow { flowOk(flowDocument(flowTeamJson(1))) }
            val timedHarness = timed.harness({ at }, sprintsSinceDays = 365)
            val warsaw = timedHarness.connect(PREFIX, ORIGIN, token, "Europe/Warsaw")
            val auckland = timedHarness.connect(PREFIX, ORIGIN, token, "Pacific/Auckland")

            val first = timedHarness.run(warsaw)
            val second = timedHarness.run(auckland)

            assertEquals(SyncOutcome.SUCCEEDED, first.outcome)
            assertEquals(SyncOutcome.SUCCEEDED, second.outcome)
            val urls = timed.requests.map { it.url.toString() }
            assertEquals(listOf("$TEAMS_PATH?sprintsSince=2025-11-08", "$TEAMS_PATH?sprintsSince=2025-11-09"), urls)
            timed.requests.forEach {
                assertEquals(HttpMethod.Get, it.method)
                assertEquals(listOf("Bearer $token"), it.headers.getAll(HttpHeaders.Authorization))
            }
            assertEquals(1, first.counts.calls)

            val id = connect()
            harness.run(id)
            assertEquals(listOf(0), openTransactions.distinct(), "no database transaction is open while Flow is called")
        }

    @Test
    fun `a run replaces the mirror with the document and stamps teamsAt, counting teams observed and bound teams gone`() = runBlocking {
        val id = connect()
        harness.bind(PREFIX, id, 2)
        harness.bind(PREFIX, id, 77) // a Flow team the document never carries
        val result = harness.run(id)

        assertEquals(SyncOutcome.SUCCEEDED, result.outcome)
        assertEquals(Triple(2, 1, 1), Triple(result.counts.observed, result.counts.gone, result.counts.calls))
        val teams = harness.mirror.teamsOf(id)
        assertEquals(listOf(1 to 1, 2 to 3), teams.map { it.flowTeamId to it.memberCount }.sortedBy { it.first })
        assertEquals(listOf(1, 2), teams.sortedBy { it.flowTeamId }.map { it.sprintCount })
        assertNotNull(harness.connections.read(id)!!.teamsAt)
        assertEquals(SyncState.CURRENT, harness.connections.read(id)!!.status.state)
        val row = harness.lastRun(id)
        assertEquals(Triple(2, 1, 1), Triple(row.observedCount, row.goneCount, row.callCount))
    }

    @Test
    fun `a 401 is FAILED AUTHENTICATION_FAILED, the mirror keeps its last document and the row carries no token or URL`() = runBlocking {
        val token = flowToken('r')
        val id = connect(token)
        assertEquals(SyncOutcome.SUCCEEDED, harness.run(id).outcome)
        val before = harness.connections.read(id)!!.teamsAt
        script { flowFailure(HttpStatusCode.Unauthorized) }

        val result = harness.run(id)

        assertEquals(Pair(SyncOutcome.FAILED, "AUTHENTICATION_FAILED"), Pair(result.outcome, result.errorCode))
        assertEquals(1, result.counts.calls)
        assertClean(harness.lastRun(id), token)
        assertEquals(2, harness.mirror.teamsOf(id).size, "the mirror keeps its last document")
        assertEquals(before, harness.connections.read(id)!!.teamsAt)
        val status = harness.connections.read(id)!!.status
        assertEquals(SyncState.FAILED, status.state)
        assertEquals("AUTHENTICATION_FAILED", status.lastRun!!.errorCode)
    }

    @Test
    fun `an outage backs off, doubling per failure with the deterministic jitter, and a recovery resets it`() = runBlocking {
        val id = connect()
        script { flowFailure(HttpStatusCode.InternalServerError) }

        assertEquals("UPSTREAM_UNAVAILABLE", harness.run(id).errorCode)
        val first = harness.connections.read(id)!!.status
        val firstFinish = first.lastRun!!.finishedAt!!
        // One interval (60 min) after the finish, plus up to half an interval of jitter.
        assertTrue(first.nextPollAt!! - firstFinish in 60 * MINUTE..90 * MINUTE, "${first.nextPollAt!! - firstFinish}")
        assertEquals(1, first.consecutiveFailures)

        assertEquals("UPSTREAM_UNAVAILABLE", harness.run(id).errorCode)
        val second = harness.connections.read(id)!!.status
        assertTrue(second.nextPollAt!! - second.lastRun!!.finishedAt!! in 120 * MINUTE..150 * MINUTE, "doubled")
        assertEquals(2, second.consecutiveFailures)
        assertEquals(0, harness.mirror.teamsOf(id).size, "no document was ever stored: nothing to keep")

        script { flowOk(flowDocument(flowTeamJson(1))) }
        assertEquals(SyncOutcome.SUCCEEDED, harness.run(id).outcome)
        val healed = harness.connections.read(id)!!.status
        assertEquals(SyncState.CURRENT, healed.state)
        assertEquals(0, healed.consecutiveFailures)
    }

    @Test
    fun `a 429 is RATE_LIMITED and a body that is not the contract is INVALID_RESPONSE, both leaving the mirror alone`() = runBlocking {
        val id = connect()
        assertEquals(SyncOutcome.SUCCEEDED, harness.run(id).outcome)
        script { flowFailure(HttpStatusCode.TooManyRequests) }
        assertEquals("RATE_LIMITED", harness.run(id).errorCode)
        script { flowOk("""{"asOf":1,"sprintsSince":"2025-11-08","teamsTruncated":false,"sprintsTruncated":false}""") } // no items
        val invalid = harness.run(id)
        assertEquals("INVALID_RESPONSE", invalid.errorCode)
        assertClean(harness.lastRun(id), flowToken())
        assertEquals(2, harness.mirror.teamsOf(id).size)
    }

    @Test
    fun `a connection disabled while Flow is being called ends CONNECTION_DISABLED and writes nothing`() = runBlocking {
        val id = connect()
        assertEquals(SyncOutcome.SUCCEEDED, harness.run(id).outcome)
        val before = harness.connections.read(id)!!.teamsAt
        script { flowOk(flowDocument(flowTeamJson(9))) }
        duringCall.set { jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", id.toInt()) }

        val result = harness.run(id)

        assertEquals(Pair(SyncOutcome.FAILED, "CONNECTION_DISABLED"), Pair(result.outcome, result.errorCode))
        val mirrored = harness.mirror.teamsOf(id).map { it.flowTeamId }.toSet()
        assertEquals(setOf(1, 2), mirrored, "the document of the disabled run was not written")
        assertEquals(before, harness.connections.read(id)!!.teamsAt)
        assertEquals(RunnableState.DISABLED, harness.connections.runnableState(id))
    }

    @Test
    fun `a connection deleted while Flow is being called ends CONNECTION_GONE and leaves no mirror row and no token`() = runBlocking {
        val id = connect()
        duringCall.set { harness.connections.delete(id) }

        val result = harness.run(id)

        assertEquals(Pair(SyncOutcome.FAILED, "CONNECTION_GONE"), Pair(result.outcome, result.errorCode))
        for (table in listOf("flow_teams", "flow_sprints", "flow_members")) {
            assertEquals(0L, jbScalar("SELECT count(*) FROM $table WHERE connection_id = ?", id.toInt()) { it.getLong(1) }, table)
        }
        assertNull(flowStoredToken(id), "the deleted connection's token is destroyed")
        assertEquals(RunnableState.GONE, harness.connections.runnableState(id))
    }

    @Test
    fun `a gone or disabled connection, an unreadable token or an unknown zone fails typed without calling Flow`() = runBlocking {
        val unreadable = connect()
        val foreign = FieldCipher(strongEncryptionKey()).encrypt("other")
        jbSql("UPDATE flow_connections SET api_token = ? WHERE id = ?", foreign, unreadable.toInt())
        val badZone = connect()
        jbSql("UPDATE flow_connections SET time_zone = 'Mars/Base' WHERE id = ?", badZone.toInt())
        val off = harness.connect(PREFIX, ORIGIN, enabled = false)

        assertEquals("TOKEN_UNREADABLE", harness.run(unreadable).errorCode)
        assertEquals("TIME_ZONE_INVALID", harness.run(badZone).errorCode)
        assertEquals("CONNECTION_DISABLED", harness.run(off).errorCode)
        assertEquals("CONNECTION_GONE", harness.run(UNKNOWN_ID).errorCode)
        assertTrue(flow.requests.isEmpty(), "none of them reached Flow")
        assertFailsWith<BadRequestException> { harness.observer.requireRunnable(off) }
        assertFailsWith<BadRequestException> { harness.observer.requireRunnable(UNKNOWN_ID) }
        harness.observer.requireRunnable(unreadable)
    }

    @Test
    fun `sprintsTruncated keeps the document and warns once with counts only`() = runBlocking {
        val id = connect()
        script { flowOk(flowDocument(flowTeamJson(1), sprintsTruncated = true)) }
        val capture = LogCapture("ch.nokillswit.sync")
        try {
            val result = harness.run(id)
            assertEquals(SyncOutcome.SUCCEEDED, result.outcome)
            val warnings = capture.events.filter { it.level == ch.qos.logback.classic.Level.WARN }
            assertEquals(1, warnings.size)
            assertTrue("truncated at $FLOW_SPRINT_CAP sprints" in warnings.single().formattedMessage, warnings.single().formattedMessage)
            assertFalse(ORIGIN in warnings.single().formattedMessage)
            assertEquals(1, harness.mirror.teamsOf(id).size, "the document Flow sent is kept")
        } finally {
            capture.detach()
        }
    }

    @Test
    fun `a truncated teams document keeps the teams already mirrored and never counts a bound team gone`() = runBlocking {
        val id = connect()
        harness.bind(PREFIX, id, 2)
        harness.bind(PREFIX, id, 3)
        script { flowOk(flowDocument(flowTeamJson(1), flowTeamJson(2), flowTeamJson(3))) }
        assertEquals(0, harness.run(id).counts.gone)

        // Flow cut its answer at the team cap: only team 1 arrived (now with two sprints); teams 2 and 3 still exist.
        script { flowOk(flowDocument(flowTeamJson(1, sprints = 2), teamsTruncated = true)) }
        val capture = LogCapture("ch.nokillswit.sync")
        val truncated = try {
            harness.run(id).also {
                val warning = capture.events.single { e -> e.level == ch.qos.logback.classic.Level.WARN }.formattedMessage
                assertTrue("truncated at $FLOW_TEAM_CAP teams" in warning, warning)
            }
        } finally {
            capture.detach()
        }
        assertEquals(SyncOutcome.SUCCEEDED, truncated.outcome)
        assertEquals(Pair(1, 0), Pair(truncated.counts.observed, truncated.counts.gone))
        val kept = harness.mirror.teamsOf(id).associateBy { it.flowTeamId }
        assertEquals(setOf(1, 2, 3), kept.keys, "the teams the truncated document omitted stay in the mirror")
        assertEquals(2, kept.getValue(1).sprintCount, "the team it did carry is replaced")
        assertEquals(1, kept.getValue(2).sprintCount)
        assertEquals(1, kept.getValue(3).memberCount)

        // The next complete document is authoritative: the omitted teams are gone for real.
        script { flowOk(flowDocument(flowTeamJson(1))) }
        val complete = harness.run(id)
        assertEquals(Pair(1, 2), Pair(complete.counts.observed, complete.counts.gone))
        assertEquals(setOf(1), harness.mirror.teamsOf(id).map { it.flowTeamId }.toSet())
    }

    @Test
    fun `no log line, run row or exception text of any failing run carries the token`() = runBlocking {
        val token = flowToken('z')
        val id = connect(token)
        val root = LogCapture("ROOT")
        try {
            for (status in listOf(HttpStatusCode.Unauthorized, HttpStatusCode.InternalServerError, HttpStatusCode.TooManyRequests)) {
                script { flowFailure(status) }
                harness.run(id)
                assertClean(harness.lastRun(id), token)
            }
            val rendered = root.events.map {
                it.formattedMessage + it.keyValuePairs.orEmpty().joinToString { kv -> "${kv.key}=${kv.value}" } +
                    (it.throwableProxy?.let(ThrowableProxyUtil::asString) ?: "")
            }
            assertTrue(rendered.none { token in it || "flow_int_" in it }, "no line carries the token")
        } finally {
            root.detach()
        }
    }
}
