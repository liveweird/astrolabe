package ch.nokillswit

import ch.nokillswit.flow.FLOW_SPRINT_CAP
import ch.nokillswit.flow.FLOW_TEAM_CAP
import ch.nokillswit.flow.FlowClient
import ch.nokillswit.flow.FlowMe
import ch.nokillswit.flow.FlowTeamsDocument
import ch.nokillswit.flow.HttpFlowClient
import ch.nokillswit.flow.buildGuardedFlowHttpClient
import ch.nokillswit.flow.createFlowHttp
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.SourceHttp
import ch.nokillswit.infra.outbound.FlowOrigins
import ch.nokillswit.infra.outbound.Origin
import ch.nokillswit.infra.outbound.SelfManagedHosts
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.BeforeClass
import java.net.URI
import java.time.LocalDate
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val JSON_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")
private const val ORIGIN = "https://flow.test"
private val SINCE: LocalDate = LocalDate.of(2026, 1, 5)

private const val HEAD = """"asOf":1,"sprintsSince":"2026-01-05","teamsTruncated":false,"sprintsTruncated":false,"""
private const val ME = """{"tokenId":7,"name":"astrolabe","createdAt":1792000000000,"expiresAt":null,"lastUsedAt":1793000000000}"""

private const val MEMBER = """{"accountId":"acc-1","displayName":"Stub One","validFrom":1000,"validTo":null}"""
private val SPRINT = """{"sprintId":42,"connectionId":3,"name":"S 42","state":"closed","startAt":1000,"endAt":2000,"completeAt":2100,
    |"hasCalendar":true,"capacityMd":40.5,"capacitySource":"CALENDAR"}""".trimMargin().replace("\n", "")
private val TEAM = """{"id":5,"name":"Alpha","managerName":null,"defaultCapacityMd":30,"members":[$MEMBER],"sprints":[$SPRINT]}"""
private fun teamsBody(truncated: Boolean = false, teamsTruncated: Boolean = false, extra: String = "") =
    """{"asOf":1793275200000,"sprintsSince":"2026-01-05","teamsTruncated":$teamsTruncated,"sprintsTruncated":$truncated,
        |"items":[$TEAM]$extra}""".trimMargin().replace("\n", "")

/**
 * `HttpFlowClient` and `flow/FlowDocument.kt` against a scripted Ktor `MockEngine` - no network (the stub-backed replay is the last
 * test): the bearer header, the exact URL and `sprintsSince`, every failure code, no redirect, the byte cap, `sprintsTruncated`, the
 * lenient/strict decode. The contract's two places (`flow/FlowDocument.kt`, `sample-data/flow/contract.mjs`) are proven aligned here
 * and by `FlowStubFixtureTest`.
 */
class FlowClientTest {

    private fun flowHttp(
        engine: MockEngine,
        maxRetries: Int = 0,
        maxResponseBytes: Long = 1_000_000,
        sleeps: MutableList<Long>? = null,
    ): SourceHttp {
        // Ktor's client-side HttpRedirect plugin must be off too (the guarded client sets it), or a 3xx never reaches the REDIRECT mapping.
        val client = HttpClient(engine) {
            expectSuccess = false
            followRedirects = false
        }
        return createFlowHttp(
            client, maxRetries, maxResponseBytes, maxConcurrentRequests = 2,
            random = { 0.5 }, sleeper = { sleeps?.add(it) }, clock = { 0L },
        )
    }

    private fun client(engine: MockEngine, token: String = flowToken('t'), maxRetries: Int = 0): FlowClient =
        HttpFlowClient(flowHttp(engine, maxRetries = maxRetries), ORIGIN, token)

    private fun answering(status: HttpStatusCode, body: String = "{}") = MockEngine { respond(body, status, JSON_HEADERS) }

    // --- the request ---

    @Test
    fun `me sends exactly one GET with the bearer token and decodes the facts`() = runBlocking {
        val seen = CopyOnWriteArrayList<HttpRequestData>()
        val token = flowToken('m')
        val me = client(MockEngine { seen += it; respond(ME, HttpStatusCode.OK, JSON_HEADERS) }, token).me()
        assertEquals(FlowMe(7, "astrolabe", 1_792_000_000_000, null, 1_793_000_000_000), me)
        val request = seen.single()
        assertEquals(HttpMethod.Get, request.method)
        assertEquals("$ORIGIN/api/v1/integration/me", request.url.toString())
        assertEquals("Bearer $token", request.headers[HttpHeaders.Authorization])
        assertEquals(listOf("Bearer $token"), request.headers.getAll(HttpHeaders.Authorization), "one Authorization header")
    }

