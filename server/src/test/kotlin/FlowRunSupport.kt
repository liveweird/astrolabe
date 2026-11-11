package ch.nokillswit

import ch.nokillswit.flow.CapacityAcknowledgeService
import ch.nokillswit.flow.CapacityDeviationService
import ch.nokillswit.flow.FlowClientFactory
import ch.nokillswit.flow.FlowConnectionRequest
import ch.nokillswit.flow.FlowConnectionService
import ch.nokillswit.flow.FlowConnector
import ch.nokillswit.flow.FlowMirrorStore
import ch.nokillswit.flow.FlowObserver
import ch.nokillswit.flow.FlowTeamBindingService
import ch.nokillswit.flow.HttpFlowClient
import ch.nokillswit.flow.createFlowHttp
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncTrigger
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf

// Shared by the Flow run test classes. NOTHING here touches the shared Flow stub (StubWarmupGuardTest): a class that needs it warms the
// fixture in its @BeforeClass and hands the harness a client factory. The harness drives a REAL `FlowObserver` over the real services
// (the shared database), so a test sees the exact rows a run writes and the exact status the registry derives.

private val FLOW_JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")

/** A `200` JSON answer inside a scripted Flow handler. */
fun MockRequestHandleScope.flowOk(body: String): HttpResponseData = respond(body, HttpStatusCode.OK, FLOW_JSON_HEADERS)

/** A non-`200` answer inside a scripted Flow handler. */
fun MockRequestHandleScope.flowFailure(status: HttpStatusCode): HttpResponseData = respond("{}", status, FLOW_JSON_HEADERS)

/** A Flow teams document (`FlowDocument.kt`'s shape) with the flags set as named. */
fun flowDocument(vararg teams: String, teamsTruncated: Boolean = false, sprintsTruncated: Boolean = false): String =
    """{"asOf":1793275200000,"sprintsSince":"2025-11-08","teamsTruncated":$teamsTruncated,"sprintsTruncated":$sprintsTruncated,""" +
        """"items":[${teams.joinToString(",")}]}"""

/** One team of a document: [sprints] and [members] are counts of generated rows (a dated sprint with 40 MD each). */
fun flowTeamJson(id: Int, name: String = "Wire Team $id", sprints: Int = 1, members: Int = 1): String {
    val sprintRows = (1..sprints).joinToString(",") {
        val sprintId = id * 1000 + it
        """{"sprintId":$sprintId,"connectionId":3,"name":"S$sprintId","state":"closed","startAt":1000,"endAt":2000,"completeAt":2100,""" +
            """"hasCalendar":true,"capacityMd":40.5,"capacitySource":"CALENDAR"}"""
    }
    val memberRows = (1..members).joinToString(",") {
        """{"accountId":"acc-$id-$it","displayName":"Member $id $it","validFrom":1000,"validTo":null}"""
    }
    return """{"id":$id,"name":"$name","managerName":null,"defaultCapacityMd":30,"members":[$memberRows],"sprints":[$sprintRows]}"""
}

/**
 * A scripted Flow: [handler] answers every request; [requests] is what reached the wire, in order. [harness] runs a `FlowObserver`
 * over a REAL `HttpFlowClient` and transport on top of the engine.
 */
class MockFlow(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData) {
    private val engine = MockEngine { handler(it) }
    val requests: List<HttpRequestData> get() = engine.requestHistory

    fun harness(now: () -> Long = System::currentTimeMillis, sprintsSinceDays: Int = 365): FlowRunHarness {
        val http = createFlowHttp(
            HttpClient(engine) {
                expectSuccess = false
                followRedirects = false
            },
            maxRetries = 0, maxResponseBytes = 8_000_000, maxConcurrentRequests = 2, sleeper = { },
        )
        return FlowRunHarness({ baseUrl, token -> HttpFlowClient(http, baseUrl, token) }, sprintsSinceDays, now)
    }
}

/** A real [FlowObserver] with its services; the connection service accepts any origin (the guard under test is the transport's). */
class FlowRunHarness(clients: FlowClientFactory, sprintsSinceDays: Int = 365, now: () -> Long = System::currentTimeMillis) {
    private val database = sharedDatabaseForTests()
    val runs = SyncRunService(database, maxRunMinutes = 10)
    val connections = FlowConnectionService(database, flowTestCipher, runs, anyFlowOrigin)
    val mirror = FlowMirrorStore(database)
    val bindings = FlowTeamBindingService(database)
    private val capacity = capacityService(database)

    /** The deviation computation of the run's prune, on the harness's OWN clock (a clock-injected test must prune against its "today"). */
    val deviations = CapacityDeviationService(database, bindings, mirror, capacity, runs, now)
    val acknowledgements = CapacityAcknowledgeService(database, deviations, bindings, mirror)
    val observer = FlowObserver(FlowConnector(clients, sprintsSinceDays), connections, mirror, bindings, acknowledgements, now)

    /** Creates a connection to [origin]; [tested] records a passing Test connection (what makes the scheduler poll it). */
    suspend fun connect(
        prefix: String,
        origin: String,
        token: String = flowToken(),
        timeZone: String = "Europe/Warsaw",
        enabled: Boolean = true,
        tested: Boolean = true,
    ): UInt {
        val id = connections.create(FlowConnectionRequest(flowUnique(prefix), origin, timeZone, token, enabled, 60))
        if (tested) {
            val target = checkNotNull(connections.readForTest(id))
            check(connections.recordTest(id, target.expectedUpdatedAt, ok = true, at = System.currentTimeMillis()))
        }
        return id
    }

    /** Claims and runs once, finishing the row like the runner does; the answer is what the connector reported. */
    suspend fun run(connectionId: UInt, trigger: SyncTrigger = SyncTrigger.MANUAL, byUserId: UInt? = null): SyncResult {
        val claimed = runs.claimUnchecked(SyncKind.FLOW, connectionId, trigger, byUserId)
        val result = observer.run(claimed)
        runs.finish(claimed.id, result)
        return result
    }

    /** The newest run row of the connection. */
    suspend fun lastRun(connectionId: UInt) = runs.list(SyncKind.FLOW, connectionId).first()

    private val seededTeams = mutableListOf<UInt>()
    private var seededUser: UInt? = null

    /** Links a fresh Astrolabe team to [flowTeamId] of the connection (an ACTIVE binding), the way a later step's bind does. */
    suspend fun bind(prefix: String, connectionId: UInt, flowTeamId: Int, flowTeamName: String = "FT"): UInt {
        val team = TestTeams.seed(flowUnique(prefix)).also { seededTeams += it }
        val user = seededUser ?: TestUsers.seed(uniqueEmail("flowrun"), "flow-run-pass-1").also { seededUser = it }
        jbSql(
            "INSERT INTO flow_team_bindings (connection_id, team_id, flow_team_id, flow_team_name, created_by_user_id, created_at, " +
                "updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)",
            connectionId.toInt(), team.toInt(), flowTeamId, flowTeamName, user.toInt(),
        )
        return team
    }

    /**
     * Removes what the test made: the connections named `connectionPrefix*` with their children (bindings included), then the teams and
     * the login [bind] seeded (a binding references both, so they go last).
     */
    fun cleanUp(connectionPrefix: String) {
        removeFlowFixtureRows(connectionPrefix)
        seededTeams.forEach { jbSql("DELETE FROM teams WHERE id = ?", it.toInt()) }
        seededTeams.clear()
        seededUser?.let { jbSql("DELETE FROM users WHERE id = ?", it.toInt()) }
        seededUser = null
    }
}
