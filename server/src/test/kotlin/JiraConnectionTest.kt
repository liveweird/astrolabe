package ch.nokillswit

import ch.nokillswit.infra.crypto.DEV_DATA_ENCRYPTION_KEY
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.jira.JiraAuthScheme
import ch.nokillswit.jira.JiraConnectionPageResponse
import ch.nokillswit.jira.JiraConnectionRequest
import ch.nokillswit.jira.JiraConnectionResponse
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Jira connection registry (V21, `/api/v1/integrations/jira/connections`): the ADMIN-only `teams/`-shaped CRUD, and the first stored
 * credential - the API token is encrypted on write, write-only end to end (no response, audit line, log line or problem body carries it)
 * and kept or rotated by a PUT. Connections are SHARED suite state: every test mints UNIQUE names.
 */
class JiraConnectionTest {
    private val base = "/api/v1/integrations/jira/connections"
    private val json = Json { ignoreUnknownKeys = true }
    private val cipher = FieldCipher(DEV_DATA_ENCRYPTION_KEY) // the suite's app runs on the committed dev key

    private fun name(prefix: String) = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

    private fun newToken() = "JTOK-${UUID.randomUUID()}"

    private fun request(
        name: String = name("conn"),
        token: String? = newToken(),
        siteUrl: String = "https://sample.atlassian.net",
        email: String = "jira.user@example.test",
        keys: List<String> = listOf("SP", "E2E"),
        scheme: JiraAuthScheme = JiraAuthScheme.BASIC,
        enabled: Boolean = true,
    ) = JiraConnectionRequest(name, siteUrl, email, token, scheme, keys, enabled)

    private suspend fun HttpResponse.connection(): JiraConnectionResponse = json.decodeFromString(bodyAsText())

    private fun storedToken(id: UInt): String = checkNotNull(storedTokenOrNull(id)) { "jira_connections row $id holds no token" }

    private fun storedTokenOrNull(id: UInt): String? = PostgresTestSupport.connect().use { connection ->
        connection.prepareStatement("SELECT api_token FROM jira_connections WHERE id = ?").use { st ->
            st.setInt(1, id.toInt())
            st.executeQuery().use { rs ->
                check(rs.next()) { "no jira_connections row $id" }
                rs.getString(1)
            }
        }
    }

    private suspend fun HttpClient.create(request: JiraConnectionRequest): JiraConnectionResponse {
        val response = postJson(base, request)
        assertEquals(HttpStatusCode.Created, response.status)
        return response.connection()
    }