    @Test
    fun `teams sends the sprintsSince date and the bearer token, and decodes every field of the document`() = runBlocking {
        val seen = CopyOnWriteArrayList<HttpRequestData>()
        val token = flowToken('s')
        val document = client(MockEngine { seen += it; respond(teamsBody(), HttpStatusCode.OK, JSON_HEADERS) }, token).teams(SINCE)
        val request = seen.single()
        assertEquals("$ORIGIN/api/v1/integration/teams?sprintsSince=2026-01-05", request.url.toString())
        assertEquals("Bearer $token", request.headers[HttpHeaders.Authorization])
        assertEquals(1_793_275_200_000, document.asOf)
        assertEquals("2026-01-05", document.sprintsSince)
        assertFalse(document.teamsTruncated)
        assertFalse(document.sprintsTruncated)
        val team = document.items.single()
        assertEquals(5, team.id)
        assertEquals("Alpha", team.name)
        assertNull(team.managerName)
        assertEquals(30.0, team.defaultCapacityMd)
        val member = team.members.single()
        assertEquals("acc-1", member.accountId)
        assertEquals("Stub One", member.displayName)
        assertEquals(1000, member.validFrom)
        assertNull(member.validTo)
        val sprint = team.sprints.single()
        assertEquals(42, sprint.sprintId)
        assertEquals(3, sprint.connectionId)
        assertEquals("closed", sprint.state)
        assertEquals(1000, sprint.startAt)
        assertEquals(2000, sprint.endAt)
        assertEquals(2100, sprint.completeAt)
        assertTrue(sprint.hasCalendar)
        assertEquals(40.5, sprint.capacityMd)
        assertEquals("CALENDAR", sprint.capacitySource)
    }

    // --- the failure codes ---

    @Test
    fun `a 401 is AUTHENTICATION_FAILED after exactly one attempt`() = runBlocking {
        var calls = 0
        val engine = MockEngine { calls++; respond("""{"title":"Unauthorized"}""", HttpStatusCode.Unauthorized, JSON_HEADERS) }
        for (call in listOf<suspend (FlowClient) -> Any>({ it.me() }, { it.teams(SINCE) })) {
            calls = 0
            assertEquals("AUTHENTICATION_FAILED", assertFailsWith<FetchException> { call(client(engine, maxRetries = 3)) }.code)
            assertEquals(1, calls, "a revoked or expired token is not retried")
        }
    }

    @Test
    fun `a 404 is NOT_FOUND - a Flow older than the integration API`() = runBlocking {
        assertEquals("NOT_FOUND", assertFailsWith<FetchException> { client(answering(HttpStatusCode.NotFound)).me() }.code)
    }

    @Test
    fun `a 500 is an outage - retried with backoff, then UPSTREAM_UNAVAILABLE, never AUTHENTICATION_FAILED`() = runBlocking {
        var calls = 0
        val engine = MockEngine { calls++; respond("{}", HttpStatusCode.InternalServerError, JSON_HEADERS) }
        val error = assertFailsWith<FetchException> { client(engine, maxRetries = 2).teams(SINCE) }
        assertEquals("UPSTREAM_UNAVAILABLE", error.code)
        assertEquals(3, calls, "the initial attempt plus 2 retries")
    }

    @Test
    fun `a 429 is retried and then RATE_LIMITED`() = runBlocking {
        var calls = 0
        val engine = MockEngine { calls++; respond("{}", HttpStatusCode.TooManyRequests, JSON_HEADERS) }
        assertEquals("RATE_LIMITED", assertFailsWith<FetchException> { client(engine, maxRetries = 2).me() }.code)
        assertEquals(3, calls)
    }

    @Test
    fun `a successful retry after an outage returns the document`() = runBlocking {
        var calls = 0
        val engine = MockEngine {
            if (++calls == 1) {
                respond("{}", HttpStatusCode.InternalServerError, JSON_HEADERS)
            } else {
                respond(ME, HttpStatusCode.OK, JSON_HEADERS)
            }
        }
        assertEquals("astrolabe", client(engine, maxRetries = 2).me().name)
        assertEquals(2, calls)
    }

