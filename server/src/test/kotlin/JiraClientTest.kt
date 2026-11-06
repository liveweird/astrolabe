package ch.nokillswit

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.SourceHttp
import ch.nokillswit.jira.HttpJiraClient
import ch.nokillswit.jira.JiraAuthScheme
import ch.nokillswit.jira.createJiraHttp
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")
private const val CLOUD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
private const val TENANT_INFO = """{"cloudId":"$CLOUD_ID"}"""
private const val JQL = """project in ("ENG")"""

/**
 * `SourceHttp` and `HttpJiraClient` against a scripted Ktor `MockEngine` - no network, no WireMock (the stub-backed suite is
 * `JiraTestConnectionTest`). Note for anyone debugging the stub: a request shape the stub has no mapping for falls to its auth
 * catch-all and reads as a `401` (`sample-data/jira/README.md`), so a "401 on search" there can mean an unmatched shape, not a bad token.
 */
class JiraClientTest {

    private fun jiraHttp(
        engine: MockEngine,
        maxRetries: Int = 2,
        maxResponseBytes: Long = 1_000_000,
        requestDeadlineMillis: Long = 180_000,
        sleeps: MutableList<Long>? = null,
    ): SourceHttp {
        // Ktor's client-side HttpRedirect plugin (separate from the OkHttp engine's own followRedirects, which the guard never enables in
        // production either) must be off too, or a 3xx never reaches SourceHttp's own REDIRECT mapping.
        val httpClient = HttpClient(engine) {
            expectSuccess = false
            followRedirects = false
        }
        return createJiraHttp(
            httpClient, maxRetries, maxResponseBytes, maxConcurrentRequests = 4,
            requestDeadlineMillis = requestDeadlineMillis, random = { 0.5 }, sleeper = { sleeps?.add(it) }, clock = { 0L },
        )
    }

    private fun client(
        engine: MockEngine,
        scheme: JiraAuthScheme = JiraAuthScheme.BASIC,
        token: String = "tok",
        email: String = "svc@example.com",
        stub: String? = null,
        http: SourceHttp = jiraHttp(engine, maxRetries = 0),
        site: String = "https://acme.atlassian.net",
    ) = HttpJiraClient(http, stub ?: site, stub, email, token, scheme)

    private fun gateway(handler: MockRequestHandleScope.(HttpRequestData) -> HttpResponseData): MockEngine = MockEngine { request ->
        if (request.url.encodedPath.endsWith("/_edge/tenant_info")) {
            respond(TENANT_INFO, HttpStatusCode.OK, JSON_HEADERS)
        } else {
            handler(request)
        }
    }

    @Test
    fun `429 is retried and then RATE_LIMITED once retries are exhausted`() = runBlocking {
        var calls = 0
        val engine = MockEngine { calls++; respond("{}", HttpStatusCode.TooManyRequests, JSON_HEADERS) }
        val error = assertFailsWith<FetchException> {
            jiraHttp(engine, maxRetries = 2).request(HttpMethod.Get, "https://example.atlassian.net/probe")
        }
        assertEquals("RATE_LIMITED", error.code)
        assertEquals(3, calls, "the initial attempt plus 2 retries")
    }

    @Test
    fun `a 5xx is retried and then UPSTREAM_UNAVAILABLE`() = runBlocking {
        var calls = 0
        val engine = MockEngine { calls++; respond("{}", HttpStatusCode.ServiceUnavailable, JSON_HEADERS) }
        val error = assertFailsWith<FetchException> {
            jiraHttp(engine, maxRetries = 1).request(HttpMethod.Get, "https://example.atlassian.net/probe")
        }
        assertEquals("UPSTREAM_UNAVAILABLE", error.code)
        assertEquals(2, calls)
    }

    @Test
    fun `a successful retry after 429 returns the parsed body`() = runBlocking {
        var calls = 0
        val engine = MockEngine {
            if (++calls == 1) {
                respond("{}", HttpStatusCode.TooManyRequests, JSON_HEADERS)
            } else {
                respond("""{"ok":true}""", HttpStatusCode.OK, JSON_HEADERS)
            }
        }
        val result = jiraHttp(engine, maxRetries = 2).request(HttpMethod.Get, "https://example.atlassian.net/probe")
        assertEquals(2, calls)
        assertTrue(result.toString().contains("\"ok\":true"))
    }