    private suspend fun HttpClient.rawBody(method: String, path: String, body: String): HttpResponse {
        val build: io.ktor.client.request.HttpRequestBuilder.() -> Unit = {
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        return if (method == "POST") post(path, build) else put(path, build)
    }

    @Test
    fun `unauthenticated requests are 401`() = testApplication {
        usePostgresTestcontainer()
        val client = jsonClient()
        assertEquals(HttpStatusCode.Unauthorized, client.get(base).status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("$base/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.post(base).status)
        assertEquals(HttpStatusCode.Unauthorized, client.put("$base/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.delete("$base/1").status)
    }

    @Test
    fun `a non-admin is 403 on every operation - reads included, before the id lookup and before the body`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jiraro-admin", UserRole.ADMIN)
        val user = seededClient("jiraro-user", UserRole.USER)
        val id = admin.create(request()).id
        // The registry names a credential-bearing site: no read is open to a regular user, and an unknown id is no different.
        assertEquals(HttpStatusCode.Forbidden, user.get(base).status)
        assertEquals(HttpStatusCode.Forbidden, user.get("$base/$id").status)
        assertEquals(HttpStatusCode.Forbidden, user.get("$base/999999").status)
        assertEquals(HttpStatusCode.Forbidden, user.postJson(base, request()).status)
        assertEquals(HttpStatusCode.Forbidden, user.putJson("$base/$id", request()).status)
        assertEquals(HttpStatusCode.Forbidden, user.putJson("$base/999999", request()).status)
        assertEquals(HttpStatusCode.Forbidden, user.delete("$base/$id").status)
        assertEquals(HttpStatusCode.Forbidden, user.delete("$base/999999").status)
        // The guard runs before the body decodes: a non-admin's malformed or invalid body stays 403.
        assertEquals(HttpStatusCode.Forbidden, user.rawBody("POST", base, "{ not json").status)
        assertEquals(HttpStatusCode.Forbidden, user.rawBody("PUT", "$base/$id", "{}").status)
        assertEquals(HttpStatusCode.OK, admin.get("$base/$id").status, "the refused calls changed nothing")
    }

    @Test
    fun `admin CRUD round-trips - create, read, list, update, delete`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jiracrud", UserRole.ADMIN)
        val connName = name("crud")
        val padded = request(name = "  $connName  ", email = "  Jira.User@Example.TEST ", keys = listOf(" SP ", "E2E"))
        val created = admin.postJson(base, padded)
        assertEquals(HttpStatusCode.Created, created.status)
        assertNotNull(created.headers["Location"])
        val body = created.connection()
        assertEquals(connName, body.name, "the sanitizer trims")
        assertEquals("jira.user@example.test", body.email, "the account email is folded")
        assertEquals(listOf("SP", "E2E"), body.projectKeys)
        assertEquals("https://sample.atlassian.net", body.siteUrl)
        assertTrue(body.hasApiToken)
        assertEquals(JiraAuthScheme.BASIC, body.authScheme)
        assertTrue(body.enabled)
        assertEquals(listOf(null, null, null, null), listOf(body.cloudId, body.discoveredAt, body.lastTestedAt, body.lastTestOk))
        assertFalse(body.mappingSet)

        assertEquals(body, admin.get("$base/${body.id}").connection())
        val page = admin.get("$base?pageSize=100&sort=-name").body<JiraConnectionPageResponse>()
        assertTrue(page.total >= 1)
        assertEquals(body, page.items.single { it.id == body.id })

        val renamed = name("renamed")
        val update = request(name = renamed, token = null, keys = listOf("OPS"), scheme = JiraAuthScheme.BEARER, enabled = false)
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${body.id}", update).status)
        val after = admin.get("$base/${body.id}").connection()
        assertEquals(renamed, after.name)
        assertEquals(listOf("OPS"), after.projectKeys)
        assertEquals(JiraAuthScheme.BEARER, after.authScheme)
        assertFalse(after.enabled)
        assertTrue(after.hasApiToken, "an omitted token keeps the stored one")
        assertTrue(after.updatedAt >= body.updatedAt)

        assertEquals(HttpStatusCode.NoContent, admin.delete("$base/${body.id}").status)
        assertEquals(HttpStatusCode.NotFound, admin.get("$base/${body.id}").status)
        assertEquals(HttpStatusCode.NotFound, admin.delete("$base/${body.id}").status, "a second delete is a 404, not a 204")
        assertEquals(HttpStatusCode.NotFound, admin.putJson("$base/${body.id}", request()).status)
        assertEquals(HttpStatusCode.NotFound, admin.putJson("$base/999999", request()).status)
        assertEquals(HttpStatusCode.NotFound, admin.get("$base/999999").status)
        assertEquals(HttpStatusCode.NotFound, admin.delete("$base/999999").status)
        assertFalse(admin.get("$base?pageSize=100").body<JiraConnectionPageResponse>().items.any { it.id == body.id })
        assertEquals(HttpStatusCode.BadRequest, admin.get("$base?sort=email").status, "only id, name and createdAt sort")
    }

    @Test
    fun `the list sorts by name and pages`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jiralist", UserRole.ADMIN)
        val prefix = name("lst")
        val created = listOf("b", "c", "a").map { admin.create(request(name = "$prefix-$it")) }
        val ours = { items: List<JiraConnectionResponse> ->
            items.filter { it.name.startsWith(prefix) }.map { it.name.removePrefix("$prefix-") }
        }
        assertEquals(listOf("c", "b", "a"), ours(admin.get("$base?pageSize=100&sort=-name").body<JiraConnectionPageResponse>().items))
        assertEquals(listOf("a", "b", "c"), ours(admin.get("$base?pageSize=100&sort=name").body<JiraConnectionPageResponse>().items))
        val createdIds = created.map { it.id }
        val byId = admin.get("$base?pageSize=100&sort=id").body<JiraConnectionPageResponse>().items.map { it.id }
        assertEquals(createdIds, byId.filter { it in createdIds })
        val firstPage = admin.get("$base?pageSize=1&page=1").body<JiraConnectionPageResponse>()
        assertEquals(1, firstPage.items.size)
        assertTrue(firstPage.total >= 3)
    }

    @Test
    fun `the token is encrypted at rest, write-only, and kept or replaced by a PUT`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jiratoken", UserRole.ADMIN)
        val token = newToken()
        val createdResponse = admin.postJson(base, request(token = "  $token  "))
        val created = createdResponse.connection()
        val id = created.id

        val envelope = storedToken(id)
        assertTrue(envelope.startsWith(FieldCipher.PREFIX), "the stored value is a FieldCipher envelope")
        assertFalse(token in envelope)
        assertEquals(token, cipher.decrypt(envelope), "trimmed, then encrypted under the app's key")
        for (text in listOf(admin.get("$base/$id").bodyAsText(), admin.get("$base?pageSize=100").bodyAsText())) {
            assertFalse(token in text, "no response carries the token")
            assertFalse(FieldCipher.PREFIX in text, "nor its stored envelope")
            assertFalse("apiToken" in text, "nor the field")
        }

        // An omitted token and a blank one both keep the stored envelope byte for byte.
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/$id", request(name = created.name, token = null)).status)
        assertEquals(envelope, storedToken(id))
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/$id", request(name = created.name, token = "   ")).status)
        assertEquals(envelope, storedToken(id))
        // A present token rotates it.
        val rotated = newToken()
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/$id", request(name = created.name, token = rotated)).status)
        val rotatedEnvelope = storedToken(id)
        assertNotEquals(envelope, rotatedEnvelope)
        assertEquals(rotated, cipher.decrypt(rotatedEnvelope))
        assertTrue(admin.get("$base/$id").connection().hasApiToken)
    }

    @Test
    fun `deleting a connection destroys its credential - NULL at rest - and no reader sees the row any more`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jiratokendel", UserRole.ADMIN)
        val token = newToken()
        val created = admin.create(request(token = token))
        assertEquals(token, cipher.decrypt(storedToken(created.id)))

        assertEquals(HttpStatusCode.NoContent, admin.delete("$base/${created.id}").status)
        assertNull(storedTokenOrNull(created.id), "the credential is gone from the database, not re-wrapped")
        // readForTest / readForPeek / readForBind filter active(): a deleted row answers like a missing one.
        assertEquals(HttpStatusCode.NotFound, admin.post("$base/${created.id}/test").status)
        assertEquals(HttpStatusCode.NotFound, admin.get("$base/${created.id}/peek?key=SP-1").status)
    }