    @Test
    fun `a redirect is REDIRECT and is never followed`() = runBlocking {
        val seen = CopyOnWriteArrayList<String>()
        val engine = MockEngine {
            seen += it.url.host
            respond("", HttpStatusCode.Found, headersOf(HttpHeaders.Location, "https://evil.example/steal"))
        }
        assertEquals("REDIRECT", assertFailsWith<FetchException> { client(engine, maxRetries = 3).me() }.code)
        assertEquals(listOf("flow.test"), seen.toList(), "one request, and the Location was never requested")
    }

    @Test
    fun `a response over the byte cap is LIMIT_EXCEEDED`() = runBlocking {
        val engine = MockEngine { respond(teamsBody(), HttpStatusCode.OK, JSON_HEADERS) }
        val http = flowHttp(engine, maxResponseBytes = 100)
        val error = assertFailsWith<FetchException> { HttpFlowClient(http, ORIGIN, flowToken()).teams(SINCE) }
        assertEquals("LIMIT_EXCEEDED", error.code)
    }

    // --- the decode ---

    @Test
    fun `sprintsTruncated and teamsTruncated true are carried through`() = runBlocking {
        val sprints = client(answering(HttpStatusCode.OK, teamsBody(truncated = true))).teams(SINCE)
        assertTrue(sprints.sprintsTruncated)
        assertFalse(sprints.teamsTruncated)
        val teams = client(answering(HttpStatusCode.OK, teamsBody(teamsTruncated = true))).teams(SINCE)
        assertTrue(teams.teamsTruncated)
        assertFalse(teams.sprintsTruncated)
        assertEquals(2_000, FLOW_SPRINT_CAP, "the caps the real server applies")
        assertEquals(1_000, FLOW_TEAM_CAP)
    }

    @Test
    fun `members this client does not read are ignored, at every level`() = runBlocking {
        val team = TEAM.replaceFirst("{", """{"futureTeamField":{"a":[1,2]},""")
            .replace(MEMBER, MEMBER.replaceFirst("{", """{"email":"x@example.com","extra":1,"""))
            .replace(SPRINT, SPRINT.replaceFirst("{", """{"coefficient":0.8,"""))
        val body = """{"newTop":true,$HEAD"items":[$team]}"""
        val document = client(answering(HttpStatusCode.OK, body)).teams(SINCE)
        assertEquals("Alpha", document.items.single().name)
        assertEquals(42, document.items.single().sprints.single().sprintId)
        val me = client(answering(HttpStatusCode.OK, """{"tokenId":1,"name":"n","createdAt":2,"novelty":"y"}""")).me()
        assertEquals(FlowMe(1, "n", 2, null, null), me)
    }

    @Test
    fun `a null Flow omits decodes like one it sends, and an unknown state or capacity source is kept as text`() = runBlocking {
        val bare = """{"id":9,"name":"Bare","members":[],"sprints":[]}"""
        val sprint = """{"sprintId":1,"connectionId":1,"name":"s","state":"SOMETHING_NEW","hasCalendar":false,
            |"capacitySource":"NEW_SOURCE"}""".trimMargin().replace("\n", "")
        val withSprint = """{"id":10,"name":"WithSprint","members":[{"accountId":"a","validFrom":1}],"sprints":[$sprint]}"""
        val body = """{"asOf":1,"sprintsSince":"2026-01-05","teamsTruncated":false,"sprintsTruncated":false,"items":[$bare,$withSprint]}"""
        val document = client(answering(HttpStatusCode.OK, body)).teams(SINCE)
        val (first, second) = document.items
        assertEquals(emptyList(), first.members)
        assertEquals(emptyList(), first.sprints)
        assertNull(first.defaultCapacityMd)
        val row = second.sprints.single()
        assertEquals("SOMETHING_NEW", row.state)
        assertEquals("NEW_SOURCE", row.capacitySource)
        assertNull(row.startAt)
        assertNull(row.capacityMd)
        assertNull(second.members.single().displayName)
        assertNull(second.members.single().validTo)
    }