    @Test
    fun `status maps to the documented failure codes`() {
        val codes = listOf(401 to "AUTHENTICATION_FAILED", 403 to "FORBIDDEN_SCOPE", 404 to "NOT_FOUND", 400 to "INVALID_RESPONSE")
        codes.forEach { (status, code) ->
            runBlocking {
                val engine = MockEngine { respond("{}", HttpStatusCode.fromValue(status), JSON_HEADERS) }
                val error = assertFailsWith<FetchException> {
                    jiraHttp(engine, maxRetries = 0).request(HttpMethod.Get, "https://example.atlassian.net/probe")
                }
                assertEquals(code, error.code, "status $status")
            }
        }
    }

    @Test
    fun `a redirect is refused, never followed`() = runBlocking {
        val engine = MockEngine { respond("", HttpStatusCode.Found, headersOf(HttpHeaders.Location, "https://evil.example/")) }
        val error = assertFailsWith<FetchException> {
            jiraHttp(engine, maxRetries = 0).request(HttpMethod.Get, "https://example.atlassian.net/probe")
        }
        assertEquals("REDIRECT", error.code)
    }

    @Test
    fun `malformed JSON is INVALID_RESPONSE`() = runBlocking {
        val engine = MockEngine { respond("{ not json", HttpStatusCode.OK, JSON_HEADERS) }
        val error = assertFailsWith<FetchException> {
            jiraHttp(engine, maxRetries = 0).request(HttpMethod.Get, "https://example.atlassian.net/probe")
        }
        assertEquals("INVALID_RESPONSE", error.code)
    }

    @Test
    fun `a response over the byte cap is LIMIT_EXCEEDED`() = runBlocking {
        val engine = MockEngine { respond("x".repeat(100), HttpStatusCode.OK, JSON_HEADERS) }
        val error = assertFailsWith<FetchException> {
            jiraHttp(engine, maxRetries = 0, maxResponseBytes = 10).request(HttpMethod.Get, "https://example.atlassian.net/probe")
        }
        assertEquals("LIMIT_EXCEEDED", error.code)
    }

