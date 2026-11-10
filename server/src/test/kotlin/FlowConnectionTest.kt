package ch.nokillswit

import ch.nokillswit.flow.DEFAULT_FLOW_POLL_INTERVAL_MINUTES
import ch.nokillswit.flow.FlowConnectionPageResponse
import ch.nokillswit.flow.FlowConnectionRequest
import ch.nokillswit.flow.FlowConnectionResponse
import ch.nokillswit.flow.FlowConnectionServiceKey
import ch.nokillswit.flow.FlowOriginList
import ch.nokillswit.infra.crypto.FieldCipher
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
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Flow connection registry (V24, `/api/v1/integrations/flow/connections`): the ADMIN-only `teams/`-shaped CRUD, the Jira registry's
 * twin. The service token is encrypted on write, write-only end to end (no response, audit line, log line or problem body carries it)
 * and kept or rotated by a PUT; the origin is the connection's identity and must be one the OPERATOR listed. Connections are SHARED suite
 * state: every test mints UNIQUE names under [PREFIX], removed afterwards.
 */
class FlowConnectionTest {
    private companion object {
        const val PREFIX = "flow-reg"
        const val BASE = "/api/v1/integrations/flow/connections"
        const val ORIGINS = "/api/v1/integrations/flow/origins"
    }