    @Test
    fun `a missing list or flag is drift, not empty or false - INVALID_RESPONSE`() = runBlocking {
        fun doc(team: String = """{"id":1,"name":"x","members":[],"sprints":[]}""", head: String = HEAD) = """{$head"items":[$team]}"""
        val cases = mapOf(
            "a team without sprints" to doc(team = """{"id":1,"name":"x","members":[]}"""),
            "a team without members" to doc(team = """{"id":1,"name":"x","sprints":[]}"""),
            "a document without sprintsTruncated" to doc(head = """"asOf":1,"sprintsSince":"2026-01-05","teamsTruncated":false,"""),
            "a document without teamsTruncated" to doc(head = """"asOf":1,"sprintsSince":"2026-01-05","sprintsTruncated":false,"""),
            "a document without sprintsSince" to doc(head = """"asOf":1,"teamsTruncated":false,"sprintsTruncated":false,"""),
            "a document with a null sprintsSince" to doc(
                head = """"asOf":1,"sprintsSince":null,"teamsTruncated":false,"sprintsTruncated":false,""",
            ),
            "a sprint without hasCalendar" to doc(
                team = """{"id":1,"name":"x","members":[],"sprints":[{"sprintId":1,"connectionId":1,"name":"s","state":"closed"}]}""",
            ),
        )
        for ((label, body) in cases) {
            val error = assertFailsWith<FetchException>(label) { client(answering(HttpStatusCode.OK, body)).teams(SINCE) }
            assertEquals("INVALID_RESPONSE", error.code, label)
        }
        // The control: the complete document decodes.
        assertEquals(1, client(answering(HttpStatusCode.OK, doc())).teams(SINCE).items.size)
    }

    @Test
    fun `a body that is not the contract is INVALID_RESPONSE, with the path and no query or value in the message`() = runBlocking {
        val bodies = listOf(
            "{ not json", "[]", "null", "\"text\"", "<html>502</html>",
            """{"asOf":1}""", // items missing
            """{"asOf":1,"items":[{"name":"No id"}]}""", // a required member of a team missing
            """{"asOf":1,"items":[{"id":"five","name":"x"}]}""", // mistyped
            """{"asOf":1,"items":[{"id":1,"name":"x","sprints":[{"sprintId":1}]}]}""", // a sprint without its required members
            """{"asOf":1,"items":[{"id":1,"name":"x","members":[{"displayName":"no account","validFrom":1}]}]}""",
        )
        for (body in bodies) {
            val error = assertFailsWith<FetchException>(body) { client(answering(HttpStatusCode.OK, body)).teams(SINCE) }
            assertEquals("INVALID_RESPONSE", error.code, body)
            val message = error.message.orEmpty()
            assertTrue("/api/v1/integration/teams" in message || error.endpoint == null, message)
            assertFalse("sprintsSince" in message || "2026-01-05" in message, "no query string in a message: $message")
            assertFalse("no account" in message, "no response value in a message: $message")
        }
        val me = assertFailsWith<FetchException> { client(answering(HttpStatusCode.OK, """{"name":"x"}""")).me() }
        assertEquals("INVALID_RESPONSE", me.code)
    }

    // --- the token never travels outside the Authorization header ---

    @Test
    fun `no failure message, toString or URL carries the token`() = runBlocking {
        val token = flowToken('z')
        val urls = CopyOnWriteArrayList<String>()
        val statuses = listOf(
            HttpStatusCode.Unauthorized, HttpStatusCode.NotFound, HttpStatusCode.InternalServerError, HttpStatusCode.Found,
        )
        for (status in statuses) {
            val engine = MockEngine { urls += it.url.toString(); respond("{}", status, JSON_HEADERS) }
            val failure = assertFailsWith<FetchException> { client(engine, token).teams(SINCE) }
            assertFalse(token in failure.message.orEmpty() || token in failure.toString(), "${status.value}: ${failure.message}")
        }
        assertTrue(urls.none { token in it })
        assertFalse(token in client(answering(HttpStatusCode.OK), token).toString())
    }

    // --- the stub's documents, through the real guarded client ---

    @Test
    fun `the stub's me and teams documents decode and equal the generator's expected figures`() = runBlocking {
        val port = URI(FlowStubServer.baseUrl).port
        val origins = FlowOrigins(SelfManagedHosts.NONE, setOf(Origin("http", "localhost", port)), developmentMode = true)
        val guarded = buildGuardedFlowHttpClient(origins, requestTimeoutSeconds = 10)
        try {
            val flow = HttpFlowClient(createFlowHttp(guarded, 0, 1024L * 1024, 1), FlowStubServer.baseUrl, FlowStubServer.token)
            val expected = FlowStubServer.expected
            val me = flow.me()
            val expectedMe = expected.getValue("me").jsonObject
            assertEquals(expectedMe.getValue("tokenId").jsonPrimitive.content.toInt(), me.tokenId)
            assertEquals(expectedMe.getValue("name").jsonPrimitive.content, me.name)
            assertEquals(expectedMe.getValue("createdAt").jsonPrimitive.content.toLong(), me.createdAt)
            assertNull(me.expiresAt)
            assertNull(me.lastUsedAt)

            val document = flow.teams(LocalDate.parse(FlowStubServer.sinceDate))
            assertDocumentEqualsExpected(document, expected)
        } finally {
            guarded.close()
        }
    }

