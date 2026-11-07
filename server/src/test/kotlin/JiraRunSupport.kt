package ch.nokillswit

import ch.nokillswit.infra.db.R2dbcDatabaseKey
import ch.nokillswit.jira.HttpJiraClient
import ch.nokillswit.jira.JiraConnectionServiceKey
import ch.nokillswit.jira.JiraConnector
import ch.nokillswit.jira.JiraIssueStore
import ch.nokillswit.jira.JiraObserver
import ch.nokillswit.jira.JiraRunStore
import ch.nokillswit.jira.RUN_CHUNK
import ch.nokillswit.jira.createJiraHttp
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunServiceKey
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
import io.ktor.server.application.Application

// Shared by the Jira run test classes. NOTHING here touches the shared stub (JiraStubWarmupGuardTest): a class that needs it starts its own
// app with `jira.stubBaseUrl` and warms the fixture in its @BeforeClass. The harness below drives a REAL `JiraObserver` (the real services,
// the real `HttpJiraClient` and transport) over a scripted Ktor `MockEngine`, so a test sees the exact requests the client put on the wire.

private const val MOCK_CLOUD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")

/** A scripted site: [handler] answers every request but `tenant_info`; [requests] is what reached the wire, in order. */
class MockJiraRun(
    app: Application,
    chunkSize: Int = RUN_CHUNK,
    now: () -> Long = System::currentTimeMillis,
    maxRetries: Int = 0,
    handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
) {
    private val engine = MockEngine { request ->
        if (request.url.encodedPath.endsWith("/_edge/tenant_info")) {
            respond("""{"cloudId":"$MOCK_CLOUD_ID"}""", HttpStatusCode.OK, JSON_HEADERS)
        } else {
            handler(request)
        }
    }
    val runs = app.attributes[SyncRunServiceKey]
    private val observer: JiraObserver

    init {
        val http = createJiraHttp(
            HttpClient(engine) {
                expectSuccess = false
                followRedirects = false
            },
            maxRetries = maxRetries, maxResponseBytes = 8_000_000, maxConcurrentRequests = 2, sleeper = { },
        )
        val connector = JiraConnector(
            { site, email, token, scheme -> HttpJiraClient(http, site, null, email, token, scheme) },
            pageSize = 100, incrementalOverlapMinutes = 10,
        )
        observer = JiraObserver(
            connector, app.attributes[JiraConnectionServiceKey], JiraRunStore(app.attributes[R2dbcDatabaseKey]),
            JiraIssueStore(app.attributes[R2dbcDatabaseKey]), runs, now = now, chunkSize = chunkSize,
        )
    }

    /** The observer itself, for a runner (`SyncRunner.start`) to execute like the application does. */
    val connector: ch.nokillswit.sync.Connector get() = observer

    val requests: List<HttpRequestData> get() = engine.requestHistory

    /** The search requests only (`tenant_info` and issue reads excluded), in order. */
    val searches: List<HttpRequestData> get() = requests.filter { it.url.encodedPath.endsWith("/search/jql") }

    /** Claims and runs once, finishing the row like the runner does; the answer is what the connector reported. */
    suspend fun run(connectionId: UInt): SyncResult {
        val claimed = runs.claim(SyncKind.JIRA, connectionId, SyncTrigger.MANUAL, null)
        val result = observer.run(claimed)
        runs.finish(claimed.id, result)
        return result
    }
}

/** A `200` JSON answer inside a [MockJiraRun] handler. */
fun MockRequestHandleScope.jsonOk(body: String): HttpResponseData = respond(body, HttpStatusCode.OK, JSON_HEADERS)

/** A non-`200` answer inside a [MockJiraRun] handler. */
fun MockRequestHandleScope.failure(status: HttpStatusCode): HttpResponseData = respond("{}", status, JSON_HEADERS)

/** One search page: [issues] are raw issue documents. */
fun searchPage(vararg issues: String, next: String? = null): String =
    """{"issues":[${issues.joinToString(",")}],"isLast":${next == null}${next?.let { ""","nextPageToken":"$it"""" }.orEmpty()}}"""

/** An issue document in the shape of a Jira search entry; [fields] is the raw JSON members of `fields` beyond the type and summary. */
fun issueDoc(
    id: String,
    key: String,
    typeId: String = "10004",
    typeName: String = "Epic",
    level: Int? = 1,
    summary: String = "Issue $key",
    fields: String = "",
): String {
    val levelMember = level?.let { ""","hierarchyLevel":$it""" }.orEmpty()
    val extra = if (fields.isBlank()) "" else ",$fields"
    val type = """{"id":"$typeId","name":"$typeName","subtask":false$levelMember}"""
    val status = """{"name":"In Progress","statusCategory":{"key":"indeterminate"}}"""
    return """{"id":"$id","key":"$key","fields":{"summary":"$summary","issuetype":$type,"status":$status,""" +
        """"updated":"2026-10-01T10:00:00.000+0000"$extra}}"""
}

/** A sweep page: `{id}` entries only. */
fun idsPage(vararg ids: String): String = searchPage(*ids.map { """{"id":"$it"}""" }.toTypedArray())

/** A bind-time observation (what a bind stores) with everything but the identity and the named values absent. */
fun seedObservation(
    issueId: String,
    issueKey: String,
    summary: String,
    startDate: java.time.LocalDate? = null,
): ch.nokillswit.jira.JiraObservation = ch.nokillswit.jira.JiraObservation(
    observedAt = 1, issueId = issueId, issueKey = issueKey, summary = summary, typeId = "10004", typeName = "Epic", hierarchyLevel = 1,
    statusName = "To Do", statusCategory = ch.nokillswit.jira.JiraStatusCategory.TODO, parentIssueId = null, parentIssueKey = null,
    startDate = startDate, endDate = null, estimate = null, estimateUnit = null, teamName = null, jiraUpdatedAt = null,
)
