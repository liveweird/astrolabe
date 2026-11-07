package ch.nokillswit

import ch.nokillswit.infra.crypto.DEV_DATA_ENCRYPTION_KEY
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.db.R2dbcDatabaseKey
import ch.nokillswit.jira.JiraConnectionPageResponse
import ch.nokillswit.jira.JiraConnectionRequest
import ch.nokillswit.jira.JiraConnectionResponse
import ch.nokillswit.jira.JiraConnectionService
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncRunList
import ch.nokillswit.sync.SyncRunRequest
import ch.nokillswit.sync.SyncRunResponse
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncRunnerKey
import ch.nokillswit.sync.SyncState
import ch.nokillswit.sync.SyncTrigger
import ch.nokillswit.sync.failureJitterFraction
import ch.nokillswit.sync.failureJitterMillis
import ch.nokillswit.users.UserRole
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.equalTo
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.withTimeout
import org.junit.AfterClass
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * The connection's derived `status` (1.3; `GET /integrations/jira/connections` and `/{id}`): NEVER_SYNCED to CURRENT through a real run
 * over the stub, FAILED with its typed code and the failure streak (the `JiraRunFailureTest` page override), DISABLED after a PUT, STALE
 * past three intervals (rows written straight into `sync_runs` for the API, and the service's injected clock for the exact boundary).
 * `nextPollAt` is the scheduler's own rule, so the second failure waits two intervals. Connections are SHARED suite state: each test
 * mints its own and removes its runs.
 */
class JiraConnectionStatusTest {
    companion object {
        private const val SEARCH = "/ex/jira/${JiraStubServer.CLOUD_ID}/rest/api/3/search/jql"
        private const val INTERVAL = 15 * 60_000L

        /** The retry jitter of a failed run: the scheduler's own hash of the connection and the run, never a second copy of the rule. */
        private fun jitter(connectionId: UInt, runId: UInt, backoff: Long) =
            failureJitterMillis(INTERVAL, backoff, failureJitterFraction(connectionId, runId))

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

    private suspend fun ApplicationTestBuilder.start() {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
    }

    private suspend fun HttpClient.single(id: UInt): JiraConnectionResponse =
        jbJson.decodeFromString(get("$JB_CONNECTIONS/$id").also { assertEquals(HttpStatusCode.OK, it.status) }.bodyAsText())

    private suspend fun HttpClient.listed(id: UInt): JiraConnectionResponse =
        jbJson.decodeFromString<JiraConnectionPageResponse>(get("$JB_CONNECTIONS?sort=-id&pageSize=100").bodyAsText())
            .items.single { it.id == id }

    private suspend fun HttpClient.untested(request: JiraConnectionRequest = jbRequest()): JiraConnectionResponse {
        val created = postJson(JB_CONNECTIONS, request)
        assertEquals(HttpStatusCode.Created, created.status)
        return jbJson.decodeFromString(created.bodyAsText())
    }

    private fun clearRuns(vararg ids: UInt) = ids.forEach { jbSql("DELETE FROM sync_runs WHERE connection_id = ?", it.toInt()) }

    private fun succeededRun(connectionId: UInt, startedAt: Long) = jbSql(
        "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome) " +
            "VALUES ('JIRA', ?, 'MANUAL', ?, ?, 'SUCCEEDED')",
        connectionId.toInt(), startedAt, startedAt + 5_000,
    )

    /** `POST` a run and wait for the background run to end; answers its finished row. */
    private suspend fun ApplicationTestBuilder.runAndAwait(client: HttpClient, connectionId: UInt): SyncRunResponse {
        val accepted = client.postJson(SYNC_RUNS, SyncRunRequest(SyncKind.JIRA, connectionId))
        assertEquals(HttpStatusCode.Accepted, accepted.status, accepted.bodyAsText())
        val started = jbJson.decodeFromString<SyncRunResponse>(accepted.bodyAsText())
        withTimeout(120_000) { application.attributes[SyncRunnerKey].await(started.id) }
        return jbJson.decodeFromString<SyncRunList>(client.get("$SYNC_RUNS?kind=JIRA&connectionId=$connectionId").bodyAsText())
            .items.single { it.id == started.id }
    }

    @Test
    fun `an untested connection is NEVER_SYNCED with no next poll, a tested one is due at once`() = testApplication {
        start()
        val admin = seededClient("jcs-never", UserRole.ADMIN)
        val created = admin.untested()
        val status = created.status
        assertEquals(SyncState.NEVER_SYNCED, status.state)
        assertNull(status.lastRun)
        assertNull(status.lastSucceededAt)
        assertEquals(0, status.consecutiveFailures)
        assertNull(status.nextPollAt, "never tested, never polled")
        assertNull(created.lastRun)
        assertEquals(HttpStatusCode.OK, admin.post("$JB_CONNECTIONS/${created.id}/test").status)
        val tested = admin.single(created.id).status
        assertEquals(SyncState.NEVER_SYNCED, tested.state)
        assertFalse(tested.nextPollAt == null, "a tested connection with an interval and no run is due")
    }

    @Test
    fun `a real run turns NEVER_SYNCED into CURRENT and the next poll is one interval after it finished, on the GET and in the list`() =
        testApplication {
            start()
            val w = planWorld("jcscur", teams = true)
            val admin = w.admin.client
            val connection = admin.jbConnection()
            try {
                val run = runAndAwait(admin, connection.id)
                assertEquals(SyncOutcome.SUCCEEDED, run.outcome, run.errorDetail)
                val status = admin.single(connection.id).status
                assertEquals(SyncState.CURRENT, status.state)
                assertEquals(run.startedAt, status.lastSucceededAt)
                assertEquals(0, status.consecutiveFailures)
                assertEquals(run.finishedAt!! + INTERVAL, status.nextPollAt)
                val last = assertNotNull(status.lastRun)
                assertEquals(run.id, last.id)
                assertEquals(SyncTrigger.MANUAL, last.trigger)
                assertFalse(last.running)
                assertEquals(last, admin.single(connection.id).lastRun, "the top-level lastRun is the status's")
                assertEquals(status, admin.listed(connection.id).status, "the list and the single GET agree")
            } finally {
                clearRuns(connection.id)
            }
        }

    @Test
    fun `failed runs make it FAILED with the typed code, a growing streak and a doubling wait, a good run recovers`() = testApplication {
        start()
        val w = planWorld("jcsfail", teams = true)
        val admin = w.admin.client
        val connection = admin.jbConnection(jbRequest(keys = listOf("CE", "PF", "CG", "DI", "OE")))
        val milestone = TestPlan.milestone(w.projectId, w.requireTeams().teamId, planName("ms"))
        admin.jbBind(connection.id, JiraLevel.MILESTONE, milestone, "CE-25").jbBinding()
        val override = JiraStubServer.addOverride(
            get(urlPathEqualTo(SEARCH)).atPriority(1).withQueryParam("nextPageToken", equalTo("sample-fulltypes-eip-started-p3"))
                .willReturn(aResponse().withStatus(503).withBody("{}")),
        )
        try {
            val first = runAndAwait(admin, connection.id)
            assertEquals(SyncOutcome.FAILED, first.outcome)
            val one = admin.single(connection.id).status
            assertEquals(SyncState.FAILED, one.state)
            assertEquals("UPSTREAM_UNAVAILABLE", one.lastRun!!.errorCode)
            assertEquals(1, one.consecutiveFailures)
            assertNull(one.lastSucceededAt)
            assertEquals(
                first.finishedAt!! + INTERVAL + jitter(connection.id, first.id, INTERVAL), one.nextPollAt,
                "one interval plus the jitter",
            )

            val second = runAndAwait(admin, connection.id)
            val two = admin.listed(connection.id).status
            assertEquals(SyncState.FAILED, two.state)
            assertEquals(2, two.consecutiveFailures)
            assertEquals(
                second.finishedAt!! + 2 * INTERVAL + jitter(connection.id, second.id, 2 * INTERVAL), two.nextPollAt,
                "then it doubles: the scheduler's own back-off, plus the jitter",
            )
        } finally {
            JiraStubServer.removeOverride(override)
            JiraStubServer.resetScenarios()
        }
        try {
            val good = runAndAwait(admin, connection.id)
            assertEquals(SyncOutcome.SUCCEEDED, good.outcome, good.errorDetail)
            val recovered = admin.single(connection.id).status
            assertEquals(SyncState.CURRENT, recovered.state)
            assertEquals(0, recovered.consecutiveFailures)
            assertEquals(good.startedAt, recovered.lastSucceededAt)
        } finally {
            clearRuns(connection.id)
        }
    }

    @Test
    fun `a PUT that disables the connection makes it DISABLED with no next poll, and enabling it restores the state`() = testApplication {
        start()
        val admin = seededClient("jcs-off", UserRole.ADMIN)
        val created = admin.untested()
        succeededRun(created.id, System.currentTimeMillis() - 60_000)
        try {
            assertEquals(SyncState.CURRENT, admin.single(created.id).status.state)
            fun update(enabled: Boolean) = JiraConnectionRequest(
                created.name, created.siteUrl, created.email, null, created.authScheme, created.projectKeys, enabled,
                created.pollIntervalMinutes,
            )
            assertEquals(HttpStatusCode.NoContent, admin.putJson("$JB_CONNECTIONS/${created.id}", update(false)).status)
            val off = admin.single(created.id).status
            assertEquals(SyncState.DISABLED, off.state)
            assertNull(off.nextPollAt)
            assertNotNull(off.lastRun, "the run facts stay readable")
            assertEquals(SyncState.DISABLED, admin.listed(created.id).status.state)
            assertEquals(HttpStatusCode.NoContent, admin.putJson("$JB_CONNECTIONS/${created.id}", update(true)).status)
            assertEquals(SyncState.CURRENT, admin.single(created.id).status.state)
        } finally {
            clearRuns(created.id)
        }
    }

    @Test
    fun `STALE needs a polling interval - past three intervals it is stale, a manual-only connection never is`() = testApplication {
        start()
        val admin = seededClient("jcs-stale", UserRole.ADMIN)
        val polled = admin.untested()
        val manual = admin.untested(jbRequest().copy(pollIntervalMinutes = null))
        val now = System.currentTimeMillis()
        succeededRun(polled.id, now - 46 * 60_000)
        succeededRun(manual.id, now - 40L * 24 * 60 * 60_000)
        try {
            assertEquals(SyncState.STALE, admin.single(polled.id).status.state)
            val manualStatus = admin.single(manual.id).status
            assertEquals(SyncState.CURRENT, manualStatus.state)
            assertNull(manualStatus.nextPollAt)
            assertNull(admin.single(manual.id).pollIntervalMinutes)
            clearRuns(polled.id)
            succeededRun(polled.id, now - 44 * 60_000)
            assertEquals(SyncState.CURRENT, admin.single(polled.id).status.state, "44 minutes is inside 3 x 15")
        } finally {
            clearRuns(polled.id, manual.id)
        }
    }

    @Test
    fun `the service judges staleness by the registry's injected clock, exactly at three intervals`() = testApplication {
        start()
        val admin = seededClient("jcs-clock", UserRole.ADMIN)
        val created = admin.untested()
        val started = 1_700_000_000_000L
        succeededRun(created.id, started)
        try {
            suspend fun stateAt(now: Long): SyncState {
                val database = application.attributes[R2dbcDatabaseKey]
                val service = JiraConnectionService(database, FieldCipher(DEV_DATA_ENCRYPTION_KEY), SyncRunService(database, 10, { now }))
                return checkNotNull(service.read(created.id)).status.state
            }
            assertEquals(SyncState.CURRENT, stateAt(started + 3 * INTERVAL))
            assertEquals(SyncState.STALE, stateAt(started + 3 * INTERVAL + 1))
        } finally {
            clearRuns(created.id)
        }
    }
}