    private val json = Json { ignoreUnknownKeys = true }
    private val cipher = FieldCipher(ch.nokillswit.infra.crypto.DEV_DATA_ENCRYPTION_KEY) // the suite's app runs on the committed dev key

    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
    }

    private fun name(label: String = "conn") = flowUnique("$PREFIX-$label")

    /** The app with exactly [FLOW_TEST_ORIGIN] listed as a development origin (nothing here makes an outbound call). */
    private suspend fun ApplicationTestBuilder.start(origin: String = FLOW_TEST_ORIGIN) {
        configureApp("flow.insecureOrigins" to origin)
        startApplication()
    }

    private fun request(
        name: String = name(),
        token: String? = flowToken(),
        baseUrl: String = FLOW_TEST_ORIGIN,
        timeZone: String = "Europe/Warsaw",
        enabled: Boolean = true,
        poll: Int? = DEFAULT_FLOW_POLL_INTERVAL_MINUTES,
    ) = FlowConnectionRequest(name, baseUrl, timeZone, token, enabled, poll)

    private suspend fun HttpResponse.connection(): FlowConnectionResponse = json.decodeFromString(bodyAsText())

    private fun storedTokenOrNull(id: UInt): String? = flowStoredToken(id)

    /** Every connection the registry lists, page after page: the suite shares one database. */
    private suspend fun HttpClient.listAll(sort: String = "id"): List<FlowConnectionResponse> {
        val all = mutableListOf<FlowConnectionResponse>()
        var page = 1
        while (true) {
            val body = get("$BASE?pageSize=100&sort=$sort&page=$page").body<FlowConnectionPageResponse>()
            all += body.items
            if (body.items.isEmpty() || all.size >= body.total) return all
            page++
        }
    }

    private suspend fun HttpClient.create(request: FlowConnectionRequest): FlowConnectionResponse {
        val response = postJson(BASE, request)
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
        start()
        val client = jsonClient()
        assertEquals(HttpStatusCode.Unauthorized, client.get(BASE).status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("$BASE/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.post(BASE).status)
        assertEquals(HttpStatusCode.Unauthorized, client.put("$BASE/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.delete("$BASE/1").status)
    }

    @Test
    fun `a non-admin is 403 on every operation - reads included, before the id lookup and before the body`() = testApplication {
        start()
        val admin = seededClient("flowro-admin", UserRole.ADMIN)
        val user = seededClient("flowro-user", UserRole.USER)
        val id = admin.create(request()).id
        // The registry names a credential-bearing Flow: no read is open to a regular user, and an unknown id is no different.
        assertEquals(HttpStatusCode.Forbidden, user.get(BASE).status)
        assertEquals(HttpStatusCode.Forbidden, user.get("$BASE/$id").status)
        assertEquals(HttpStatusCode.Forbidden, user.get("$BASE/999999").status)
        assertEquals(HttpStatusCode.Forbidden, user.postJson(BASE, request()).status)
        assertEquals(HttpStatusCode.Forbidden, user.putJson("$BASE/$id", request()).status)
        assertEquals(HttpStatusCode.Forbidden, user.postJson(BASE, request(poll = 4)).status, "the interval's 400 comes after the guard")
        assertEquals(HttpStatusCode.Forbidden, user.putJson("$BASE/$id", request(poll = 1441)).status)
        assertEquals(HttpStatusCode.Forbidden, user.putJson("$BASE/999999", request()).status)
        assertEquals(HttpStatusCode.Forbidden, user.delete("$BASE/$id").status)
        assertEquals(HttpStatusCode.Forbidden, user.delete("$BASE/999999").status)
        // The guard runs before the body decodes: a non-admin's malformed or invalid body stays 403.
        assertEquals(HttpStatusCode.Forbidden, user.rawBody("POST", BASE, "{ not json").status)
        assertEquals(HttpStatusCode.Forbidden, user.rawBody("PUT", "$BASE/$id", "{}").status)
        assertEquals(HttpStatusCode.OK, admin.get("$BASE/$id").status, "the refused calls changed nothing")
    }

    @Test
    fun `admin CRUD round-trips - create, read, list, update, delete`() = testApplication {
        start()
        val admin = seededClient("flowcrud", UserRole.ADMIN)
        val connName = name("crud")
        val created = admin.postJson(BASE, request(name = "  $connName  ", timeZone = "UTC"))
        assertEquals(HttpStatusCode.Created, created.status)
        val body = created.connection()
        assertEquals("/api/v1/integrations/flow/connections/${body.id}", created.headers["Location"])
        assertEquals(connName, body.name, "the sanitizer trims")
        assertEquals(listOf(FLOW_TEST_ORIGIN, "UTC"), listOf(body.baseUrl, body.timeZone))
        assertTrue(body.hasApiToken)
        assertTrue(body.enabled)
        assertEquals(listOf(null, null, null), listOf(body.lastTestedAt, body.lastTestOk, body.teamsAt))
        assertEquals(DEFAULT_FLOW_POLL_INTERVAL_MINUTES, body.pollIntervalMinutes, "an omitted interval is the default")

        assertEquals(body, admin.get("$BASE/${body.id}").connection())
        assertEquals(body, admin.listAll("-name").single { it.id == body.id })

        val renamed = name("renamed")
        val update = request(name = renamed, token = null, timeZone = "Europe/London", enabled = false)
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$BASE/${body.id}", update).status)
        val after = admin.get("$BASE/${body.id}").connection()
        assertEquals(listOf(renamed, "Europe/London", false), listOf(after.name, after.timeZone, after.enabled))
        assertTrue(after.hasApiToken, "an omitted token keeps the stored one")
        assertTrue(after.updatedAt >= body.updatedAt)

        assertEquals(HttpStatusCode.NoContent, admin.delete("$BASE/${body.id}").status)
        assertEquals(HttpStatusCode.NotFound, admin.get("$BASE/${body.id}").status)
        assertEquals(HttpStatusCode.NotFound, admin.delete("$BASE/${body.id}").status, "a second delete is a 404, not a 204")
        assertEquals(HttpStatusCode.NotFound, admin.putJson("$BASE/${body.id}", request()).status)
        assertEquals(HttpStatusCode.NotFound, admin.putJson("$BASE/999999", request()).status)
        assertEquals(HttpStatusCode.NotFound, admin.get("$BASE/999999").status)
        assertEquals(HttpStatusCode.NotFound, admin.delete("$BASE/999999").status)
        assertFalse(admin.listAll().any { it.id == body.id })
        assertEquals(HttpStatusCode.BadRequest, admin.get("$BASE?sort=baseUrl").status, "only id, name and createdAt sort")
        assertEquals(HttpStatusCode.BadRequest, admin.get("$BASE?pageSize=101").status)
    }

    @Test
    fun `the list sorts by name and pages`() = testApplication {
        start()
        val admin = seededClient("flowlist", UserRole.ADMIN)
        val prefix = name("lst")
        val created = listOf("b", "c", "a").map { admin.create(request(name = "$prefix-$it")) }
        val ours = { items: List<FlowConnectionResponse> ->
            items.filter { it.name.startsWith(prefix) }.map { it.name.removePrefix("$prefix-") }
        }
        assertEquals(listOf("c", "b", "a"), ours(admin.listAll("-name")))
        assertEquals(listOf("a", "b", "c"), ours(admin.listAll("name")))
        val createdIds = created.map { it.id }
        assertEquals(createdIds, admin.listAll("id").map { it.id }.filter { it in createdIds })
        val firstPage = admin.get("$BASE?pageSize=1&page=1").body<FlowConnectionPageResponse>()
        assertEquals(1, firstPage.items.size)
        assertTrue(firstPage.total >= 3)
    }

    @Test
    fun `the token is encrypted at rest, write-only, and kept or replaced by a PUT`() = testApplication {
        start()
        val admin = seededClient("flowtoken", UserRole.ADMIN)
        val token = flowToken('t')
        val created = admin.postJson(BASE, request(token = "  $token  ")).connection()
        val id = created.id

        val envelope = checkNotNull(storedTokenOrNull(id))
        assertTrue(envelope.startsWith(FieldCipher.PREFIX), "the stored value is a FieldCipher envelope")
        assertFalse(token in envelope)
        assertEquals(token, cipher.decrypt(envelope), "trimmed, then encrypted under the app's key")
        for (text in listOf(admin.get("$BASE/$id").bodyAsText(), admin.get("$BASE?pageSize=100").bodyAsText())) {
            assertFalse(token in text, "no response carries the token")
            assertFalse(FieldCipher.PREFIX in text, "nor its stored envelope")
            assertFalse("apiToken" in text, "nor the field")
        }

        // An omitted token and a blank one both keep the stored envelope byte for byte.
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$BASE/$id", request(name = created.name, token = null)).status)
        assertEquals(envelope, storedTokenOrNull(id))
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$BASE/$id", request(name = created.name, token = "   ")).status)
        assertEquals(envelope, storedTokenOrNull(id))
        // A present token rotates it.
        val rotated = flowToken('r')
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$BASE/$id", request(name = created.name, token = rotated)).status)
        val rotatedEnvelope = checkNotNull(storedTokenOrNull(id))
        assertNotEquals(envelope, rotatedEnvelope)
        assertEquals(rotated, cipher.decrypt(rotatedEnvelope))
        assertTrue(admin.get("$BASE/$id").connection().hasApiToken)
    }

    @Test
    fun `deleting a connection destroys its credential - NULL at rest - and takes its bindings, runs and mirror with it`() =
        testApplication {
            start()
            val admin = seededClient("flowtokendel", UserRole.ADMIN)
            val token = flowToken('d')
            val created = admin.create(request(token = token))
            assertEquals(token, cipher.decrypt(checkNotNull(storedTokenOrNull(created.id))))
            val team = TestTeams.seed(flowUnique(PREFIX))
            val user = TestUsers.seed(uniqueEmail("flowdelbind"), "flow-del-pass-1")
            jbSql(
                "INSERT INTO flow_team_bindings (connection_id, team_id, flow_team_id, flow_team_name, created_by_user_id, created_at, " +
                    "updated_at) VALUES (?, ?, 1, 'FT', ?, 1, 1)",
                created.id.toInt(), team.toInt(), user.toInt(),
            )
            jbSql(
                "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome) " +
                    "VALUES ('FLOW', ?, 'MANUAL', 1, 2, 'FAILED')",
                created.id.toInt(),
            )
            // Two capacity acknowledgements of the binding (1.10: they are deleted with their connection and counted in the audit).
            val bindingId = jbScalar("SELECT id FROM flow_team_bindings WHERE connection_id = ?", created.id.toInt()) { it.getInt(1) }
            for (sprint in listOf(7, 8)) {
                jbSql(
                    "INSERT INTO flow_capacity_acknowledgements (binding_id, sprint_id, fingerprint, ack_at, ack_by_user_id) " +
                        "VALUES (?, ?, ?, 1, ?)",
                    bindingId, sprint, "0".repeat(64), user.toInt(),
                )
            }
            withAuditCapture { audit ->
                assertEquals(HttpStatusCode.NoContent, admin.delete("$BASE/${created.id}").status)
                val event = assertNotNull(audit.awaitEvent { it.message == "flow.connection_deleted" })
                assertTrue(event.hasKeyValue("bindingsUnbound", 1) && event.hasKeyValue("runsDeleted", 1), "${event.keyValuePairs}")
                assertTrue(event.hasKeyValue("acknowledgementsDeleted", 2), "${event.keyValuePairs}")
            }
            assertEquals(
                0, jbScalar("SELECT count(*) FROM flow_capacity_acknowledgements WHERE binding_id = ?", bindingId) { it.getInt(1) },
                "no acknowledgement outlives its connection",
            )
            assertNull(storedTokenOrNull(created.id), "the credential is gone from the database, not re-wrapped")
            // readForTest filters active(): a deleted row answers like a missing one.
            assertEquals(HttpStatusCode.NotFound, admin.post("$BASE/${created.id}/test").status)
        }

    @Test
    fun `a rejected request never echoes the token, and no log line carries it`() = testApplication {
        start()
        val admin = seededClient("flowlog", UserRole.ADMIN)
        val token = flowToken('l')
        val appLog = LogCapture(org.slf4j.Logger.ROOT_LOGGER_NAME)
        try {
            val bad = admin.postJson(BASE, request(token = token, baseUrl = "https://unlisted.example"))
            assertEquals(HttpStatusCode.BadRequest, bad.status)
            val badText = bad.bodyAsText()
            assertFalse(token in badText)
            assertFalse("unlisted.example" in badText, "a rejected origin is never quoted")
            val malformed = admin.rawBody("POST", BASE, """{"name":"x","apiToken":"$token","baseUrl":""")
            assertEquals(HttpStatusCode.BadRequest, malformed.status)
            assertFalse(token in malformed.bodyAsText(), "a decode failure quotes no body excerpt")
            val created = admin.create(request(token = token))
            admin.putJson("$BASE/${created.id}", request(name = created.name, token = token))
            admin.delete("$BASE/${created.id}")
            val mentions = appLog.events.filter { event ->
                token in event.formattedMessage || event.keyValuePairs.orEmpty().any { token in "${it.value}" } ||
                    event.throwableProxy?.message?.contains(token) == true
            }
            assertEquals(emptyList(), mentions.map { it.formattedMessage }, "the token reached a log line")
        } finally {
            appLog.detach()
        }
    }

    @Test
    fun `an active name clash is 409 case-insensitively and a deleted connection frees its name`() = testApplication {
        start()
        val admin = seededClient("flowdup", UserRole.ADMIN)
        val n = name("Dup")
        val first = admin.create(request(name = n))
        val clash = admin.postJson(BASE, request(name = n.uppercase()))
        assertEquals(HttpStatusCode.Conflict, clash.status)
        assertTrue(clash.body<ProblemDetail>().detail!!.contains("A Flow connection with this name already exists"))
        val other = admin.create(request(name = name("other")))
        assertEquals(HttpStatusCode.Conflict, admin.putJson("$BASE/${other.id}", request(name = n)).status)
        assertEquals(HttpStatusCode.NoContent, admin.delete("$BASE/${first.id}").status)
        val second = admin.postJson(BASE, request(name = n))
        assertEquals(HttpStatusCode.Created, second.status)
        assertTrue(second.connection().id != first.id)
    }

    @Test
    fun `the origin is the connection's identity - a different baseUrl is 409 and changes nothing`() = testApplication {
        start()
        val admin = seededClient("flowsite", UserRole.ADMIN)
        val created = admin.create(request())
        // The 409 is the SERVICE's identity rule; the route does not ask the operator's list on a PUT, so any origin reaches it.
        val move = admin.putJson("$BASE/${created.id}", request(name = created.name, baseUrl = "http://other.test:8080", token = null))
        assertEquals(HttpStatusCode.Conflict, move.status)
        assertTrue(move.body<ProblemDetail>().detail!!.contains("origin"))
        assertEquals(created, admin.get("$BASE/${created.id}").connection())
        // Every other SPELLING of the origin is another origin to the identity rule: 409, and the row is untouched each time.
        val variants = listOf(
            "uppercase" to FLOW_TEST_ORIGIN.uppercase(),
            "a trailing slash" to "$FLOW_TEST_ORIGIN/",
            "the default port written out" to "http://flow.test:80",
            "a zero-padded port" to "http://flow.test:08080",
            "an origin the operator never listed" to "http://flow-other.test:8080",
        )
        for ((label, origin) in variants) {
            val response = admin.putJson("$BASE/${created.id}", request(name = created.name, baseUrl = origin, token = null))
            assertEquals(HttpStatusCode.Conflict, response.status, label)
            assertEquals(created, admin.get("$BASE/${created.id}").connection(), "$label changed nothing")
        }
    }

    @Test
    fun `an origin delisted since still lets an admin update the connection, and still cannot move it`() {
        var created: FlowConnectionResponse? = null
        testApplication {
            start()
            created = seededClient("flowdelist1", UserRole.ADMIN).create(request())
        }
        testApplication {
            start(origin = "http://flow-other.test:8080")
            val admin = seededClient("flowdelist2", UserRole.ADMIN)
            val id = assertNotNull(created).id
            val update = request(name = assertNotNull(created).name, token = null, enabled = false)
            assertEquals(HttpStatusCode.NoContent, admin.putJson("$BASE/$id", update).status, "disabling needs no listed origin")
            assertEquals(false, admin.get("$BASE/$id").connection().enabled)
            assertEquals(HttpStatusCode.BadRequest, admin.postJson(BASE, request()).status, "a NEW connection on it is refused")
            assertEquals(HttpStatusCode.Conflict, admin.putJson("$BASE/$id", update.copy(baseUrl = "http://flow-other.test:8080")).status)
        }
    }

    @Test
    fun `invalid payloads are 400 and create nothing`() = testApplication {
        start()
        val admin = seededClient("flowbad", UserRole.ADMIN)
        val cases = mapOf(
            "blank name" to request(name = "   "),
            "overlong name" to request(name = "x".repeat(101)),
            "control character in the name" to request(name = "tab\tname"),
            "invisible-only name" to request(name = "​"),
            "an origin the operator did not list" to request(baseUrl = "http://unlisted.test:8080"),
            "the listed host over https" to request(baseUrl = "https://flow.test:8080"),
            "the listed origin with a path" to request(baseUrl = "$FLOW_TEST_ORIGIN/api"),
            "the listed origin with a trailing slash" to request(baseUrl = "$FLOW_TEST_ORIGIN/"),
            "the listed origin in upper case" to request(baseUrl = "HTTP://FLOW.TEST:8080"),
            "the listed origin with credentials" to request(baseUrl = "http://user:pw@flow.test:8080"),
            "an overlong origin" to request(baseUrl = "http://${"a".repeat(260)}.test"),
            "blank time zone" to request(timeZone = " "),
            "an unknown time zone" to request(timeZone = "Mars/Olympus"),
            "a bare UTC offset" to request(timeZone = "+02:00"),
            "an overlong time zone" to request(timeZone = "Europe/${"a".repeat(64)}"),
            "no token on create" to request(token = null),
            "blank token on create" to request(token = "  "),
            "a token without Flow's prefix" to request(token = "jira_" + "a".repeat(43)),
            "a token one character short" to request(token = "flow_int_" + "a".repeat(42)),
            "a token one character long" to request(token = "flow_int_" + "a".repeat(44)),
            "a token with a forbidden character" to request(token = "flow_int_" + "a".repeat(42) + "!"),
            "control character in the token" to request(token = "flow_int_" + "a".repeat(42) + "\n"),
            "interval under the floor" to request(poll = 4),
            "interval of zero" to request(poll = 0),
            "negative interval" to request(poll = -15),
            "interval over a day" to request(poll = 1441),
        )
        for ((label, case) in cases) {
            assertEquals(HttpStatusCode.BadRequest, admin.postJson(BASE, case).status, "expected 400 for: $label")
        }
        assertEquals(HttpStatusCode.BadRequest, admin.rawBody("POST", BASE, "{ not json").status)
        val existing = admin.create(request())
        // A PUT does not ask the operator's list (the origin is the identity), so a case that moves the origin is the 409's, not a 400.
        val tokenless = setOf("no token on create", "blank token on create")
        val forUpdate = cases.filter { (label, case) -> case.baseUrl == FLOW_TEST_ORIGIN && label !in tokenless }
        for ((label, case) in forUpdate) {
            val status = admin.putJson("$BASE/${existing.id}", case).status
            assertEquals(HttpStatusCode.BadRequest, status, "expected 400 on update for: $label")
        }
        assertEquals(existing, admin.get("$BASE/${existing.id}").connection(), "a rejected update changes nothing")
        assertTrue(admin.listAll().none { it.name == "x" || it.name.startsWith("tab") })
    }

    @Test
    fun `an unlisted origin and a non-canonical spelling are told apart in the 400, and neither quotes the value`() = testApplication {
        start()
        val admin = seededClient("flowwhy", UserRole.ADMIN)
        val unlisted = admin.postJson(BASE, request(baseUrl = "http://unlisted.test:8080"))
        val spelled = admin.postJson(BASE, request(baseUrl = "HTTP://FLOW.TEST:8080/"))
        assertEquals(listOf(HttpStatusCode.BadRequest, HttpStatusCode.BadRequest), listOf(unlisted.status, spelled.status))
        val unlistedDetail = unlisted.body<ProblemDetail>().detail!!
        val spelledDetail = spelled.body<ProblemDetail>().detail!!
        assertTrue("not one of the Flow origins" in unlistedDetail && "/api/v1/integrations/flow/origins" in unlistedDetail, unlistedDetail)
        assertTrue("origin alone" in spelledDetail && "lowercase" in spelledDetail, spelledDetail)
        assertFalse("port" in unlistedDetail.lowercase(), "an unlisted origin is never blamed on its port")
        for (detail in listOf(unlistedDetail, spelledDetail)) {
            assertFalse("unlisted.test" in detail || "FLOW.TEST" in detail, "the value is never quoted")
        }
        // The same bad spelling is judged the same way by the ad-hoc test route (one validator).
        val adHoc = admin.postJson("$BASE/test", request(baseUrl = "http://unlisted.test:8080"))
        assertEquals(HttpStatusCode.BadRequest, adHoc.status)
        assertEquals(unlistedDetail, adHoc.body<ProblemDetail>().detail)
    }

    @Test
    fun `an overlong base URL is refused with the canonical-origin sentence, never as unlisted`() = testApplication {
        start()
        val admin = seededClient("flowlong", UserRole.ADMIN)
        val response = admin.postJson(BASE, request(baseUrl = "http://${"a".repeat(260)}.test"))
        assertEquals(HttpStatusCode.BadRequest, response.status)
        val detail = response.body<ProblemDetail>().detail!!
        assertTrue("origin alone" in detail && "lowercase" in detail, detail)
        assertFalse("not one of the Flow origins" in detail, detail)
    }

    @Test
    fun `the allowed origins are an ADMIN read of the operator's list - a user is 403`() = testApplication {
        start()
        val admin = seededClient("floworig-admin", UserRole.ADMIN)
        val user = seededClient("floworig-user", UserRole.USER)
        assertEquals(HttpStatusCode.Forbidden, user.get(ORIGINS).status)
        val ok = admin.get(ORIGINS)
        assertEquals(HttpStatusCode.OK, ok.status)
        assertEquals(FlowOriginList(listOf(FLOW_TEST_ORIGIN)), json.decodeFromString<FlowOriginList>(ok.bodyAsText()))
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(ORIGINS).status)
    }

    @Test
    fun `the polling interval defaults to 60, null means manual only, the bounds hold, and a PUT is a full replace`() = testApplication {
        start()
        val admin = seededClient("flowpoll", UserRole.ADMIN)
        fun body(name: String, interval: String?) =
            """{"name":"$name","baseUrl":"$FLOW_TEST_ORIGIN","timeZone":"Europe/Warsaw","apiToken":"${flowToken()}"""" +
                (interval?.let { ""","pollIntervalMinutes":$it""" } ?: "") + "}"
        fun storedInterval(id: UInt): Int? =
            jbScalar("SELECT poll_interval_minutes FROM flow_connections WHERE id = ?", id.toInt()) { rs ->
                rs.getInt(1).takeUnless { rs.wasNull() }
            }

        val omitted = admin.rawBody("POST", BASE, body(name("poll"), null))
        assertEquals(HttpStatusCode.Created, omitted.status)
        val defaulted = omitted.connection()
        assertEquals(60, defaulted.pollIntervalMinutes, "omitted = 60")
        assertEquals(60, storedInterval(defaulted.id))

        val manual = admin.rawBody("POST", BASE, body(name("poll"), "null"))
        assertEquals(HttpStatusCode.Created, manual.status)
        val manualOnly = manual.connection()
        assertNull(manualOnly.pollIntervalMinutes, "an explicit null = manual only")
        assertNull(storedInterval(manualOnly.id))

        val floor = admin.create(request(poll = 5))
        val ceiling = admin.create(request(poll = 1440))
        assertEquals(listOf(5, 1440), listOf(floor.pollIntervalMinutes, ceiling.pollIntervalMinutes), "both bounds are inclusive")
        for (bad in listOf("4", "1441", "0", "-1", "15.5")) {
            assertEquals(HttpStatusCode.BadRequest, admin.rawBody("POST", BASE, body(name("poll"), bad)).status, "interval $bad")
        }

        // PUT is a FULL replace: a body without the member resets the interval to 60 - it never keeps the stored one.
        val fifteen = request(name = floor.name, token = null, poll = 15)
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$BASE/${floor.id}", fifteen).status)
        assertEquals(15, admin.get("$BASE/${floor.id}").connection().pollIntervalMinutes)
        assertEquals(HttpStatusCode.NoContent, admin.rawBody("PUT", "$BASE/${floor.id}", body(floor.name, null)).status)
        assertEquals(60, admin.get("$BASE/${floor.id}").connection().pollIntervalMinutes, "omitted resets to 60")
        assertEquals(HttpStatusCode.NoContent, admin.rawBody("PUT", "$BASE/${floor.id}", body(floor.name, "null")).status)
        assertNull(admin.get("$BASE/${floor.id}").connection().pollIntervalMinutes, "an explicit null switches polling off")
        assertEquals(HttpStatusCode.BadRequest, admin.rawBody("PUT", "$BASE/${floor.id}", body(floor.name, "4")).status)
        assertNull(storedInterval(floor.id), "a rejected PUT changes nothing")
    }

    @Test
    fun `a changed token or zone clears the last verdict - a rename or a pause does not`() = testApplication {
        start()
        val admin = seededClient("flowrotate", UserRole.ADMIN)
        val created = admin.create(request())
        val service = application.attributes[FlowConnectionServiceKey]
        suspend fun tested(): FlowConnectionResponse {
            val target = assertNotNull(service.readForTest(created.id))
            assertTrue(service.recordTest(created.id, target.expectedUpdatedAt, ok = true, at = 7L))
            return admin.get("$BASE/${created.id}").connection().also { assertEquals(true, it.lastTestOk) }
        }
        fun same() = request(token = null).copy(name = created.name)
        tested()
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$BASE/${created.id}", same()).status)
        val paused = same().copy(name = name("renamed"), enabled = false)
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$BASE/${created.id}", paused).status)
        assertEquals(true, admin.get("$BASE/${created.id}").connection().lastTestOk)
        val changes = mapOf(
            "the token" to request(token = flowToken('n')).copy(name = created.name),
            "the zone" to same().copy(timeZone = "UTC"),
        )
        for ((what, change) in changes) {
            admin.putJson("$BASE/${created.id}", same().copy(timeZone = "Europe/Warsaw")) // back to the baseline
            tested()
            admin.putJson("$BASE/${created.id}", change)
            val after = admin.get("$BASE/${created.id}").connection()
            assertEquals(listOf(null, null), listOf(after.lastTestedAt, after.lastTestOk), "changing $what clears the verdict")
        }
    }

    @Test
    fun `mutations audit with the name and host only, and a failed mutation does not`() = testApplication {
        start()
        val adminEmail = uniqueEmail("flowaudit")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(adminEmail, "pw")
        val token = flowToken('a')
        val host = FLOW_TEST_ORIGIN.substringAfter("://")
        withAuditCapture { capture ->
            val n = name("audited")
            val created = admin.create(request(name = n, token = token))
            val createdEvent = capture.awaitEvent {
                it.message == "flow.connection_created" && it.hasKeyValue("connectionId", created.id.toLong())
            }
            assertNotNull(createdEvent, "create must audit")
            assertTrue(createdEvent.hasKeyValue("byUserId", adminId.toLong()) && createdEvent.hasKeyValue("name", n))
            assertTrue(createdEvent.hasKeyValue("host", host))
            assertTrue(createdEvent.hasKeyValue("pollIntervalMinutes", 60), "the cadence is audited")

            val renamed = name("audited2")
            admin.putJson("$BASE/${created.id}", request(name = renamed, token = null))
            val kept = capture.awaitEvent { it.message == "flow.connection_updated" && it.hasKeyValue("connectionId", created.id.toLong()) }
            assertNotNull(kept)
            assertTrue(kept.hasKeyValue("tokenRotated", false) && kept.hasKeyValue("name", renamed) && kept.hasKeyValue("host", host))
            admin.putJson("$BASE/${created.id}", request(name = renamed, token = null, poll = null))
            assertNotNull(
                capture.awaitEvent {
                    it.message == "flow.connection_updated" && it.hasKeyValue("connectionId", created.id.toLong()) &&
                        it.hasKeyValue("pollIntervalMinutes", null)
                },
                "switching polling off audits a null interval",
            )
            admin.putJson("$BASE/${created.id}", request(name = renamed, token = flowToken('b')))
            assertNotNull(
                capture.awaitEvent { it.message == "flow.connection_updated" && it.hasKeyValue("tokenRotated", true) },
                "a PUT that carried a token audits the rotation",
            )

            admin.delete("$BASE/${created.id}")
            val deleted = capture.awaitEvent {
                it.message == "flow.connection_deleted" && it.hasKeyValue("connectionId", created.id.toLong())
            }
            assertNotNull(deleted)
            assertTrue(deleted.hasKeyValue("name", renamed) && deleted.hasKeyValue("host", host), "the row as STORED")
            assertTrue(deleted.hasKeyValue("bindingsUnbound", 0) && deleted.hasKeyValue("runsDeleted", 0), "counts reported anyway")

            val before = capture.events.count { it.message == "flow.connection_created" }
            assertEquals(HttpStatusCode.BadRequest, admin.postJson(BASE, request(name = "")).status)
            val taken = admin.create(request(name = name("taken")))
            assertEquals(HttpStatusCode.Conflict, admin.postJson(BASE, request(name = taken.name)).status)
            assertEquals(before + 1, capture.events.count { it.message == "flow.connection_created" }, "only the successful create audited")
            assertTrue(
                capture.events.none { event ->
                    listOf(token, flowToken('b')).any { secret -> secret in event.formattedMessage } ||
                        event.keyValuePairs.orEmpty().any { token in "${it.value}" || it.key == "apiToken" }
                },
                "no audit line carries the token",
            )
        }
    }
}