    @Test
    fun `a rejected request never echoes the token, and no log line carries it`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jiralog", UserRole.ADMIN)
        val token = newToken()
        val appLog = LogCapture(org.slf4j.Logger.ROOT_LOGGER_NAME)
        try {
            val bad = admin.postJson(base, request(token = token, siteUrl = "https://example.com"))
            assertEquals(HttpStatusCode.BadRequest, bad.status)
            assertFalse(token in bad.bodyAsText())
            val malformed = admin.rawBody("POST", base, """{"name":"x","apiToken":"$token","siteUrl":""")
            assertEquals(HttpStatusCode.BadRequest, malformed.status)
            assertFalse(token in malformed.bodyAsText(), "a decode failure quotes no body excerpt")
            val created = admin.create(request(token = token))
            admin.putJson("$base/${created.id}", request(name = created.name, token = token))
            admin.delete("$base/${created.id}")
            val mentions = appLog.events.filter { event ->
                token in event.formattedMessage || event.keyValuePairs.orEmpty().any { token in it.value.toString() } ||
                    event.throwableProxy?.message?.contains(token) == true
            }
            assertEquals(emptyList(), mentions.map { it.formattedMessage }, "the token reached a log line")
        } finally {
            appLog.detach()
        }
    }

    @Test
    fun `an active name clash is 409 case-insensitively and a deleted connection frees its name`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jiradup", UserRole.ADMIN)
        val n = name("Dup")
        val first = admin.create(request(name = n))
        val clash = admin.postJson(base, request(name = n.uppercase()))
        assertEquals(HttpStatusCode.Conflict, clash.status)
        assertTrue(clash.body<ProblemDetail>().detail!!.contains("Jira connection with this name"))
        val other = admin.create(request(name = name("other")))
        assertEquals(HttpStatusCode.Conflict, admin.putJson("$base/${other.id}", request(name = n)).status)
        assertEquals(HttpStatusCode.NoContent, admin.delete("$base/${first.id}").status)
        val second = admin.postJson(base, request(name = n))
        assertEquals(HttpStatusCode.Created, second.status)
        assertTrue(second.connection().id != first.id)
    }

    @Test
    fun `the site is the connection's identity - a different siteUrl is 409 and changes nothing`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jirasite", UserRole.ADMIN)
        val created = admin.create(request())
        val move = admin.putJson("$base/${created.id}", request(name = created.name, siteUrl = "https://other.atlassian.net", token = null))
        assertEquals(HttpStatusCode.Conflict, move.status)
        assertTrue(move.body<ProblemDetail>().detail!!.contains("site"))
        assertEquals(created, admin.get("$base/${created.id}").connection())
    }

    @Test
    fun `invalid payloads are 400 and create nothing`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jirabad", UserRole.ADMIN)
        val fifty = (1..51).map { "K$it" }
        val cases = mapOf(
            "blank name" to request(name = "   "),
            "overlong name" to request(name = "x".repeat(101)),
            "control character in the name" to request(name = "tab\tname"),
            "invisible-only name" to request(name = "​"),
            "site on another host" to request(siteUrl = "https://example.com"),
            "site over http" to request(siteUrl = "http://sample.atlassian.net"),
            "site with a path" to request(siteUrl = "https://sample.atlassian.net/jira"),
            "site with a trailing slash" to request(siteUrl = "https://sample.atlassian.net/"),
            "site with a port" to request(siteUrl = "https://sample.atlassian.net:8443"),
            "site in upper case" to request(siteUrl = "https://SAMPLE.atlassian.net"),
            "an Atlassian surface, not a tenant" to request(siteUrl = "https://api.atlassian.net"),
            "an overlong site" to request(siteUrl = "https://${"a".repeat(260)}.atlassian.net"),
            "email without @" to request(email = "nobody"),
            "blank email" to request(email = " "),
            "overlong email" to request(email = "${"a".repeat(250)}@x.test"),
            "no token on create" to request(token = null),
            "blank token on create" to request(token = "  "),
            "overlong token" to request(token = "t".repeat(1001)),
            "control character in the token" to request(token = "to\nken"),
            "no project keys" to request(keys = emptyList()),
            "too many project keys" to request(keys = fifty),
            "lower-case project key" to request(keys = listOf("sp")),
            "one-letter project key" to request(keys = listOf("S")),
            "overlong project key" to request(keys = listOf("ABCDEFGHIJK")),
            "duplicate project keys" to request(keys = listOf("SP", "SP")),
        )
        for ((label, case) in cases) {
            assertEquals(HttpStatusCode.BadRequest, admin.postJson(base, case).status, "expected 400 for: $label")
        }
        assertEquals(
            HttpStatusCode.BadRequest,
            admin.rawBody(
                "POST",
                base,
                """{"name":"x","siteUrl":"https://sample.atlassian.net","email":"a@b.c","apiToken":"t",""" +
                    """"authScheme":"NTLM","projectKeys":["SP"]}""",
            ).status,
            "an unknown auth scheme",
        )
        assertEquals(HttpStatusCode.BadRequest, admin.rawBody("POST", base, "{ not json").status)
        val existing = admin.create(request())
        for ((label, case) in cases.filterKeys { it != "no token on create" && it != "blank token on create" }) {
            val status = admin.putJson("$base/${existing.id}", case).status
            assertEquals(HttpStatusCode.BadRequest, status, "expected 400 on update for: $label")
        }
        assertEquals(existing, admin.get("$base/${existing.id}").connection(), "a rejected update changes nothing")
        val page = admin.get("$base?pageSize=100").body<JiraConnectionPageResponse>()
        assertTrue(page.items.none { it.name == "x" || it.name.startsWith("tab") })
    }

    @Test
    fun `mappingSet reads the stored mapping document`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jiramap", UserRole.ADMIN)
        val created = admin.create(request())
        assertFalse(admin.get("$base/${created.id}").connection().mappingSet)
        PostgresTestSupport.connect().use { connection ->
            connection.prepareStatement("UPDATE jira_connections SET mapping = '{\"milestone\":\"x\"}'::jsonb WHERE id = ?").use { st ->
                st.setInt(1, created.id.toInt())
                st.executeUpdate()
            }
        }
        assertTrue(admin.get("$base/${created.id}").connection().mappingSet)
    }

    @Test
    fun `mutations audit with the name and host only, and a failed mutation does not`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("jiraaudit")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(adminEmail, "pw")
        val token = newToken()
        withAuditCapture { capture ->
            val n = name("audited")
            val created = admin.create(request(name = n, token = token))
            val createdEvent = capture.awaitEvent {
                it.message == "jira.connection_created" && it.hasKeyValue("connectionId", created.id.toLong())
            }
            assertNotNull(createdEvent, "create must audit")
            assertTrue(createdEvent.hasKeyValue("byUserId", adminId.toLong()))
            assertTrue(createdEvent.hasKeyValue("name", n))
            assertTrue(createdEvent.hasKeyValue("host", "sample.atlassian.net"))

            val renamed = name("audited2")
            admin.putJson("$base/${created.id}", request(name = renamed, token = null))
            val kept = capture.awaitEvent { it.message == "jira.connection_updated" && it.hasKeyValue("connectionId", created.id.toLong()) }
            assertNotNull(kept)
            assertTrue(kept.hasKeyValue("tokenRotated", false))
            assertTrue(kept.hasKeyValue("name", renamed))
            admin.putJson("$base/${created.id}", request(name = renamed, token = newToken()))
            assertNotNull(
                capture.awaitEvent {
                    it.message == "jira.connection_updated" && it.hasKeyValue("tokenRotated", true) &&
                        it.hasKeyValue("connectionId", created.id.toLong())
                },
                "a PUT that carried a token audits the rotation",
            )

            admin.delete("$base/${created.id}")
            val deleted = capture.awaitEvent {
                it.message == "jira.connection_deleted" && it.hasKeyValue("connectionId", created.id.toLong())
            }
            assertNotNull(deleted)
            assertTrue(deleted.hasKeyValue("name", renamed), "the name as STORED")
            assertTrue(deleted.hasKeyValue("host", "sample.atlassian.net"))
            assertTrue(deleted.hasKeyValue("runsDeleted", 0), "no run existed: the count is reported anyway")

            val before = capture.events.count { it.message == "jira.connection_created" }
            assertEquals(HttpStatusCode.BadRequest, admin.postJson(base, request(name = "")).status)
            val taken = admin.create(request(name = name("taken")))
            assertEquals(HttpStatusCode.Conflict, admin.postJson(base, request(name = taken.name)).status)
            assertEquals(before + 1, capture.events.count { it.message == "jira.connection_created" }, "only the successful create audited")
            assertTrue(
                capture.events.none { event ->
                    token in event.formattedMessage ||
                        event.keyValuePairs.orEmpty().any { token in it.value.toString() || it.key == "apiToken" }
                },
                "no audit line carries the token",
            )
            assertTrue(
                capture.events.filter { it.message.startsWith("jira.") }
                    .none { event -> event.keyValuePairs.orEmpty().any { it.key == "email" } },
                "nor the account email",
            )
        }
    }
}
