package ch.nokillswit

import ch.nokillswit.flow.FlowConnectionRequest
import ch.nokillswit.flow.FlowConnectionResponse
import ch.nokillswit.flow.FlowTestResult
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.users.UserRole
import com.github.tomakehurst.wiremock.client.MappingBuilder
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.equalTo
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor
import com.github.tomakehurst.wiremock.client.WireMock.matching
import com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo
import com.github.tomakehurst.wiremock.http.Fault
import io.ktor.client.HttpClient
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
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.AfterClass
import org.junit.BeforeClass
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST /api/v1/integrations/flow/connections/test` and `.../{id}/test` against the shared [FlowStubServer] (the exact
 * `sample-data/flow-stub` contract). A note for a surprising `401` here: a request SHAPE the stub has no mapping for falls to its
 * uniform-401 catch-all. Connections are SHARED suite state: every test mints UNIQUE names under [PREFIX], removed afterwards.
 */
class FlowTestConnectionTest {
    private companion object {
        const val PREFIX = "flow-tst"
        const val BASE = "/api/v1/integrations/flow/connections"
        const val HINT = "Flow 1.57.0 or later"

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            FlowStubFixture.warm()
        }

        @JvmStatic
        @AfterClass
        fun resetStub() {
            FlowStubServer.resetScenarios()
        }
    }

    private val json = Json { ignoreUnknownKeys = true }
    private val teamsPath get() = FlowStubServer.teamsPath
    private val mePath get() = FlowStubServer.mePath

    @AfterTest
    fun cleanUp() {
        FlowStubServer.resetScenarios()
        removeFlowFixtureRows(PREFIX)
    }

    private fun request(
        token: String? = FlowStubServer.token,
        timeZone: String = "Europe/Warsaw",
        origin: String = FlowStubServer.baseUrl,
    ) =
        FlowConnectionRequest(flowUnique(PREFIX), origin, timeZone, token, enabled = true)

    /** The app with the stub's exact origin listed; [retries] 0 so a deliberately failing probe does not sleep through real backoff. */
    private suspend fun ApplicationTestBuilder.start(limit: String = "100", vararg extra: Pair<String, String>) {
        configureApp(
            "flow.insecureOrigins" to FlowStubFixture.warm(), "flow.maxRetries" to "0", "security.rateLimit.flowTestPerMinute" to limit,
            *extra,
        )
        startApplication()
    }

    private suspend fun HttpResponse.result(): FlowTestResult = json.decodeFromString(bodyAsText())

    private suspend fun HttpClient.create(request: FlowConnectionRequest): FlowConnectionResponse {
        val response = postJson(BASE, request)
        assertEquals(HttpStatusCode.Created, response.status)
        return json.decodeFromString(response.bodyAsText())
    }

    private suspend fun HttpClient.connection(id: UInt): FlowConnectionResponse = json.decodeFromString(get("$BASE/$id").bodyAsText())

    private inline fun <T> withOverride(stub: MappingBuilder, block: () -> T): T {
        val mapping = FlowStubServer.addOverride(stub)
        try {
            return block()
        } finally {
            FlowStubServer.removeOverride(mapping)
        }
    }

    private fun ch.qos.logback.classic.spi.ILoggingEvent.isTestOf(id: UInt) =
        message == "flow.connection_tested" && hasKeyValue("connectionId", id.toLong())

    private fun ch.qos.logback.classic.spi.ILoggingEvent.isTestFailing(vararg probes: String) =
        message == "flow.connection_tested" && hasKeyValue("failedProbes", probes.toList())

    private fun answer(path: String, response: com.github.tomakehurst.wiremock.client.ResponseDefinitionBuilder) =
        get(urlPathEqualTo(path)).atPriority(1).willReturn(response)

    @Test
    fun `ad-hoc test - both required rows are ok against the stub, in order, with the document's size, and nothing is stored`() =
        testApplication {
            start()
            val admin = seededClient("ftest", UserRole.ADMIN)
            val listedBefore = admin.get("$BASE?pageSize=100").bodyAsText()
            FlowStubServer.resetRequests()
            val response = admin.postJson("$BASE/test", request())
            assertEquals(HttpStatusCode.OK, response.status)
            val result = response.result()
            assertEquals(listOf("me", "teams"), result.rows.map { it.name })
            assertEquals(listOf(mePath, teamsPath), result.rows.map { it.path }, "paths only, never a query string")
            val clean = result.rows.all { it.ok && it.required && it.code == null && it.status == null && it.scopeHint == HINT }
            assertTrue(clean, "${result.rows}")
            assertTrue(result.passed)
            val totals = FlowStubServer.expected.getValue("totals").jsonObject
            assertEquals(totals.getValue("teams").jsonPrimitive.content.toInt(), result.teamCount)
            assertEquals(totals.getValue("sprints").jsonPrimitive.content.toInt(), result.sprintCount)
            assertFalse(result.truncated)
            assertFalse(result.recorded, "an ad-hoc test stores nothing")
            assertEquals(listedBefore, admin.get("$BASE?pageSize=100").bodyAsText(), "no connection row appeared")
            // The wire: the bearer is the body's token, and `sprintsSince` is today minus 365 days (flow.sprintsSinceDays) in the zone.
            val zone = ZoneId.of("Europe/Warsaw")
            val teamsCall = getRequestedFor(urlPathEqualTo(teamsPath)).withHeader("Authorization", equalTo(FlowStubServer.authorization))
            val dates = listOf(LocalDate.now(zone).minusDays(365), LocalDate.now(zone).minusDays(366))
            val sinceDates = matching(dates.joinToString("|"))
            assertEquals(1, FlowStubServer.countRequests(teamsCall.withQueryParam("sprintsSince", sinceDates)))
            val meCall = getRequestedFor(urlPathEqualTo(mePath)).withHeader("Authorization", equalTo(FlowStubServer.authorization))
            assertEquals(1, FlowStubServer.countRequests(meCall))
        }

    @Test
    fun `a token the stub does not know fails me with its hint, teams is SKIPPED, and the answer is a 200`() = testApplication {
        start()
        val admin = seededClient("ftestwrong", UserRole.ADMIN)
        FlowStubServer.resetRequests()
        val response = admin.postJson("$BASE/test", request(token = flowToken('w')))
        assertEquals(HttpStatusCode.OK, response.status, "a failed probe is a row, never a 4xx/5xx")
        val result = response.result()
        assertFalse(result.passed)
        val (me, teams) = result.rows
        assertEquals(Triple(false, "AUTHENTICATION_FAILED", 401), Triple(me.ok, me.code, me.status))
        assertEquals(HINT, me.scopeHint)
        assertEquals(Triple(false, "SKIPPED", null), Triple(teams.ok, teams.code, teams.status))
        assertTrue(teams.required && teams.scopeHint == null, "nothing was called: no hint, no status")
        assertEquals(0, FlowStubServer.countRequests(getRequestedFor(urlPathEqualTo(teamsPath))), "the SKIPPED probe made no request")
        assertEquals(listOf(null, null), listOf(result.teamCount, result.sprintCount))
    }

    @Test
    fun `a Flow outage is UPSTREAM_UNAVAILABLE on me and skips teams - a 500 is never read as a bad token`() = testApplication {
        start()
        val admin = seededClient("ftestdown", UserRole.ADMIN)
        FlowStubServer.setScenarioState("flow-outage", "down")
        val response = admin.postJson("$BASE/test", request())
        assertEquals(HttpStatusCode.OK, response.status)
        val (me, teams) = response.result().rows
        assertEquals(Triple("UPSTREAM_UNAVAILABLE", 500, false), Triple(me.code, me.status, me.ok))
        assertEquals("SKIPPED", teams.code)
    }

    @Test
    fun `a Flow older than 1_57 is a NOT_FOUND me row that names the version`() = testApplication {
        start()
        val admin = seededClient("ftest404", UserRole.ADMIN)
        withOverride(answer(mePath, aResponse().withStatus(404))) {
            val (me, teams) = admin.postJson("$BASE/test", request()).result().rows
            assertEquals(Triple("NOT_FOUND", 404, HINT), Triple(me.code, me.status, me.scopeHint))
            assertEquals("SKIPPED", teams.code)
        }
    }

    @Test
    fun `teams failures are rows of their own - me stays ok - and a truncated document passes with its flag`() = testApplication {
        start()
        val admin = seededClient("ftestteams", UserRole.ADMIN)
        val cases = listOf(
            "UPSTREAM_UNAVAILABLE" to aResponse().withStatus(503),
            "UPSTREAM_UNAVAILABLE" to aResponse().withFault(Fault.CONNECTION_RESET_BY_PEER),
            "RATE_LIMITED" to aResponse().withStatus(429),
            "AUTHENTICATION_FAILED" to aResponse().withStatus(401),
            "REDIRECT" to aResponse().withStatus(302).withHeader("Location", "https://evil.example/"),
            "INVALID_RESPONSE" to aResponse().withStatus(200).withBody("{ not json"),
            "INVALID_RESPONSE" to aResponse().withStatus(200).withBody("[]"),
            "INVALID_RESPONSE" to aResponse().withStatus(200).withBody("""{"asOf":1,"sprintsSince":"2025-10-27","items":[]}"""),
        )
        for ((code, response) in cases) {
            withOverride(answer(teamsPath, response)) {
                val http = admin.postJson("$BASE/test", request())
                assertEquals(HttpStatusCode.OK, http.status)
                val result = http.result()
                assertTrue(result.rows.first { it.name == "me" }.ok)
                val teams = result.rows.first { it.name == "teams" }
                assertEquals(Pair(false, code), Pair(teams.ok, teams.code))
                assertFalse(result.passed)
                assertEquals(listOf(null, null, false), listOf(result.teamCount, result.sprintCount, result.truncated))
            }
        }
        val truncated = """{"asOf":1,"sprintsSince":"2025-10-27","teamsTruncated":false,"sprintsTruncated":true,"items":[]}"""
        withOverride(answer(teamsPath, aResponse().withStatus(200).withHeader("Content-Type", "application/json").withBody(truncated))) {
            val result = admin.postJson("$BASE/test", request()).result()
            assertTrue(result.passed, "a cut document still decodes: the run keeps it and warns")
            assertEquals(listOf(0, 0, true), listOf(result.teamCount, result.sprintCount, result.truncated))
        }
    }

    @Test
    fun `invalid ad-hoc payloads are 400, and a non-admin is 403 before the body decodes on every route`() = testApplication {
        start()
        val admin = seededClient("ftestbad", UserRole.ADMIN)
        val user = seededClient("ftestuser", UserRole.USER)
        val invalid = listOf(
            request(token = null), request(token = "jira-style-token"), request(origin = "http://unlisted.test:8080"),
            request(origin = "${FlowStubServer.baseUrl}/x"), request(timeZone = "Mars/Olympus"), request(timeZone = "+01:00"),
        )
        for (bad in invalid) {
            assertEquals(HttpStatusCode.BadRequest, admin.postJson("$BASE/test", bad).status)
        }
        val malformed: io.ktor.client.request.HttpRequestBuilder.() -> Unit = {
            contentType(ContentType.Application.Json)
            setBody("{ not json")
        }
        assertEquals(HttpStatusCode.BadRequest, admin.post("$BASE/test", malformed).status)
        assertEquals(HttpStatusCode.Forbidden, user.post("$BASE/test", malformed).status, "the guard runs before the body decodes")
        assertEquals(HttpStatusCode.Forbidden, user.postJson("$BASE/test", request()).status)
        assertEquals(HttpStatusCode.Forbidden, user.post("$BASE/999999/test").status, "403 whether or not the id exists")
        val anonymous = jsonClient()
        assertEquals(HttpStatusCode.Unauthorized, anonymous.post("$BASE/test").status)
        assertEquals(HttpStatusCode.Unauthorized, anonymous.post("$BASE/1/test").status)
    }

    @Test
    fun `the stored variant is 404 for an unknown or deleted id`() = testApplication {
        start()
        val admin = seededClient("ftest404id", UserRole.ADMIN)
        assertEquals(HttpStatusCode.NotFound, admin.post("$BASE/999999/test").status)
        val created = admin.create(request())
        admin.delete("$BASE/${created.id}")
        assertEquals(HttpStatusCode.NotFound, admin.post("$BASE/${created.id}/test").status)
    }

    @Test
    fun `the stored variant uses the stored token and records the verdict, never the mirror`() = testApplication {
        start()
        val admin = seededClient("ftestpersist", UserRole.ADMIN)
        val created = admin.create(request())
        assertEquals(listOf(null, null, null), listOf(created.lastTestedAt, created.lastTestOk, created.teamsAt))

        val before = System.currentTimeMillis()
        val response = admin.post("$BASE/${created.id}/test")
        assertEquals(HttpStatusCode.OK, response.status)
        val result = response.result()
        assertTrue(result.passed, "${result.rows}")
        assertTrue(result.recorded)
        val stored = admin.connection(created.id)
        assertEquals(true, stored.lastTestOk)
        assertTrue(stored.lastTestedAt!! >= before)
        assertEquals(created.updatedAt, stored.updatedAt, "recording a test is not an edit of the connection")
        assertNull(stored.teamsAt, "Test connection writes no mirror: the run is its single writer")
        for (table in listOf("flow_teams", "flow_sprints", "flow_members")) {
            val rows = jbScalar("SELECT count(*) FROM $table WHERE connection_id = ?", created.id.toInt()) { it.getInt(1) }
            assertEquals(0, rows, table)
        }

        // A wrong stored token is the real verdict, recorded too.
        val wrong = admin.create(request(token = flowToken('x')))
        val failed = admin.post("$BASE/${wrong.id}/test").result()
        assertFalse(failed.passed)
        assertTrue(failed.recorded)
        assertEquals(false, admin.connection(wrong.id).lastTestOk)
    }

    @Test
    fun `a test racing an edit of the connection records nothing`() = testApplication {
        start()
        val admin = seededClient("ftestrace", UserRole.ADMIN)
        val created = admin.create(request())
        FlowStubServer.resetRequests()
        withOverride(answer(mePath, aResponse().withStatus(200).withFixedDelay(3_000).withBody("{}"))) {
            coroutineScope {
                val racing = async { admin.post("$BASE/${created.id}/test") }
                // The target is read BEFORE the call goes out, so once the stub has the request the edit lands under the test, and the
                // stub's delayed answer holds the test open until it has. A bounded poll, not a sleep: it ends the moment the call arrives.
                val meCall = getRequestedFor(urlPathEqualTo(mePath))
                var polls = 0
                while (FlowStubServer.countRequests(meCall) < 1 && polls++ < 100) delay(25)
                val arrived = FlowStubServer.countRequests(meCall) >= 1
                assertTrue(arrived, "the test never reached the stub")
                val edit = request(token = flowToken('y')).copy(name = created.name)
                assertEquals(HttpStatusCode.NoContent, admin.putJson("$BASE/${created.id}", edit).status)
                assertFalse(racing.await().result().recorded, "the result judged the old token")
            }
        }
        assertEquals(listOf(null, null), admin.connection(created.id).let { listOf(it.lastTestedAt, it.lastTestOk) })
    }

    @Test
    fun `a stored token that cannot be decrypted is one typed row, a 200, never a 500, and nothing leaks`() = testApplication {
        start()
        val adminEmail = uniqueEmail("ftestaead")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(adminEmail, "pw")
        val created = admin.create(request())
        // An envelope sealed under ANOTHER key: what a compose/`:server:run` key mismatch over one Postgres leaves behind.
        val foreign = FieldCipher(strongEncryptionKey()).encrypt("never-seen-token")
        jbSql("UPDATE flow_connections SET api_token = ? WHERE id = ?", foreign, created.id.toInt())
        FlowStubServer.resetRequests()
        val root = LogCapture("ROOT")
        try {
            withAuditCapture { audit ->
                val response = admin.post("$BASE/${created.id}/test")
                assertEquals(HttpStatusCode.OK, response.status)
                val row = response.result().rows.single()
                assertEquals(Triple("stored_token", false, "TOKEN_UNREADABLE"), Triple(row.name, row.ok, row.code))
                assertTrue(row.required)
                assertEquals(false, admin.connection(created.id).lastTestOk)
                val event = assertNotNull(audit.awaitEvent { it.isTestOf(created.id) })
                assertTrue(event.hasKeyValue("byUserId", adminId.toLong()) && event.hasKeyValue("ok", false))
                assertTrue(event.hasKeyValue("failedProbes", listOf("stored_token")))
            }
            assertEquals(0, FlowStubServer.countRequests(getRequestedFor(urlPathMatchingAny())), "nothing was called")
            assertTrue(root.events.any { it.formattedMessage.contains("cannot be decrypted") }, "the failure is logged for the operator")
            val logged = root.events.map { it.formattedMessage }
            assertTrue(logged.none { foreign in it || "enc:v1:" in it }, "the envelope is never logged")
        } finally {
            root.detach()
        }
    }

    private fun urlPathMatchingAny() = com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching("/api/v1/integration/.*")

    @Test
    fun `a stored origin the operator no longer lists is BLOCKED_HOST on me and SKIPPED on teams, before any request`() = testApplication {
        start()
        val admin = seededClient("ftestblocked", UserRole.ADMIN)
        val created = admin.create(request())
        jbSql("UPDATE flow_connections SET base_url = ? WHERE id = ?", "http://flow-delisted.test:8080", created.id.toInt())
        FlowStubServer.resetRequests()
        val (me, teams) = admin.post("$BASE/${created.id}/test").result().rows
        assertEquals(Pair(false, "BLOCKED_HOST"), Pair(me.ok, me.code))
        assertEquals("SKIPPED", teams.code)
        assertEquals(0, FlowStubServer.countRequests(getRequestedFor(urlPathMatchingAny())))
    }

    @Test
    fun `the 11th test within a minute from one address is 429 on its own bucket, and the Jira bucket is untouched`() = testApplication {
        start(limit = "")
        val admin = seededClient("ftestrate", UserRole.ADMIN)
        repeat(10) { assertEquals(HttpStatusCode.NotFound, admin.post("$BASE/999999/test").status) }
        assertEquals(HttpStatusCode.TooManyRequests, admin.post("$BASE/999999/test").status)
        val adHoc = admin.postJson("$BASE/test", request())
        assertEquals(HttpStatusCode.TooManyRequests, adHoc.status, "the ad-hoc route rides the same bucket")
        assertEquals(
            HttpStatusCode.NotFound,
            admin.post("/api/v1/integrations/jira/connections/999999/test").status,
            "a Flow flood never spends a Jira test",
        )
    }

    @Test
    fun `a test audits the host, the verdict and the failed probe names - and no log line anywhere carries the token`() = testApplication {
        start()
        val adminEmail = uniqueEmail("ftestaudit")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(adminEmail, "pw")
        val token = flowToken('s')
        val stubHost = FlowStubServer.baseUrl.substringAfter("://")
        val secrets = listOf(token, flowToken('z'), FlowStubServer.token)
        val root = LogCapture("ROOT")
        try {
            withAuditCapture { audit ->
                admin.postJson("$BASE/test", request(token = FlowStubServer.token))
                val adHoc = audit.awaitEvent { it.message == "flow.connection_tested" && it.hasKeyValue("ok", true) }
                assertNotNull(adHoc, "an ad-hoc test audits")
                assertTrue(adHoc.hasKeyValue("byUserId", adminId.toLong()) && adHoc.hasKeyValue("host", stubHost))
                assertTrue(adHoc.hasKeyValue("connectionId", null) && adHoc.hasKeyValue("failedProbes", emptyList<String>()))
                assertTrue(adHoc.hasKeyValue("recorded", false))

                val created = admin.create(request(token = token))
                admin.post("$BASE/${created.id}/test")
                val stored = assertNotNull(audit.awaitEvent { it.isTestOf(created.id) })
                assertTrue(stored.hasKeyValue("ok", false) && stored.hasKeyValue("recorded", true))
                assertTrue(stored.hasKeyValue("failedProbes", listOf("me")), "the SKIPPED teams row is not a failed probe")

                withOverride(answer(teamsPath, aResponse().withStatus(500))) {
                    admin.postJson("$BASE/test", request(token = FlowStubServer.token))
                }
                assertNotNull(audit.awaitEvent { it.isTestFailing("teams") })
                admin.postJson("$BASE/test", request(token = flowToken('z')))
                assertEquals(4, audit.events.count { it.message == "flow.connection_tested" }, "one event per test")
                assertTrue(
                    audit.events.none { event ->
                        secrets.any { it in event.formattedMessage } ||
                            event.keyValuePairs.orEmpty().any { kv -> secrets.any { it in "${kv.value}" } }
                    },
                    "no audit line carries a token",
                )
            }
            val leaks = root.events.filter { event ->
                secrets.any { secret ->
                    secret in event.formattedMessage || secret in event.throwableProxy?.message.orEmpty() ||
                        event.keyValuePairs.orEmpty().any { secret in it.value?.toString().orEmpty() }
                }
            }
            assertTrue(leaks.isEmpty(), "a token reached a log line: ${leaks.map { it.formattedMessage }}")
            assertTrue(root.events.none { "sprintsSince=" in it.formattedMessage }, "no URL with a query string is logged")
        } finally {
            root.detach()
        }
    }
}
