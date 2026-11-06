package ch.nokillswit

import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.jira.JiraAuthScheme
import ch.nokillswit.jira.JiraConnectionRequest
import ch.nokillswit.jira.JiraConnectionResponse
import ch.nokillswit.jira.JiraConnectionServiceKey
import ch.nokillswit.jira.JiraDiscovery
import ch.nokillswit.jira.JiraTestResult
import ch.nokillswit.jira.TestRecording
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.users.UserRole
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.notMatching
import com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching
import com.github.tomakehurst.wiremock.http.Fault
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import org.junit.BeforeClass
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST /api/v1/integrations/jira/connections/test` and `.../{id}/test`, and `GET .../{id}/discovery`, against the shared [JiraStubServer]
 * (the exact `sample-data/jira-stub` contract). A note for anyone debugging a surprising `401` here: a request SHAPE the stub has
 * no mapping
 * for falls to its auth catch-all and reads as a 401 (`sample-data/jira/README.md`), so "401 on `search`" can mean an unmatched shape.
 * Connections are SHARED suite state: every test mints UNIQUE names.
 */
class JiraTestConnectionTest {
    private val base = "/api/v1/integrations/jira/connections"
    private val json = Json { ignoreUnknownKeys = true }
    private val required = listOf("tenant_info", "myself", "issuetype", "search", "field", "projects", "project:E2E", "issue")

    private fun name(prefix: String) = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

    private fun newToken() = "JTOK-${UUID.randomUUID()}"

    private fun request(
        token: String? = newToken(),
        keys: List<String> = listOf("E2E"),
        scheme: JiraAuthScheme = JiraAuthScheme.BASIC,
        site: String = "https://sample.atlassian.net",
    ) = JiraConnectionRequest(name("conn"), site, "jira.user@example.test", token, scheme, keys, true)

    /** The app against the in-JVM stub; [retries] 0 so a deliberately failing probe does not sleep through real backoff. */
    private suspend fun ApplicationTestBuilder.start(vararg extra: Pair<String, String>) {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0", *extra)
        startApplication()
    }

    private suspend fun HttpResponse.result(): JiraTestResult = json.decodeFromString(bodyAsText())

    private suspend fun HttpClient.create(request: JiraConnectionRequest): JiraConnectionResponse {
        val response = postJson(base, request)
        assertEquals(HttpStatusCode.Created, response.status)
        return json.decodeFromString(response.bodyAsText())
    }

    private suspend fun HttpClient.connection(id: UInt): JiraConnectionResponse = json.decodeFromString(get("$base/$id").bodyAsText())

    private fun sql(statement: String, vararg params: Any) = PostgresTestSupport.connect().use { connection ->
        connection.prepareStatement(statement).use { st ->
            params.forEachIndexed { i, p -> st.setObject(i + 1, p) }
            st.executeUpdate()
        }
    }

    private inline fun <T> withOverride(stub: com.github.tomakehurst.wiremock.client.MappingBuilder, block: () -> T): T {
        val mapping = JiraStubServer.addOverride(stub)
        try {
            return block()
        } finally {
            JiraStubServer.removeOverride(mapping)
        }
    }

    private fun path(suffix: String) = urlPathMatching(".*/rest/api/3/$suffix")

    @Test
    fun `ad-hoc test - every required row is ok against the stub, in order, with hints, and nothing is stored`() = testApplication {
        start()
        val admin = seededClient("jtest", UserRole.ADMIN)
        val response = admin.postJson("$base/test", request())
        assertEquals(HttpStatusCode.OK, response.status)
        val result = response.result()
        assertEquals(JiraStubServer.CLOUD_ID, result.cloudId)
        assertEquals(required, result.rows.map { it.name })
        assertTrue(result.rows.all { it.ok && it.required && it.code == null }, "${result.rows}")
        assertTrue(result.passed)
        assertNull(result.discoveredAt, "an ad-hoc test stores nothing, so no discovery")
        assertFalse(result.recorded)
        val hints = result.rows.associate { it.name to it.scopeHint }
        assertEquals(
            mapOf(
                "tenant_info" to null, "myself" to "read:jira-user", "issuetype" to "read:issue-type:jira", "search" to "read:jql:jira",
                "field" to "read:field:jira", "projects" to "read:project:jira", "project:E2E" to "read:project:jira",
                "issue" to "read:issue-details:jira",
            ),
            hints,
        )
    }

    @Test
    fun `both auth schemes pass against the stub, and the scope with several keys gets one project row each`() = testApplication {
        start()
        val admin = seededClient("jtestkeys", UserRole.ADMIN)
        val bearer = admin.postJson("$base/test", request(scheme = JiraAuthScheme.BEARER)).result()
        assertTrue(bearer.passed, "${bearer.rows}")
        val all = admin.postJson("$base/test", request(keys = listOf("CE", "PF", "CG", "DI", "OE", "E2E"))).result()
        assertTrue(all.passed, "${all.rows}")
        val projectRows = all.rows.filter { it.name.startsWith("project:") }.map { it.name.removePrefix("project:") }
        assertEquals(listOf("CE", "PF", "CG", "DI", "OE", "E2E"), projectRows)
    }

    @Test
    fun `the search probe sends the real issuetype clause (assumption A3)`() = testApplication {
        start()
        val admin = seededClient("jtesta3", UserRole.ADMIN)
        // Anything but the Epic type id (10004) in the clause is refused: a client that dropped the clause would fail its search row.
        val withoutClause = get(path("search/jql")).atPriority(1).withQueryParam("jql", notMatching(".*issuetype in \\(10004\\).*"))
        withOverride(withoutClause.willReturn(aResponse().withStatus(403))) {
            val result = admin.postJson("$base/test", request()).result()
            assertTrue(result.passed, "${result.rows}")
        }
    }

    @Test
    fun `a wrong token fails every authenticated probe with its hint, tenant_info stays ok, and the answer is a 200`() = testApplication {
        start()
        val admin = seededClient("jtestwrong", UserRole.ADMIN)
        val response = admin.postJson("$base/test", request(token = "wrong-token"))
        assertEquals(HttpStatusCode.OK, response.status, "a failed probe is a row, never a 4xx/5xx")
        val result = response.result()
        assertFalse(result.passed)
        assertTrue(result.rows.first { it.name == "tenant_info" }.ok)
        val failed = result.rows.filter { !it.ok }
        assertEquals(listOf("myself", "issuetype", "search", "field", "projects"), failed.map { it.name })
        assertTrue(failed.all { it.code == "AUTHENTICATION_FAILED" && it.status == 401 }, "$failed")
        assertEquals("read:jql:jira", failed.first { it.name == "search" }.scopeHint)
        assertTrue(
            result.rows.none { it.name == "issue" || it.name.startsWith("project:") },
            "probes that depend on a failed one do not run",
        )
    }

    @Test
    fun `a 401 on one probe while myself passes is a failed row with its hint, and the rest still run`() = testApplication {
        start()
        val admin = seededClient("jtest401", UserRole.ADMIN)
        withOverride(get(path("field")).atPriority(1).willReturn(aResponse().withStatus(401))) {
            val result = admin.postJson("$base/test", request()).result()
            assertFalse(result.passed)
            assertTrue(result.rows.first { it.name == "myself" }.ok)
            val field = result.rows.first { it.name == "field" }
            assertEquals(Triple(false, "AUTHENTICATION_FAILED", "read:field:jira"), Triple(field.ok, field.code, field.scopeHint))
            assertEquals(listOf("field"), result.rows.filter { !it.ok }.map { it.name })
        }
    }

    @Test
    fun `a 403 is FORBIDDEN_SCOPE, and a refused issuetype read lets the search probe fall back to the plain scope`() = testApplication {
        start()
        val admin = seededClient("jtest403", UserRole.ADMIN)
        withOverride(get(path("issuetype")).atPriority(1).willReturn(aResponse().withStatus(403))) {
            val result = admin.postJson("$base/test", request()).result()
            assertEquals("FORBIDDEN_SCOPE", result.rows.first { it.name == "issuetype" }.code)
            assertTrue(result.rows.first { it.name == "search" }.ok, "no type ids to narrow by, so the plain scope is asked")
            assertEquals(listOf("issuetype"), result.rows.filter { !it.ok }.map { it.name })
        }
    }

    @Test
    fun `an outage, a reset, a redirect, garbage and an id that is not JQL-safe are rows, never a 502 or a 500`() = testApplication {
        start()
        val admin = seededClient("jtestnever", UserRole.ADMIN)
        val cases = listOf(
            "UPSTREAM_UNAVAILABLE" to aResponse().withStatus(503),
            "UPSTREAM_UNAVAILABLE" to aResponse().withFault(Fault.CONNECTION_RESET_BY_PEER),
            "REDIRECT" to aResponse().withStatus(302).withHeader("Location", "https://evil.example/"),
            "INVALID_RESPONSE" to aResponse().withStatus(200).withBody("{ not json"),
            "INVALID_RESPONSE" to aResponse().withStatus(200).withBody("[]"),
        )
        for ((code, answer) in cases) {
            withOverride(get(path("myself")).atPriority(1).willReturn(answer)) {
                val response = admin.postJson("$base/test", request())
                assertEquals(HttpStatusCode.OK, response.status)
                assertEquals(code, response.result().rows.first { it.name == "myself" }.code)
            }
        }
        // An issue type whose id is not digits reaches JiraJql.scopeAndTypes, which refuses it with an IllegalArgumentException:
        // reported as the one malformed probe, not a crashed test.
        val types = """[{"id":"x) OR project = Y","name":"Epic","subtask":false,"hierarchyLevel":1}]"""
        withOverride(get(path("issuetype")).atPriority(1).willReturn(aResponse().withStatus(200).withBody(types))) {
            val response = admin.postJson("$base/test", request())
            assertEquals(HttpStatusCode.OK, response.status)
            assertEquals("INVALID_RESPONSE", response.result().rows.first { it.name == "search" }.code)
        }
    }

    @Test
    fun `a configured key the token cannot see is a failed required project row`() = testApplication {
        start()
        val admin = seededClient("jtestkey", UserRole.ADMIN)
        val body = """{"startAt":0,"maxResults":50,"total":1,"isLast":true,"values":[{"key":"E2E"}]}"""
        withOverride(get(path("project/search")).atPriority(1).willReturn(aResponse().withStatus(200).withBody(body))) {
            val result = admin.postJson("$base/test", request(keys = listOf("E2E", "CE"))).result()
            val rows = result.rows.filter { it.name.startsWith("project:") }
            assertEquals(listOf("project:E2E" to true, "project:CE" to false), rows.map { it.name to it.ok })
            assertEquals("PROJECT_NOT_VISIBLE", rows.last().code)
            assertFalse(result.passed)
        }
    }

    @Test
    fun `invalid ad-hoc payloads are 400, and a non-admin is 403 before the body decodes on every route`() = testApplication {
        start()
        val admin = seededClient("jtestbad", UserRole.ADMIN)
        val user = seededClient("jtestuser", UserRole.USER)
        val invalid = listOf(
            request(token = null), request(site = "https://example.com"), request(keys = emptyList()), request(keys = listOf("e2e")),
        )
        for (bad in invalid) {
            assertEquals(HttpStatusCode.BadRequest, admin.postJson("$base/test", bad).status)
        }
        val malformed: io.ktor.client.request.HttpRequestBuilder.() -> Unit = {
            contentType(ContentType.Application.Json)
            setBody("{ not json")
        }
        assertEquals(HttpStatusCode.BadRequest, admin.post("$base/test", malformed).status)
        assertEquals(HttpStatusCode.Forbidden, user.post("$base/test", malformed).status, "the guard runs before the body decodes")
        assertEquals(HttpStatusCode.Forbidden, user.postJson("$base/test", request()).status)
        assertEquals(HttpStatusCode.Forbidden, user.post("$base/999999/test").status)
        assertEquals(HttpStatusCode.Forbidden, user.get("$base/999999/discovery").status)
    }

    @Test
    fun `the stored variant is 404 for an unknown or deleted id`() = testApplication {
        start()
        val admin = seededClient("jtest404", UserRole.ADMIN)
        assertEquals(HttpStatusCode.NotFound, admin.post("$base/999999/test").status)
        assertEquals(HttpStatusCode.NotFound, admin.get("$base/999999/discovery").status)
        val created = admin.create(request())
        admin.delete("$base/${created.id}")
        assertEquals(HttpStatusCode.NotFound, admin.post("$base/${created.id}/test").status)
        assertEquals(HttpStatusCode.NotFound, admin.get("$base/${created.id}/discovery").status)
    }

    @Test
    fun `the stored variant uses the stored token and persists the cloud id, the verdict and the discovery`() = testApplication {
        start()
        val admin = seededClient("jtestpersist", UserRole.ADMIN)
        val created = admin.create(request())
        assertEquals(
            listOf(null, null, null, null),
            listOf(created.cloudId, created.lastTestedAt, created.lastTestOk, created.discoveredAt),
        )
        val notYet = admin.get("$base/${created.id}/discovery")
        assertEquals(HttpStatusCode.Conflict, notYet.status)
        assertEquals("urn:astrolabe:problem:jira-not-discovered", notYet.body<ProblemDetail>().type)

        val before = System.currentTimeMillis()
        val response = admin.post("$base/${created.id}/test")
        assertEquals(HttpStatusCode.OK, response.status)
        val result = response.result()
        assertTrue(result.passed, "${result.rows}")
        assertNotNull(result.discoveredAt)
        assertTrue(result.recorded)
        val stored = admin.connection(created.id)
        assertEquals(JiraStubServer.CLOUD_ID, stored.cloudId)
        assertEquals(true, stored.lastTestOk)
        assertTrue(stored.lastTestedAt!! >= before)
        assertEquals(result.discoveredAt, stored.discoveredAt)
        assertEquals(created.updatedAt, stored.updatedAt, "recording a test is not an edit of the connection")

        val discovery = json.decodeFromString<JiraDiscovery>(admin.get("$base/${created.id}/discovery").bodyAsText())
        assertEquals(60, discovery.fieldCount)
        assertFalse(discovery.fieldsTruncated)
        assertEquals(7, discovery.issueTypeCount)
        assertEquals(listOf(0, 1, 2, 3), discovery.levels.map { it.level })
        assertEquals(listOf("Epic"), discovery.levels.first { it.level == 1 }.typeNames)
        val m = discovery.markers
        assertEquals(
            listOf(
                "customfield_10022", "customfield_10023", "customfield_10015", "duedate",
                "customfield_10026", "customfield_10001", "customfield_10014", "customfield_10018",
            ),
            listOf(m.targetStart, m.targetEnd, m.startDate, m.dueDate, m.storyPoints, m.team, m.legacyEpicLink, m.legacyParentLink)
                .map { it?.id },
        )
        assertEquals("com.atlassian.jpo:jpo-custom-field-baseline-start", m.targetStart?.custom)
        assertTrue(discovery.fields.size <= 2000 && discovery.fields.none { it.id == "summary" })
    }

    @Test
    fun `a failed search row still stores the discovery, with the real verdict - and the discovery is readable`() = testApplication {
        start()
        val admin = seededClient("jtestfail", UserRole.ADMIN)
        val created = admin.create(request())
        assertEquals(HttpStatusCode.Conflict, admin.get("$base/${created.id}/discovery").status)
        withOverride(get(path("search/jql")).atPriority(1).willReturn(aResponse().withStatus(403))) {
            val failed = admin.post("$base/${created.id}/test").result()
            assertFalse(failed.passed)
            assertEquals(listOf("search"), failed.rows.filter { !it.ok }.map { it.name })
            assertNotNull(failed.discoveredAt, "field and issuetype answered, so the snapshot is stored")
            assertTrue(failed.recorded)
        }
        val stored = admin.connection(created.id)
        assertEquals(false, stored.lastTestOk, "the verdict is the real one")
        assertEquals(JiraStubServer.CLOUD_ID, stored.cloudId)
        assertNotNull(stored.discoveredAt)
        val discovery = admin.get("$base/${created.id}/discovery")
        assertEquals(HttpStatusCode.OK, discovery.status)
        assertEquals(stored.discoveredAt, json.decodeFromString<JiraDiscovery>(discovery.bodyAsText()).discoveredAt)
    }

    @Test
    fun `a test whose field probe fails leaves the earlier discovery in place and answers its discoveredAt`() = testApplication {
        start()
        val admin = seededClient("jtestkeep", UserRole.ADMIN)
        val created = admin.create(request())
        assertTrue(admin.post("$base/${created.id}/test").result().passed)
        val first = admin.connection(created.id).discoveredAt
        withOverride(get(path("field")).atPriority(1).willReturn(aResponse().withStatus(401))) {
            val failed = admin.post("$base/${created.id}/test").result()
            assertFalse(failed.passed)
            assertEquals(first, failed.discoveredAt, "the stored snapshot, not null")
        }
        val stored = admin.connection(created.id)
        assertEquals(false, stored.lastTestOk)
        assertEquals(first, stored.discoveredAt)
    }

    @Test
    fun `a tenant_info failure cascades to NOT_FOUND rows, resolves no cloud id and keeps the one stored earlier`() = testApplication {
        start()
        val admin = seededClient("jtestcloud", UserRole.ADMIN)
        val created = admin.create(request())
        assertTrue(admin.post("$base/${created.id}/test").result().passed)
        withOverride(get(urlPathMatching("/_edge/tenant_info")).atPriority(1).willReturn(aResponse().withStatus(404))) {
            val response = admin.post("$base/${created.id}/test")
            assertEquals(HttpStatusCode.OK, response.status)
            val result = response.result()
            assertNull(result.cloudId)
            val rows = result.rows.associateBy { it.name }
            assertEquals(Pair("NOT_FOUND", 404), rows.getValue("tenant_info").let { it.code to it.status })
            assertEquals(listOf("tenant_info", "myself", "issuetype", "search", "field", "projects"), result.rows.map { it.name })
            assertTrue(result.rows.all { !it.ok && it.code == "NOT_FOUND" }, "${result.rows}")
        }
        val stored = admin.connection(created.id)
        assertEquals(false, stored.lastTestOk)
        assertEquals(JiraStubServer.CLOUD_ID, stored.cloudId, "a failed lookup does not erase the cloud id")
    }

    @Test
    fun `a changed token, account, auth scheme or key set clears the last verdict - a rename or a pause does not`() = testApplication {
        start()
        val admin = seededClient("jtestrotate", UserRole.ADMIN)
        val created = admin.create(request())
        suspend fun tested(): JiraConnectionResponse {
            assertEquals(HttpStatusCode.OK, admin.post("$base/${created.id}/test").status)
            return admin.connection(created.id).also { assertEquals(true, it.lastTestOk) }
        }
        val first = tested()
        fun same() = request(token = null).copy(name = created.name)
        // Unchanged scope: the verdict stays.
        admin.putJson("$base/${created.id}", same())
        admin.putJson("$base/${created.id}", same().copy(name = name("renamed"), enabled = false))
        assertEquals(true, admin.connection(created.id).lastTestOk)
        val changes = mapOf(
            "the token" to request(token = newToken()).copy(name = created.name),
            "the account" to same().copy(email = "other.user@example.test"),
            "the auth scheme" to same().copy(authScheme = JiraAuthScheme.BEARER),
            "the project keys" to same().copy(projectKeys = listOf("E2E", "CE")),
        )
        for ((what, change) in changes) {
            admin.putJson("$base/${created.id}", same()) // back to the baseline, so each change is judged on its own
            val before = tested()
            admin.putJson("$base/${created.id}", change)
            val after = admin.connection(created.id)
            assertEquals(listOf(null, null), listOf(after.lastTestedAt, after.lastTestOk), "changing $what clears the verdict")
            assertEquals(first.cloudId, after.cloudId)
            assertEquals(before.discoveredAt, after.discoveredAt, "the discovery describes the site and stays")
        }
    }

    @Test
    fun `a test racing an edit of the connection records nothing`() = testApplication {
        start()
        val admin = seededClient("jtestrace", UserRole.ADMIN)
        val created = admin.create(request())
        val service = application.attributes[JiraConnectionServiceKey]
        val target = assertNotNull(service.readForTest(created.id))
        admin.putJson("$base/${created.id}", request(token = newToken()).copy(name = created.name))
        val recording = service.recordTest(created.id, checkNotNull(target.expectedUpdatedAt), JiraStubServer.CLOUD_ID, true, null, 1L)
        assertEquals(TestRecording(false, null), recording)
        assertEquals(listOf(null, null), admin.connection(created.id).let { listOf(it.lastTestOk, it.cloudId) })
    }

    @Test
    fun `a stored token that cannot be decrypted is one typed row, a 200, never a 500, and nothing leaks`() = testApplication {
        start()
        val adminEmail = uniqueEmail("jtestaead")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(adminEmail, "pw")
        val created = admin.create(request())
        // An envelope sealed under ANOTHER key: what a compose/`:server:run` key mismatch over one Postgres leaves behind.
        val foreign = FieldCipher(strongEncryptionKey()).encrypt("never-seen-token")
        sql("UPDATE jira_connections SET api_token = ? WHERE id = ?", foreign, created.id.toInt())
        val root = LogCapture("ROOT")
        try {
            withAuditCapture { audit ->
                val response = admin.post("$base/${created.id}/test")
                assertEquals(HttpStatusCode.OK, response.status)
                val result = response.result()
                val row = result.rows.single()
                assertEquals(Triple("stored_token", false, "TOKEN_UNREADABLE"), Triple(row.name, row.ok, row.code))
                assertTrue(row.required)
                assertNull(result.cloudId)
                assertEquals(false, admin.connection(created.id).lastTestOk)
                val event = audit.awaitEvent {
                    it.message == "jira.connection_tested" && it.hasKeyValue("connectionId", created.id.toLong())
                }
                assertNotNull(event)
                assertTrue(event.hasKeyValue("byUserId", adminId.toLong()) && event.hasKeyValue("ok", false))
                assertTrue(event.hasKeyValue("failedProbes", listOf("stored_token")))
            }
            assertTrue(root.events.any { it.formattedMessage.contains("cannot be decrypted") }, "the failure is logged for the operator")
            assertTrue(
                root.events.none { foreign in it.formattedMessage || "enc:v1:" in it.formattedMessage },
                "the envelope is never logged",
            )
        } finally {
            root.detach()
        }
    }

    @Test
    fun `a stored site that is no longer a genuine tenant is refused before any request`() = testApplication {
        start()
        val admin = seededClient("jtestsite", UserRole.ADMIN)
        val sites = listOf(
            "https://evil.example.com", "https://api.atlassian.net", "http://sample.atlassian.net", "https://sample.atlassian.net/x",
        )
        for (site in sites) {
            val created = admin.create(request())
            sql("UPDATE jira_connections SET site_url = ? WHERE id = ?", site, created.id.toInt())
            val row = admin.post("$base/${created.id}/test").result().rows.single()
            assertEquals(Triple("tenant_info", false, "BLOCKED_HOST"), Triple(row.name, row.ok, row.code), site)
        }
    }

    @Test
    fun `the 11th test within a minute from one address is 429 on the shared bucket`() = testApplication {
        start()
        val admin = seededClient("jtestrate", UserRole.ADMIN)
        repeat(10) { assertEquals(HttpStatusCode.NotFound, admin.post("$base/999999/test").status) }
        assertEquals(HttpStatusCode.TooManyRequests, admin.post("$base/999999/test").status)
        val adHoc = admin.postJson("$base/test", request())
        assertEquals(HttpStatusCode.TooManyRequests, adHoc.status, "the ad-hoc route rides the same bucket")
    }

    @Test
    fun `a test audits the host, the verdict and the failed probe names - and no log line anywhere carries the token`() = testApplication {
        start()
        val adminEmail = uniqueEmail("jtestaudit")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(adminEmail, "pw")
        val token = newToken()
        val basic = java.util.Base64.getEncoder().encodeToString("jira.user@example.test:$token".toByteArray())
        val root = LogCapture("ROOT")
        try {
            withAuditCapture { audit ->
                admin.postJson("$base/test", request(token = token))
                val adHoc = audit.awaitEvent { it.message == "jira.connection_tested" && it.hasKeyValue("ok", true) }
                assertNotNull(adHoc, "an ad-hoc test audits")
                assertTrue(adHoc.hasKeyValue("byUserId", adminId.toLong()) && adHoc.hasKeyValue("host", "sample.atlassian.net"))
                assertTrue(adHoc.hasKeyValue("connectionId", null) && adHoc.hasKeyValue("failedProbes", emptyList<String>()))

                val created = admin.create(request(token = token))
                withOverride(get(path("field")).atPriority(1).willReturn(aResponse().withStatus(401))) {
                    admin.post("$base/${created.id}/test")
                }
                val stored = audit.awaitEvent {
                    it.message == "jira.connection_tested" && it.hasKeyValue("connectionId", created.id.toLong())
                }
                assertNotNull(stored)
                assertTrue(stored.hasKeyValue("ok", false) && stored.hasKeyValue("failedProbes", listOf("field")))
                admin.postJson("$base/test", request(token = "wrong-token"))
                assertEquals(3, audit.events.count { it.message == "jira.connection_tested" }, "one event per test")
            }
            val leaks = root.events.filter { event ->
                listOf(token, basic).any { secret ->
                    secret in event.formattedMessage || secret in event.throwableProxy?.message.orEmpty() ||
                        event.keyValuePairs.orEmpty().any { secret in it.value?.toString().orEmpty() }
                }
            }
            assertTrue(leaks.isEmpty(), "the token (or its Basic header) reached a log line: ${leaks.map { it.formattedMessage }}")
            assertTrue(
                root.events.none { "?" in it.formattedMessage && "jql=" in it.formattedMessage },
                "no URL with a query string is logged",
            )
        } finally {
            root.detach()
        }
    }

    @Test
    fun `unauthenticated calls are 401 on all three routes`() = testApplication {
        start()
        val anonymous = jsonClient()
        assertEquals(HttpStatusCode.Unauthorized, anonymous.get("$base/1/discovery").status)
        assertEquals(HttpStatusCode.Unauthorized, anonymous.post("$base/1/test").status)
        assertEquals(HttpStatusCode.Unauthorized, anonymous.post("$base/test").status)
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