    private fun assertDocumentEqualsExpected(document: FlowTeamsDocument, expected: JsonObject) {
        val header = expected.getValue("document").jsonObject
        assertEquals(header.getValue("asOf").jsonPrimitive.content.toLong(), document.asOf)
        assertEquals(header.getValue("sprintsSince").jsonPrimitive.content, document.sprintsSince)
        assertEquals(header.getValue("teamsTruncated").jsonPrimitive.content.toBoolean(), document.teamsTruncated)
        assertEquals(header.getValue("sprintsTruncated").jsonPrimitive.content.toBoolean(), document.sprintsTruncated)
        val totals = expected.getValue("totals").jsonObject
        assertEquals(totals.getValue("teams").jsonPrimitive.content.toInt(), document.items.size)
        assertEquals(totals.getValue("sprints").jsonPrimitive.content.toInt(), document.items.sumOf { it.sprints.size })
        assertEquals(totals.getValue("memberRows").jsonPrimitive.content.toInt(), document.items.sumOf { it.members.size })
        val planned = expected.getValue("teams").jsonArray.map { it.jsonObject }
        assertEquals(planned.map { it.str("name") }, document.items.map { it.name })
        for ((team, plan) in document.items.zip(planned)) {
            assertEquals(plan.getValue("id").jsonPrimitive.content.toInt(), team.id, team.name)
            assertEquals(plan.nullableStr("managerName"), team.managerName, team.name)
            assertEquals(plan.nullableStr("defaultCapacityMd")?.toDouble(), team.defaultCapacityMd, team.name)
            val members = plan.getValue("members").jsonObject
            assertEquals(members.int("rows"), team.members.size, team.name)
            assertEquals(members.int("open"), team.members.count { it.validTo == null }, team.name)
            assertEquals(members.int("closed"), team.members.count { it.validTo != null }, team.name)
            val sprints = plan.getValue("sprints").jsonObject
            assertEquals(sprints.int("count"), team.sprints.size, team.name)
            for (state in listOf("closed", "active", "future")) {
                assertEquals(sprints.int(state), team.sprints.count { it.state == state }, "${team.name} $state")
            }
            assertEquals(sprints.int("noCapacity"), team.sprints.count { it.capacityMd == null }, team.name)
            assertEquals(sprints.int("noDates"), team.sprints.count { it.startAt == null && it.endAt == null }, team.name)
            assertEquals(sprints.int("teamDefault"), team.sprints.count { it.capacitySource == "TEAM_DEFAULT" }, team.name)
        }
        // The e2e team's sprints, figure for figure.
        val e2e = expected.getValue("e2e").jsonObject
        val team = assertNotNull(document.items.firstOrNull { it.name == e2e.str("team") })
        val rows = e2e.getValue("preview").jsonArray.map { it.jsonObject }
        assertEquals(rows.size, team.sprints.size)
        for ((sprint, row) in team.sprints.zip(rows)) {
            assertEquals(row.getValue("sprintId").jsonPrimitive.content.toLong(), sprint.sprintId)
            assertEquals(row.str("name"), sprint.name)
        }
        // The vocabulary the mirror and the import rely on.
        val sources = expected.getValue("contract").jsonObject.getValue("capacitySources").jsonArray.map { it.jsonPrimitive.content }
        assertTrue(document.items.flatMap { it.sprints }.mapNotNull { it.capacitySource }.all { it in sources })
    }

    private fun JsonObject.str(key: String): String = getValue(key).jsonPrimitive.content
    private fun JsonObject.int(key: String): Int = getValue(key).jsonPrimitive.content.toInt()
    private fun JsonObject.nullableStr(key: String): String? = getValue(key).let { if (it is JsonNull) null else it.jsonPrimitive.content }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            FlowStubFixture.warm()
        }
    }
}