    @Test
    fun `Basic auth is base64(email colon token), Bearer is the raw token`() = runBlocking {
        var seen: String? = null
        fun engineFor() = gateway { request ->
            seen = request.headers[HttpHeaders.Authorization]
            respond("""{"accountId":"u1"}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        client(engineFor(), JiraAuthScheme.BASIC, token = "tok-1", email = "svc@example.com").apply { resolveCloudId(); myself() }
        assertEquals("Basic " + Base64.getEncoder().encodeToString("svc@example.com:tok-1".toByteArray()), seen)
        client(engineFor(), JiraAuthScheme.BEARER, token = "tok-2").apply { resolveCloudId(); myself() }
        assertEquals("Bearer tok-2", seen)
    }

    @Test
    fun `resolveCloudId is unauthenticated, and every other call goes through the gateway path`() = runBlocking {
        val seen = CopyOnWriteArrayList<Triple<String, String, Boolean>>()
        val engine = MockEngine { request ->
            seen += Triple(request.url.host, request.url.encodedPath, request.headers[HttpHeaders.Authorization] != null)
            respond(if (request.url.encodedPath.endsWith("/tenant_info")) TENANT_INFO else "{}", HttpStatusCode.OK, JSON_HEADERS)
        }
        val client = client(engine)
        client.resolveCloudId()
        client.myself()
        assertEquals(
            listOf(
                Triple("acme.atlassian.net", "/_edge/tenant_info", false),
                Triple("api.atlassian.com", "/ex/jira/$CLOUD_ID/rest/api/3/myself", true),
            ),
            seen.toList(),
            "the site is asked only for tenant_info; the authenticated traffic goes to the gateway whatever the site says",
        )
    }

    @Test
    fun `with a stub the gateway host is the stub, the path shape unchanged`() = runBlocking {
        val seen = CopyOnWriteArrayList<String>()
        val engine = MockEngine { request ->
            seen += "${request.url.protocol.name}://${request.url.host}:${request.url.port}${request.url.encodedPath}"
            respond(if (request.url.encodedPath.endsWith("/tenant_info")) TENANT_INFO else "[]", HttpStatusCode.OK, JSON_HEADERS)
        }
        val client = client(engine, stub = "http://jira-stub:8096")
        client.resolveCloudId()
        client.fields()
        assertEquals(
            listOf("http://jira-stub:8096/_edge/tenant_info", "http://jira-stub:8096/ex/jira/$CLOUD_ID/rest/api/3/field"),
            seen.toList(),
        )
    }

    @Test
    fun `a call before resolveCloudId is an IllegalStateException, not a request`() = runBlocking<Unit> {
        var calls = 0
        val engine = MockEngine { calls++; respond("{}", HttpStatusCode.OK, JSON_HEADERS) }
        assertFailsWith<IllegalStateException> { client(engine).myself() }
        assertEquals(0, calls)
    }

    @Test
    fun `a non-UUID cloudId is INVALID_RESPONSE and never becomes the gateway path`() = runBlocking {
        for (bad in listOf("not-a-uuid", "../../etc", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/x", "")) {
            val engine = MockEngine { respond("""{"cloudId":"$bad"}""", HttpStatusCode.OK, JSON_HEADERS) }
            assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException>(bad) { client(engine).resolveCloudId() }.code)
        }
        val missing = MockEngine { respond("{}", HttpStatusCode.OK, JSON_HEADERS) }
        assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException> { client(missing).resolveCloudId() }.code)
        val notAString = MockEngine { respond("""{"cloudId":{"a":1}}""", HttpStatusCode.OK, JSON_HEADERS) }
        assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException> { client(notAString).resolveCloudId() }.code)
    }

    @Test
    fun `a mixed-case cloudId is accepted and returned lowercase`() = runBlocking {
        val engine = MockEngine { respond("""{"cloudId":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"}""", HttpStatusCode.OK, JSON_HEADERS) }
        assertEquals(CLOUD_ID, client(engine).resolveCloudId())
    }

    @Test
    fun `a body of the wrong shape is INVALID_RESPONSE, not an uncaught raw-cast exception`() = runBlocking {
        val engine = gateway { respond("[]", HttpStatusCode.OK, JSON_HEADERS) }
        val client = client(engine)
        client.resolveCloudId()
        assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException> { client.myself() }.code)
        assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException> { client.searchJql(JQL, "id") }.code)
        val objectForArray = gateway { respond("{}", HttpStatusCode.OK, JSON_HEADERS) }
        val other = client(objectForArray)
        other.resolveCloudId()
        assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException> { other.fields() }.code)
        assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException> { other.issueTypes() }.code)
    }

    @Test
    fun `searchJql sends the jql, the fields and the maxResults, and honours the nextPageToken the previous page returned`() = runBlocking {
        val seen = CopyOnWriteArrayList<Map<String, String?>>()
        val engine = gateway { request ->
            val p = request.url.parameters
            seen += mapOf("jql" to p["jql"], "fields" to p["fields"], "max" to p["maxResults"], "token" to p["nextPageToken"])
            val body = if (seen.size == 1) """{"issues":[{"id":"1"}],"nextPageToken":"page-2"}""" else """{"issues":[]}"""
            respond(body, HttpStatusCode.OK, JSON_HEADERS)
        }
        val client = client(engine)
        client.resolveCloudId()
        val first = client.searchJql(JQL, fields = "id,key", maxResults = 7)
        assertEquals("page-2", first.nextPageToken)
        assertEquals(1, first.issues?.size)
        val second = client.searchJql(JQL, fields = "id,key", nextPageToken = first.nextPageToken, maxResults = 7)
        assertNull(second.nextPageToken)
        assertEquals(
            listOf(
                mapOf("jql" to JQL, "fields" to "id,key", "max" to "7", "token" to null),
                mapOf("jql" to JQL, "fields" to "id,key", "max" to "7", "token" to "page-2"),
            ),
            seen.toList(),
        )
    }

    @Test
    fun `a 400 or 410 on a page token is CURSOR_EXPIRED, on the first page a plain INVALID_RESPONSE`() = runBlocking {
        for (status in listOf(400, 410)) {
            val engine = gateway { respond("{}", HttpStatusCode.fromValue(status), JSON_HEADERS) }
            val client = client(engine)
            client.resolveCloudId()
            assertEquals("CURSOR_EXPIRED", assertFailsWith<FetchException> { client.searchJql(JQL, "id", nextPageToken = "t") }.code)
        }
        val engine = gateway { respond("{}", HttpStatusCode.BadRequest, JSON_HEADERS) }
        val client = client(engine)
        client.resolveCloudId()
        assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException> { client.searchJql(JQL, "id") }.code)
    }

    @Test
    fun `issue accepts a numeric id or a key and refuses anything that could add a path segment`() = runBlocking<Unit> {
        val paths = CopyOnWriteArrayList<String>()
        val fields = CopyOnWriteArrayList<String?>()
        val engine = gateway { request ->
            paths += request.url.encodedPath
            fields += request.url.parameters["fields"]
            respond("""{"id":"10"}""", HttpStatusCode.OK, JSON_HEADERS)
        }
        val client = client(engine)
        client.resolveCloudId()
        client.issue("10", fields = "id")
        client.issue("ABC-12")
        assertEquals(listOf("/ex/jira/$CLOUD_ID/rest/api/3/issue/10", "/ex/jira/$CLOUD_ID/rest/api/3/issue/ABC-12"), paths.toList())
        assertEquals(listOf("id", null), fields.toList())
        for (bad in listOf("../myself", "10/changelog", "abc-12", "ABC-12?x=1", "", "1".repeat(21), "A-1", "ABC-")) {
            assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException>(bad) { client.issue(bad) }.code)
        }
        assertEquals(2, paths.size, "a refused id never reaches the wire")
    }

    @Test
    fun `projectsSearch sends every configured key as a repeated keys parameter (A8) and startAt`() = runBlocking {
        val seen = CopyOnWriteArrayList<Pair<List<String>, String?>>()
        val engine = gateway { request ->
            seen += request.url.parameters.getAll("keys").orEmpty() to request.url.parameters["startAt"]
            respond(
                """{"startAt":50,"maxResults":50,"total":51,"isLast":true,"self":"x","values":[{"key":"ENG"}]}""",
                HttpStatusCode.OK, JSON_HEADERS,
            )
        }
        val client = client(engine)
        client.resolveCloudId()
        val page = client.projectsSearch(listOf("ENG", "OPS"), 50)
        assertEquals(listOf(listOf("ENG", "OPS") to "50"), seen.toList())
        assertEquals(1, page.values.size)
        assertEquals(true, page.isLast)
        assertEquals(51, page.total)
    }

    @Test
    fun `projectsSearch refuses no keys, more than 50 and a key outside the shape before any request`() = runBlocking<Unit> {
        var calls = 0
        val engine = gateway { calls++; respond("{}", HttpStatusCode.OK, JSON_HEADERS) }
        val client = client(engine)
        client.resolveCloudId()
        val tooMany = (1..51).map { "K$it" }
        for (bad in listOf(emptyList(), tooMany, listOf("lower"), listOf("A&keys=B"))) {
            assertFailsWith<IllegalArgumentException> { client.projectsSearch(bad) }
        }
        assertEquals(0, calls)
    }

    @Test
    fun `fields and issueTypes come back trimmed - the unusable types are dropped and the reported count is kept`() = runBlocking {
        val engine = gateway { request ->
            val body = if (request.url.encodedPath.endsWith("/field")) {
                """[{"id":"summary","name":"Summary","schema":{"type":"string"}},
                    {"id":"duedate","name":"Due date","schema":{"type":"date"}},
                    {"id":"customfield_1","name":"Team","schema":{"type":"team","custom":"x:atlassian-team"}},
                    "garbage"]"""
            } else {
                """[{"id":"10004","name":"Epic","subtask":false,"hierarchyLevel":1},{"nope":1}]"""
            }
            respond(body, HttpStatusCode.OK, JSON_HEADERS)
        }
        val client = client(engine)
        client.resolveCloudId()
        val fields = client.fields()
        assertEquals(3, fields.reported)
        assertEquals(listOf("duedate", "customfield_1"), fields.kept.map { it.id })
        assertEquals(listOf("10004"), client.issueTypes().map { it.id })
    }

    @Test
    fun `a failing call reports the endpoint without its query string and never the token`() = runBlocking {
        val engine = gateway { respond("{}", HttpStatusCode.Forbidden, JSON_HEADERS) }
        val client = client(engine, token = "SECRET-TOKEN-VALUE")
        client.resolveCloudId()
        val error = assertFailsWith<FetchException> { client.searchJql(JQL, "id,secretfield") }
        assertEquals("FORBIDDEN_SCOPE", error.code)
        val message = error.message.orEmpty()
        assertTrue(message.endsWith("/rest/api/3/search/jql"), message)
        assertFalse("?" in message || "project" in message || "secretfield" in message || "SECRET-TOKEN-VALUE" in message, message)
        assertFalse("SECRET-TOKEN-VALUE" in error.toString())
    }

    @Test
    fun `the pause is keyed by cloud id, so one tenant's 429 never stalls another tenant on the same transport`() = runBlocking<Unit> {
        val cloudA = "aaaaaaaa-0000-0000-0000-000000000001"
        val cloudB = "bbbbbbbb-0000-0000-0000-000000000002"
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            when {
                path == "/_edge/tenant_info" -> {
                    val cloudId = if (request.url.host == "a.test") cloudA else cloudB
                    respond("""{"cloudId":"$cloudId"}""", HttpStatusCode.OK, JSON_HEADERS)
                }
                path.startsWith("/ex/jira/$cloudA/") ->
                    respond("{}", HttpStatusCode.TooManyRequests, headersOf(HttpHeaders.RetryAfter, "30"))
                else -> respond("{}", HttpStatusCode.OK, JSON_HEADERS)
            }
        }
        val sleeps = CopyOnWriteArrayList<Long>()
        val http = jiraHttp(engine, maxRetries = 0, sleeps = sleeps)
        val a = HttpJiraClient(http, "https://a.test", null, "svc@example.com", "token", JiraAuthScheme.BASIC)
        val b = HttpJiraClient(http, "https://b.test", null, "svc@example.com", "token", JiraAuthScheme.BASIC)
        a.resolveCloudId()
        b.resolveCloudId()
        assertEquals("RATE_LIMITED", assertFailsWith<FetchException> { a.myself() }.code)
        b.myself()
        assertEquals(emptyList(), sleeps.toList(), "tenant B did not wait for tenant A's pause")
        assertEquals("RATE_LIMITED", assertFailsWith<FetchException> { a.myself() }.code)
        assertEquals(listOf(30_000L), sleeps.toList(), "tenant A's next call waited it out")
    }

    @Test
    fun `a Retry-After beyond the remaining request deadline fails RATE_LIMITED immediately, without waiting it out`() = runBlocking {
        var calls = 0
        val engine = MockEngine {
            calls++
            val headers = headersOf(HttpHeaders.RetryAfter to listOf("9999"), HttpHeaders.ContentType to listOf("application/json"))
            respond("{}", HttpStatusCode.TooManyRequests, headers)
        }
        val error = assertFailsWith<FetchException> {
            jiraHttp(engine, maxRetries = 5, requestDeadlineMillis = 5_000).request(HttpMethod.Get, "https://example.atlassian.net/probe")
        }
        assertEquals("RATE_LIMITED", error.code)
        assertEquals(1, calls)
    }
}
