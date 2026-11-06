package ch.nokillswit

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.json.sha256Hex
import ch.nokillswit.jira.JiraAuthScheme
import ch.nokillswit.jira.JiraConnectionRequest
import ch.nokillswit.jira.JiraConnectionResponse
import ch.nokillswit.jira.JiraConnectionServiceKey
import ch.nokillswit.jira.JiraDiscovery
import ch.nokillswit.jira.JiraEstimateMapping
import ch.nokillswit.jira.JiraEstimateUnit
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraLevelFields
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraMappingDefaults
import ch.nokillswit.jira.JiraMappingLevels
import ch.nokillswit.jira.JiraMappingResponse
import ch.nokillswit.jira.JiraPeekResponse
import ch.nokillswit.jira.JiraStatusCategory
import ch.nokillswit.jira.StoredMapping
import ch.nokillswit.jira.parseStoredMapping
import ch.nokillswit.jira.sha256
import ch.nokillswit.jira.toStoredJson
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.users.UserRole
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.equalTo
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching
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
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.BeforeClass
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET`/`PUT /api/v1/integrations/jira/connections/{id}/mapping` and `GET …/{id}/peek` against the shared [JiraStubServer]. Connections
 * are SHARED suite state: every test mints UNIQUE names. The stub's `E2E` project: `E2E-1` Program, `E2E-2`/`E2E-3` Initiatives, `E2E-4`..
 * `E2E-10` Epics (`E2E-5`: 2044-02-01..02-10, 8 story points, team "E2E Team").
 */
class JiraMappingTest {
    private val base = "/api/v1/integrations/jira/connections"
    private val json = Json { ignoreUnknownKeys = true }

    private fun name(prefix: String) = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

    private fun request(token: String = "JTOK-${UUID.randomUUID()}", keys: List<String> = listOf("E2E")) =
        JiraConnectionRequest(
            name("conn"), "https://sample.atlassian.net", "jira.user@example.test", token, JiraAuthScheme.BASIC, keys, true,
        )

    private suspend fun ApplicationTestBuilder.start() {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
    }

    private suspend fun HttpClient.create(request: JiraConnectionRequest = request()): JiraConnectionResponse {
        val response = postJson(base, request)
        assertEquals(HttpStatusCode.Created, response.status)
        return json.decodeFromString(response.bodyAsText())
    }

    /** A connection whose Test connection stored the stub's discovery. */
    private suspend fun HttpClient.discovered(request: JiraConnectionRequest = request()): JiraConnectionResponse {
        val created = create(request)
        assertEquals(HttpStatusCode.OK, post("$base/${created.id}/test").status)
        return connection(created.id)
    }

    private suspend fun HttpClient.connection(id: UInt): JiraConnectionResponse = json.decodeFromString(get("$base/$id").bodyAsText())

    private suspend fun HttpClient.mapping(id: UInt): JiraMappingResponse = json.decodeFromString(get("$base/$id/mapping").bodyAsText())

    private suspend fun HttpClient.peek(id: UInt, key: String): HttpResponse = get("$base/$id/peek?key=$key")

    private suspend fun HttpResponse.problem(): ProblemDetail = body()

    private suspend fun HttpClient.putRaw(id: UInt, text: String): HttpResponse = put("$base/$id/mapping") {
        contentType(ContentType.Application.Json)
        setBody(text)
    }

    private fun sql(statement: String, vararg params: Any) = PostgresTestSupport.connect().use { connection ->
        connection.prepareStatement(statement).use { st ->
            params.forEachIndexed { i, p -> st.setObject(i + 1, p) }
            st.executeUpdate()
        }
    }

    private fun storedMappingText(id: UInt): String = PostgresTestSupport.connect().use { connection ->
        connection.prepareStatement("SELECT mapping::text FROM jira_connections WHERE id = ?").use { st ->
            st.setInt(1, id.toInt())
            st.executeQuery().use { rs -> rs.next(); rs.getString(1) }
        }
    }

    private fun fields(start: String? = "customfield_10022", end: String? = "customfield_10023", estimate: String? = null) =
        JiraLevelFields(start, end, estimate)

    private fun mapping(
        milestone: JiraLevelMapping = JiraLevelMapping(1, fields(estimate = "customfield_10026")),
        project: JiraLevelMapping? = JiraLevelMapping(2, fields()),
        program: JiraLevelMapping? = JiraLevelMapping(3, fields()),
        estimate: JiraEstimateMapping = JiraEstimateMapping(JiraEstimateUnit.POINTS, 0.5),
        team: String? = "customfield_10001",
    ) = JiraMapping(JiraMappingLevels(program, project, milestone), estimate, team)

    private fun path(suffix: String) = urlPathMatching(".*/rest/api/3/$suffix")

    private inline fun <T> withOverride(stub: com.github.tomakehurst.wiremock.client.MappingBuilder, block: () -> T): T {
        val registered = JiraStubServer.addOverride(stub)
        try {
            return block()
        } finally {
            JiraStubServer.removeOverride(registered)
        }
    }

    // --- authorization and the shape of the answers ---------------------------------------------------------------------------------

    @Test
    fun `a non-admin is 403 before the id lookup and the body on all three routes, an anonymous caller 401`() = testApplication {
        start()
        val user = seededClient("jmapuser", UserRole.USER)
        val admin = seededClient("jmapadmin", UserRole.ADMIN)
        val real = admin.discovered().id
        for (id in listOf(real, 999_999u)) {
            assertEquals(HttpStatusCode.Forbidden, user.get("$base/$id/mapping").status)
            assertEquals(HttpStatusCode.Forbidden, user.putRaw(id, "{ not json").status, "the guard runs before the body decodes")
            assertEquals(HttpStatusCode.Forbidden, user.putJson("$base/$id/mapping", mapping()).status)
            assertEquals(HttpStatusCode.Forbidden, user.peek(id, "E2E-5").status)
            assertEquals(HttpStatusCode.Forbidden, user.peek(id, "not-a-key").status, "the guard runs before the key is judged")
        }
        val anonymous = jsonClient()
        assertEquals(HttpStatusCode.Unauthorized, anonymous.get("$base/$real/mapping").status)
        assertEquals(HttpStatusCode.Unauthorized, anonymous.putJson("$base/$real/mapping", mapping()).status)
        assertEquals(HttpStatusCode.Unauthorized, anonymous.get("$base/$real/peek?key=E2E-5").status)
    }

    @Test
    fun `an unknown or deleted connection is 404 on all three routes`() = testApplication {
        start()
        val admin = seededClient("jmap404", UserRole.ADMIN)
        val gone = admin.discovered().id
        assertEquals(HttpStatusCode.NoContent, admin.delete("$base/$gone").status)
        for (id in listOf(999_999u, gone)) {
            assertEquals(HttpStatusCode.NotFound, admin.get("$base/$id/mapping").status)
            assertEquals(HttpStatusCode.NotFound, admin.putJson("$base/$id/mapping", mapping()).status)
            assertEquals(HttpStatusCode.NotFound, admin.peek(id, "E2E-5").status)
        }
    }

    @Test
    fun `GET answers nothing before a discovery, then the defaults as the effective mapping`() = testApplication {
        start()
        val admin = seededClient("jmapget", UserRole.ADMIN)
        val created = admin.create()
        val before = admin.get("$base/${created.id}/mapping")
        assertEquals(HttpStatusCode.OK, before.status, "a read never answers 409")
        assertEquals(listOf(null, null, null, null), before.bodyAsText().let { json.decodeFromString<JiraMappingResponse>(it) }.let {
            listOf(it.mapping, it.defaults, it.effective, it.discoveredAt)
        })
        assertEquals(HttpStatusCode.OK, admin.post("$base/${created.id}/test").status)
        val after = admin.mapping(created.id)
        assertNull(after.mapping)
        assertEquals(after.defaults, after.effective)
        assertEquals(admin.connection(created.id).discoveredAt, after.discoveredAt)
        val discovery = json.decodeFromString<JiraDiscovery>(admin.get("$base/${created.id}/discovery").bodyAsText())
        assertEquals(JiraMappingDefaults.resolve(discovery), after.defaults)
        val milestone = checkNotNull(after.defaults).levels.milestone
        assertEquals(
            Triple(1, "customfield_10022", "customfield_10026"),
            Triple(milestone.hierarchyLevel, milestone.fields.start, milestone.fields.estimate),
        )
        assertEquals(false, admin.connection(created.id).mappingSet)
    }

    // --- PUT: 409 before discovery, the round trip, the audit -----------------------------------------------------------------------

    @Test
    fun `PUT is 409 jira-not-discovered before any discovery, and a malformed document is still a 400`() = testApplication {
        start()
        val admin = seededClient("jmap409", UserRole.ADMIN)
        val created = admin.create()
        val refused = admin.putJson("$base/${created.id}/mapping", mapping())
        assertEquals(HttpStatusCode.Conflict, refused.status)
        assertEquals("urn:astrolabe:problem:jira-not-discovered", refused.problem().type)
        val misordered = mapping(project = JiraLevelMapping(1, fields()))
        val shape = admin.putJson("$base/${created.id}/mapping", misordered)
        assertEquals(HttpStatusCode.BadRequest, shape.status, "the shape rules need no discovery")
        assertEquals(false, admin.connection(created.id).mappingSet)
    }

    @Test
    fun `a discovery that exists although the last test failed is enough to save a mapping`() = testApplication {
        start()
        val admin = seededClient("jmapd3", UserRole.ADMIN)
        val created = admin.create()
        withOverride(get(path("search/jql")).atPriority(1).willReturn(aResponse().withStatus(403))) {
            assertEquals(HttpStatusCode.OK, admin.post("$base/${created.id}/test").status)
        }
        assertEquals(false, admin.connection(created.id).lastTestOk, "the real verdict is a failure")
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}/mapping", mapping()).status)
    }

    @Test
    fun `PUT stores the canonical document, GET returns it as effective, and nothing else of the connection changes`() = testApplication {
        start()
        val admin = seededClient("jmapput", UserRole.ADMIN)
        val created = admin.discovered()
        val sent = mapping()
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}/mapping", sent).status)
        val read = admin.mapping(created.id)
        assertEquals(sent, read.mapping)
        assertEquals(sent, read.effective)
        assertNotNull(read.defaults)
        val stored = admin.connection(created.id)
        assertTrue(stored.mappingSet)
        assertEquals(
            listOf(created.discoveredAt, created.cloudId, created.lastTestOk, created.lastTestedAt, created.enabled, created.updatedAt),
            listOf(stored.discoveredAt, stored.cloudId, stored.lastTestOk, stored.lastTestedAt, stored.enabled, stored.updatedAt),
            "a mapping change rewrites nothing else",
        )
        // The column holds the canonical document: the same VALUES (jsonb reformats the bytes), and re-encoding it is a fixed point.
        val text = storedMappingText(created.id)
        val reread = (parseStoredMapping(text) as StoredMapping.Valid).mapping
        assertEquals(sent, reread)
        assertEquals(sent.toStoredJson(), reread.toStoredJson())
        // A later Test connection replaces the discovery, never the mapping.
        assertEquals(HttpStatusCode.OK, admin.post("$base/${created.id}/test").status)
        assertEquals(sent, admin.mapping(created.id).mapping)
    }

    @Test
    fun `key order and omitted defaults do not change the canonical document or its digest`() = testApplication {
        start()
        val admin = seededClient("jmapcanon", UserRole.ADMIN)
        val created = admin.discovered()
        val reordered = """{"teamFieldId":"customfield_10001","estimate":{"unit":"POINTS"},"levels":{"milestone":""" +
            """{"fields":{"end":"customfield_10023","start":"customfield_10022"},"hierarchyLevel":1}}}"""
        val minimal = JiraMapping(
            JiraMappingLevels(milestone = JiraLevelMapping(1, JiraLevelFields("customfield_10022", "customfield_10023", null))),
            JiraEstimateMapping(JiraEstimateUnit.POINTS, null),
            "customfield_10001",
        )
        withAuditCapture { audit ->
            assertEquals(HttpStatusCode.NoContent, admin.putRaw(created.id, reordered).status)
            assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}/mapping", minimal).status)
            val events = audit.events.filter { it.message == "jira.mapping_changed" && it.hasKeyValue("connectionId", created.id.toLong()) }
            assertEquals(2, events.size)
            val digest = sha256Hex(minimal.toStoredJson())
            assertEquals(minimal.sha256(), digest)
            assertTrue(events.all { it.hasKeyValue("afterSha256", digest) }, "the same document, the same digest")
            assertTrue(events[1].hasKeyValue("beforeSha256", digest), "the second PUT replaced an identical document")
        }
    }

    @Test
    fun `PUT audits who, which connection and the digests before and after - never the document`() = testApplication {
        start()
        val adminEmail = uniqueEmail("jmapaudit")
        val adminId = TestUsers.seed(email = adminEmail, password = "pw", role = UserRole.ADMIN)
        val admin = authedClient(adminEmail, "pw")
        val created = admin.discovered()
        val first = mapping()
        val second = mapping(estimate = JiraEstimateMapping(JiraEstimateUnit.DAYS, null), team = null)
        withAuditCapture { audit ->
            admin.putJson("$base/${created.id}/mapping", first)
            admin.putJson("$base/${created.id}/mapping", second)
            admin.putJson("$base/${created.id}/mapping", mapping(project = JiraLevelMapping(1, fields()))) // refused: no event
            val events = audit.events.filter { it.message == "jira.mapping_changed" && it.hasKeyValue("connectionId", created.id.toLong()) }
            assertEquals(2, events.size, "one event per accepted PUT, none for a refused one")
            assertTrue(events.all { it.hasKeyValue("byUserId", adminId.toLong()) })
            assertTrue(events[0].hasKeyValue("beforeSha256", null) && events[0].hasKeyValue("afterSha256", first.sha256()))
            assertTrue(events[1].hasKeyValue("beforeSha256", first.sha256()) && events[1].hasKeyValue("afterSha256", second.sha256()))
            assertTrue(events.none { event -> event.keyValuePairs.orEmpty().any { "customfield" in it.value?.toString().orEmpty() } })
        }
    }

    // --- the validator matrix -------------------------------------------------------------------------------------------------------

    @Test
    fun `every rule violation is a 400 that stores nothing and audits nothing`() = testApplication {
        start()
        val admin = seededClient("jmapbad", UserRole.ADMIN)
        val created = admin.discovered()
        val kept = mapping()
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}/mapping", kept).status)
        fun level(n: Int, f: JiraLevelFields = fields()) = JiraLevelMapping(n, f)
        val refused: Map<String, JiraMapping> = mapOf(
            "program level equal to the project level" to mapping(program = level(2)),
            "project level above the program level" to mapping(program = level(2), project = level(3)),
            "milestone level equal to the project level" to mapping(milestone = level(2)),
            "milestone level above the project level" to mapping(milestone = level(3), project = level(2)),
            "program below the milestone with no project" to mapping(program = level(0), project = null),
            "no issue type at the level" to mapping(milestone = level(9), project = null, program = null),
            "the sub-task level" to mapping(milestone = level(-1), project = null, program = null),
            "a datetime start (A5)" to mapping(milestone = level(1, fields(start = "customfield_10030"))),
            "a datetime end (A5)" to mapping(milestone = level(1, fields(end = "created"))),
            "a number as start" to mapping(milestone = level(1, fields(start = "customfield_10035"))),
            "a field the discovery does not know" to mapping(milestone = level(1, fields(end = "customfield_99999"))),
            "a date as the estimate" to mapping(milestone = level(1, fields(estimate = "customfield_10015"))),
            "a datetime as the estimate" to mapping(milestone = level(1, fields(estimate = "customfield_10031"))),
            "a malformed field id" to mapping(milestone = level(1, fields(start = "customfield_1; DROP"))),
            "an unknown Team field" to mapping(team = "customfield_99999"),
            "a number field as the Team field" to mapping(team = "customfield_10026"),
            "a negative project level" to mapping(project = level(-5), program = null),
            "a zero factor" to mapping(estimate = JiraEstimateMapping(JiraEstimateUnit.POINTS, 0.0)),
            "a negative factor" to mapping(estimate = JiraEstimateMapping(JiraEstimateUnit.POINTS, -1.0)),
            "a factor over 1000" to mapping(estimate = JiraEstimateMapping(JiraEstimateUnit.HOURS, 1000.01)),
            "a factor with three decimals" to mapping(estimate = JiraEstimateMapping(JiraEstimateUnit.DAYS, 0.125)),
            "a tiny factor" to mapping(estimate = JiraEstimateMapping(JiraEstimateUnit.POINTS, 0.001)),
        )
        withAuditCapture { audit ->
            for ((what, bad) in refused) {
                val response = admin.putJson("$base/${created.id}/mapping", bad)
                assertEquals(HttpStatusCode.BadRequest, response.status, what)
                assertTrue(response.problem().detail.orEmpty().isNotBlank(), what)
            }
            assertEquals(kept, admin.mapping(created.id).mapping, "a refused PUT stores nothing")
            val changed = audit.events.count { it.message == "jira.mapping_changed" && it.hasKeyValue("connectionId", created.id.toLong()) }
            assertEquals(0, changed)
        }
    }

    @Test
    fun `the datetime refusal names the reason, and the structural errors are 400`() = testApplication {
        start()
        val admin = seededClient("jmapdt", UserRole.ADMIN)
        val created = admin.discovered()
        val onDatetime = mapping(milestone = JiraLevelMapping(1, fields(start = "customfield_10030")))
        val datetime = admin.putJson("$base/${created.id}/mapping", onDatetime)
        assertEquals(HttpStatusCode.BadRequest, datetime.status)
        assertTrue("datetime" in datetime.problem().detail.orEmpty() && "time zone" in datetime.problem().detail.orEmpty())
        val bodies = listOf(
            "no milestone" to """{"levels":{"project":{"hierarchyLevel":2}}}""",
            "a null milestone" to """{"levels":{"milestone":null}}""",
            "no levels" to """{"estimate":{"unit":"POINTS"}}""",
            "an unknown unit" to """{"levels":{"milestone":{"hierarchyLevel":1}},"estimate":{"unit":"WEEKS"}}""",
            "an unknown member" to """{"levels":{"milestone":{"hierarchyLevel":1}},"surprise":1}""",
            "a non-finite factor" to """{"levels":{"milestone":{"hierarchyLevel":1}},"estimate":{"manDaysPerUnit":NaN}}""",
            "not JSON" to "{ not json",
        )
        for ((what, body) in bodies) {
            assertEquals(HttpStatusCode.BadRequest, admin.putRaw(created.id, body).status, what)
        }
        assertEquals(false, admin.connection(created.id).mappingSet)
    }

    @Test
    fun `the accepted extremes save - duedate as the end, factors 1000 and 0_01, every unit, no optional parts`() = testApplication {
        start()
        val admin = seededClient("jmapok", UserRole.ADMIN)
        val created = admin.discovered()
        val accepted = listOf(
            mapping(milestone = JiraLevelMapping(1, fields(start = "customfield_10015", end = "duedate"))),
            mapping(estimate = JiraEstimateMapping(JiraEstimateUnit.POINTS, 1000.0)),
            mapping(estimate = JiraEstimateMapping(JiraEstimateUnit.HOURS, 0.01)),
            mapping(estimate = JiraEstimateMapping(JiraEstimateUnit.DAYS, 25.25)),
            mapping(estimate = JiraEstimateMapping(JiraEstimateUnit.DAYS, null), team = null),
            mapping(milestone = JiraLevelMapping(0), project = null, program = null),
            mapping(milestone = JiraLevelMapping(1, JiraLevelFields()), program = JiraLevelMapping(3)),
        )
        for (document in accepted) {
            assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}/mapping", document).status, "$document")
            assertEquals(document, admin.mapping(created.id).mapping)
        }
        // The decoder is lenient about quoted numbers (Ktor's default JSON): a string level is read as the number and stored as one.
        assertEquals(HttpStatusCode.NoContent, admin.putRaw(created.id, """{"levels":{"milestone":{"hierarchyLevel":"1"}}}""").status)
        assertEquals(1, admin.mapping(created.id).mapping?.levels?.milestone?.hierarchyLevel)
    }

    @Test
    fun `the service enforces the rules itself, not only the route`() = testApplication {
        start()
        val admin = seededClient("jmapsvc", UserRole.ADMIN)
        val undiscovered = admin.create()
        val discovered = admin.discovered()
        val service = application.attributes[JiraConnectionServiceKey]
        assertFailsWith<ConflictException> { runBlocking { service.writeMapping(undiscovered.id, mapping()) } }
        assertFailsWith<BadRequestException> {
            val onDatetime = mapping(milestone = JiraLevelMapping(1, fields(start = "customfield_10030")))
            runBlocking { service.writeMapping(discovered.id, onDatetime) }
        }
        assertFailsWith<BadRequestException> { runBlocking { service.writeMapping(discovered.id, mapping(project = JiraLevelMapping(1))) } }
        assertNull(runBlocking { service.writeMapping(999_999u, mapping()) })
        assertEquals(false, admin.connection(discovered.id).mappingSet)
    }

    // --- Peek -----------------------------------------------------------------------------------------------------------------------

    @Test
    fun `Peek reads an epic through the default mapping and returns the mapped fields and nothing else`() = testApplication {
        start()
        val admin = seededClient("jpeek", UserRole.ADMIN)
        val created = admin.discovered()
        val response = admin.peek(created.id, "E2E-5")
        assertEquals(HttpStatusCode.OK, response.status)
        val peek = json.decodeFromString<JiraPeekResponse>(response.bodyAsText())
        with(peek.issue) {
            assertEquals(listOf("90005", "E2E-5", "E2E Epic Two", "Epic", 1), listOf(id, key, summary, typeName, hierarchyLevel))
            assertEquals(JiraStatusCategory.TODO, statusCategory)
            assertEquals("E2E-2", parentKey)
        }
        with(peek.resolved) {
            assertEquals(JiraLevel.MILESTONE, level)
            assertEquals(listOf("2044-02-01", "2044-02-10", 8.0), listOf(start, end, estimate))
            assertEquals(JiraEstimateUnit.POINTS, unit)
            assertEquals("E2E Team", teamName)
        }
        // The stub answers a superset (parent, created, Rank, ...): only the mapped ids may come back.
        assertEquals(setOf("customfield_10022", "customfield_10023", "customfield_10026", "customfield_10001"), peek.raw.keys)
        assertEquals(JsonPrimitive("2044-02-01"), peek.raw["customfield_10022"])
        assertEquals(JsonPrimitive(8), peek.raw["customfield_10026"])
        val text = response.bodyAsText()
        assertTrue("customfield_10019" !in text && "\"created\"" !in text && "0|i90005" !in text, "nothing beyond the declared fields")
    }

    @Test
    fun `Peek follows the stored mapping - other fields, other levels, an unmapped level and a missing value`() = testApplication {
        start()
        val admin = seededClient("jpeekmap", UserRole.ADMIN)
        val created = admin.discovered()
        val stored = mapping(
            milestone = JiraLevelMapping(1, fields(start = "customfield_10015", end = "duedate", estimate = "customfield_10016")),
            project = JiraLevelMapping(2, fields()),
            program = null,
            team = null,
        )
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}/mapping", stored).status)
        val epic = json.decodeFromString<JiraPeekResponse>(admin.peek(created.id, "E2E-5").bodyAsText())
        assertEquals(setOf("customfield_10015", "duedate", "customfield_10016", "customfield_10022", "customfield_10023"), epic.raw.keys)
        assertEquals(JsonNull, epic.raw["customfield_10015"], "a field present as null reads as null")
        with(epic.resolved) { assertEquals(listOf(null, null, null, null), listOf(start, end, estimate, teamName)) }
        val initiative = json.decodeFromString<JiraPeekResponse>(admin.peek(created.id, "E2E-2").bodyAsText())
        assertEquals(JiraLevel.PROJECT, initiative.resolved.level)
        assertEquals("2044-01-04" to "2044-02-18", initiative.resolved.start to initiative.resolved.end)
        val program = json.decodeFromString<JiraPeekResponse>(admin.peek(created.id, "E2E-1").bodyAsText())
        assertNull(program.resolved.level, "level 3 is not mapped here")
        assertEquals(listOf(null, null, null), listOf(program.resolved.start, program.resolved.end, program.resolved.estimate))
        assertEquals(3, program.issue.hierarchyLevel)
    }

    @Test
    fun `Peek asks Jira for exactly the system fields and the mapped ones`() = testApplication {
        start()
        val admin = seededClient("jpeekfields", UserRole.ADMIN)
        val created = admin.discovered()
        val expected = "summary,issuetype,status,parent,customfield_10022,customfield_10023,customfield_10026,customfield_10001"
        val body = """{"id":"90005","key":"E2E-5","fields":{"summary":"FIELDS-MATCHED"}}"""
        val onlyThisQuery = get(path("issue/E2E-5")).atPriority(1).withQueryParam("fields", equalTo(expected))
        withOverride(onlyThisQuery.willReturn(aResponse().withStatus(200).withBody(body))) {
            val peek = json.decodeFromString<JiraPeekResponse>(admin.peek(created.id, "E2E-5").bodyAsText())
            assertEquals("FIELDS-MATCHED", peek.issue.summary)
            assertEquals(emptyMap(), peek.raw, "absent fields are absent, not invented")
            assertNull(peek.issue.hierarchyLevel)
            assertEquals(JiraStatusCategory.UNKNOWN, peek.issue.statusCategory)
            assertNull(peek.resolved.level)
        }
    }

    @Test
    fun `Peek refuses a key that is not an issue key - 400, whatever exists`() = testApplication {
        start()
        val admin = seededClient("jpeek400", UserRole.ADMIN)
        val created = admin.discovered()
        for (key in listOf("e2e-5", "E2E5", "E2E-", "E2E-5%20OR%20x", "E2E-5;", "5-E2E", "ABCDEFGHIJK-1", "-")) {
            assertEquals(HttpStatusCode.BadRequest, admin.peek(created.id, key).status, key)
        }
        assertEquals(HttpStatusCode.BadRequest, admin.get("$base/${created.id}/peek").status, "a missing key")
    }

    @Test
    fun `Peek refuses a key outside the connection's projects, and a moved issue is judged by the key Jira returns`() = testApplication {
        start()
        val admin = seededClient("jpeekscope", UserRole.ADMIN)
        val created = admin.discovered()
        val outside = admin.peek(created.id, "CE-1")
        assertEquals(HttpStatusCode.BadRequest, outside.status)
        assertTrue("outside the connection's project keys" in outside.problem().detail.orEmpty())
        // A key of the scope that Jira reports under another project (a moved issue).
        val moved = """{"id":"90005","key":"OUT-1","fields":{"summary":"moved"}}"""
        withOverride(get(path("issue/E2E-5")).atPriority(1).willReturn(aResponse().withStatus(200).withBody(moved))) {
            val response = admin.peek(created.id, "E2E-5")
            assertEquals(HttpStatusCode.BadRequest, response.status)
            assertTrue("moved" !in response.bodyAsText(), "nothing of the out-of-scope issue is returned")
        }
    }

    @Test
    fun `Peek is 404 for a key Jira does not know and 409 before a discovery`() = testApplication {
        start()
        val admin = seededClient("jpeek404", UserRole.ADMIN)
        val created = admin.discovered()
        val unknown = admin.peek(created.id, "E2E-999")
        assertEquals(HttpStatusCode.NotFound, unknown.status)
        assertTrue("Jira issue not found" in unknown.problem().detail.orEmpty())
        val fresh = admin.create()
        val refused = admin.peek(fresh.id, "E2E-5")
        assertEquals(HttpStatusCode.Conflict, refused.status)
        assertEquals("urn:astrolabe:problem:jira-not-discovered", refused.problem().type)
    }

    @Test
    fun `Peek with a stored token that cannot be decrypted is a typed 409, and the envelope is never logged`() = testApplication {
        start()
        val admin = seededClient("jpeekaead", UserRole.ADMIN)
        val created = admin.discovered()
        val foreign = FieldCipher(strongEncryptionKey()).encrypt("never-seen-token")
        sql("UPDATE jira_connections SET api_token = ? WHERE id = ?", foreign, created.id.toInt())
        val root = LogCapture("ROOT")
        try {
            val response = admin.peek(created.id, "E2E-5")
            assertEquals(HttpStatusCode.Conflict, response.status)
            assertEquals("urn:astrolabe:problem:jira-token-unreadable", response.problem().type)
            assertTrue(root.events.none { foreign in it.formattedMessage || "enc:v1:" in it.formattedMessage })
            assertTrue(foreign !in response.bodyAsText())
        } finally {
            root.detach()
        }
    }

    @Test
    fun `Peek answers an upstream failure as a typed 502 that carries the code only`() = testApplication {
        start()
        val admin = seededClient("jpeek502", UserRole.ADMIN)
        val token = "JTOK-${UUID.randomUUID()}"
        val created = admin.discovered(request(token))
        withOverride(get(path("issue/E2E-5")).atPriority(1).willReturn(aResponse().withStatus(503))) {
            val outage = admin.peek(created.id, "E2E-5")
            assertEquals(HttpStatusCode.BadGateway, outage.status)
            assertEquals("urn:astrolabe:problem:jira-upstream", outage.problem().type)
            assertTrue("UPSTREAM_UNAVAILABLE" in outage.problem().detail.orEmpty())
            assertTrue("http" !in outage.bodyAsText() && token !in outage.bodyAsText() && "rest/api" !in outage.bodyAsText())
        }
        withOverride(get(path("issue/E2E-5")).atPriority(1).willReturn(aResponse().withStatus(200).withBody("[]"))) {
            assertTrue("INVALID_RESPONSE" in admin.peek(created.id, "E2E-5").problem().detail.orEmpty())
        }
        withOverride(get(urlPathMatching("/_edge/tenant_info")).atPriority(1).willReturn(aResponse().withStatus(404))) {
            val noTenant = admin.peek(created.id, "E2E-5")
            assertEquals(HttpStatusCode.BadGateway, noTenant.status, "a missing tenant is the upstream's failure, not an unknown issue")
        }
        // A token the site refuses (rotated after the discovery): tenant_info answers, the issue read is a 401.
        val rotated = request("wrong-token").copy(name = created.name)
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}", rotated).status)
        val unauthorised = admin.peek(created.id, "E2E-5")
        assertEquals(HttpStatusCode.BadGateway, unauthorised.status)
        assertTrue("AUTHENTICATION_FAILED" in unauthorised.problem().detail.orEmpty())
        assertTrue("wrong-token" !in unauthorised.bodyAsText())
    }

    @Test
    fun `Peek refuses a stored site that is no longer a genuine tenant before any request`() = testApplication {
        start()
        val admin = seededClient("jpeeksite", UserRole.ADMIN)
        val created = admin.discovered()
        sql("UPDATE jira_connections SET site_url = ? WHERE id = ?", "https://evil.example.com", created.id.toInt())
        val response = admin.peek(created.id, "E2E-5")
        assertEquals(HttpStatusCode.BadGateway, response.status)
        assertTrue("BLOCKED_HOST" in response.problem().detail.orEmpty())
    }

    @Test
    fun `Peek stores nothing and audits nothing`() = testApplication {
        start()
        val admin = seededClient("jpeekquiet", UserRole.ADMIN)
        val created = admin.discovered()
        val before = admin.connection(created.id)
        withAuditCapture { audit ->
            assertEquals(HttpStatusCode.OK, admin.peek(created.id, "E2E-5").status)
            assertEquals(HttpStatusCode.NotFound, admin.peek(created.id, "E2E-999").status)
            assertEquals(before, admin.connection(created.id))
            // A positive control that cannot false-pass: events arrive in order, so once the audited PUT below is seen, any event a Peek
            // had emitted before it is already in the list.
            assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}/mapping", mapping()).status)
            assertNotNull(audit.awaitEvent { it.message == "jira.mapping_changed" && it.hasKeyValue("connectionId", created.id.toLong()) })
            val ours = audit.events.filter { it.hasKeyValue("connectionId", created.id.toLong()) }
            assertEquals(listOf("jira.mapping_changed"), ours.map { it.message }, "the two Peeks emitted nothing")
        }
    }

    @Test
    fun `the 11th Peek within a minute from one address is 429 on the Test connection bucket`() = testApplication {
        start()
        val admin = seededClient("jpeekrate", UserRole.ADMIN)
        repeat(10) { assertEquals(HttpStatusCode.NotFound, admin.peek(999_999u, "E2E-5").status) }
        assertEquals(HttpStatusCode.TooManyRequests, admin.peek(999_999u, "E2E-5").status)
        assertEquals(HttpStatusCode.TooManyRequests, admin.post("$base/999999/test").status, "one bucket for both")
    }

    @Test
    fun `a mapping PUT landing between readForTest and recordTest does not make the test drop its result`() = testApplication {
        start()
        val admin = seededClient("jmaprace", UserRole.ADMIN)
        val created = admin.discovered()
        val service = application.attributes[JiraConnectionServiceKey]
        val target = assertNotNull(service.readForTest(created.id))
        val sent = mapping()
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}/mapping", sent).status)
        val recording = service.recordTest(created.id, checkNotNull(target.expectedUpdatedAt), JiraStubServer.CLOUD_ID, true, null, 1L)
        assertEquals(true, recording.recorded)
        assertEquals(sent, admin.mapping(created.id).mapping, "the mapping is intact")
        assertEquals(1L, admin.connection(created.id).lastTestedAt)
    }

    @Test
    fun `a stored mapping a later discovery outgrew is listed in problems and never rewritten`() = testApplication {
        start()
        val admin = seededClient("jmapstale", UserRole.ADMIN)
        val created = admin.discovered()
        val sent = mapping()
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}/mapping", sent).status)
        assertEquals(emptyList(), admin.mapping(created.id).problems)
        // The site lost its level-3 type, and its "Target start" is now a datetime.
        val snapshot = Json.parseToJsonElement(admin.get("$base/${created.id}/discovery").bodyAsText()).jsonObject
        fun JsonObject.without(key: String) = JsonObject(filterKeys { it != key })
        val levels = snapshot.getValue("levels").jsonArray.filter { it.jsonObject.getValue("level").jsonPrimitive.int != 3 }
        val fields = snapshot.getValue("fields").jsonArray.map {
            val field = it.jsonObject
            val retyped = field.getValue("id").jsonPrimitive.content == "customfield_10022"
            if (retyped) JsonObject(field + ("type" to JsonPrimitive("datetime"))) else field
        }
        val changed = JsonObject(snapshot + mapOf("levels" to JsonArray(levels), "fields" to JsonArray(fields)))
        sql("UPDATE jira_connections SET discovery = ?::jsonb WHERE id = ?", changed.toString(), created.id.toInt())
        val read = admin.mapping(created.id)
        assertEquals(sent, read.mapping, "the stored document is untouched")
        assertEquals(sent, read.effective)
        assertTrue(read.problems.any { "hierarchy level 3" in it && "program" in it }, "${read.problems}")
        assertTrue(read.problems.any { "customfield_10022" in it && "datetime" in it }, "${read.problems}")
        assertEquals(HttpStatusCode.OK, admin.peek(created.id, "E2E-5").status, "Peek still reads through the stored mapping")
        // Saving it again is refused until it is corrected.
        assertEquals(HttpStatusCode.BadRequest, admin.putJson("$base/${created.id}/mapping", sent).status)
        assertEquals(sent, admin.mapping(created.id).mapping)
    }

    @Test
    fun `a stored mapping column this build cannot decode is a problem line - GET and Peek never answer 500`() = testApplication {
        start()
        val admin = seededClient("jmapold", UserRole.ADMIN)
        val created = admin.discovered()
        val olds = listOf(
            """{"levels":"x"}""", """{"program":{"hierarchyLevel":3}}""", """{"levels":{"milestone":{"hierarchyLevel":"deep"}}}""",
        )
        for (old in olds) {
            sql("UPDATE jira_connections SET mapping = ?::jsonb WHERE id = ?", old, created.id.toInt())
            val read = admin.mapping(created.id)
            assertNull(read.mapping, old)
            assertEquals(read.defaults, read.effective, "an unreadable mapping falls back to the defaults")
            assertTrue(read.problems.single().contains("cannot be read"), old)
            assertEquals(HttpStatusCode.OK, admin.peek(created.id, "E2E-5").status, old)
            val test = admin.post("$base/${created.id}/test")
            assertEquals(HttpStatusCode.OK, test.status, "a Test connection never fails on the mapping column")
            assertEquals(HttpStatusCode.NoContent, admin.putJson("$base/${created.id}/mapping", mapping()).status, "it can be replaced")
            assertEquals(emptyList(), admin.mapping(created.id).problems)
        }
        // An undecodable discovery snapshot reads as no discovery (the next Test replaces it), not as a 500.
        sql("UPDATE jira_connections SET discovery = '{\"fields\":1}'::jsonb WHERE id = ?", created.id.toInt())
        assertEquals(HttpStatusCode.OK, admin.get("$base/${created.id}/mapping").status)
        assertEquals(HttpStatusCode.Conflict, admin.peek(created.id, "E2E-5").status)
        assertEquals(HttpStatusCode.Conflict, admin.putJson("$base/${created.id}/mapping", mapping()).status)
    }

    @Test
    fun `a repeated key on Peek is a 400`() = testApplication {
        start()
        val admin = seededClient("jpeekrepeat", UserRole.ADMIN)
        val created = admin.discovered()
        assertEquals(HttpStatusCode.BadRequest, admin.get("$base/${created.id}/peek?key=E2E-5&key=E2E-4").status)
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
