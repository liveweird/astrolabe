package ch.nokillswit

import com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor
import com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.AfterClass
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Pins the contract of the Flow stub (`sample-data/flow/README.md`) over plain HTTP against the generator's own `expected.json`, so the
 * contract (`contract.mjs`), the dataset, the mappings and the figures a later step compares with cannot drift apart; also that the stub
 * image runs the same pinned WireMock as the Jira stub and the test dependency. Everything is read through [FlowStubServer], warmed in a
 * `@BeforeClass` like every reader of it. The server's own decoder (`flow/FlowDocument.kt`, v1.5.0 C3) replays the same documents in
 * `FlowClientTest`; here the keys are compared with `expected.json` `contract.fields`, so a renamed field fails in both places.
 */
class FlowStubFixtureTest {
    private companion object {
        const val DAY2 = "flow-day2"
        const val OUTAGE = "flow-outage"
        const val JOURNAL_ENTRIES = 50

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

        private fun repoFile(path: String): File =
            File(System.getProperty("repo.root") ?: "..", path).also { assertTrue(it.exists(), "$path not found (${it.absolutePath})") }

        val expected: JsonObject get() = FlowStubServer.expected
        val http: HttpClient = HttpClient.newHttpClient()
    }

    private class Answer(val status: Int, val body: String, val contentType: String?) {
        val obj: JsonObject get() = Json.parseToJsonElement(body).jsonObject
    }

    private fun call(
        path: String,
        query: String = "",
        authorization: String? = FlowStubServer.authorization,
        method: String = "GET",
    ): Answer {
        val request = HttpRequest.newBuilder(URI.create("${FlowStubServer.baseUrl}$path$query")).timeout(Duration.ofSeconds(30))
            .method(method, HttpRequest.BodyPublishers.noBody()).apply { authorization?.let { header("Authorization", it) } }.build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofString())
        return Answer(response.statusCode(), response.body(), response.headers().firstValue("Content-Type").orElse(null))
    }

    private fun teams(since: String = FlowStubServer.defaultSinceQuery) = call(FlowStubServer.teamsPath, since)

    private fun teamsAs(authorization: String?) = call(FlowStubServer.teamsPath, FlowStubServer.defaultSinceQuery, authorization)

    private fun figure(vararg path: String): JsonElement = path.fold(expected as JsonElement) { node, key -> node.jsonObject.getValue(key) }

    private fun strings(vararg path: String): List<String> = figure(*path).jsonArray.map { it.jsonPrimitive.content }

    private fun JsonElement.str(key: String): String = jsonObject.getValue(key).jsonPrimitive.content

    private fun JsonElement.int(vararg path: String): Int =
        path.fold(this) { node, key -> node.jsonObject.getValue(key) }.jsonPrimitive.content.toInt()

    /** The objects of the array under [key]. */
    private fun JsonElement.objects(key: String): List<JsonObject> = jsonObject.getValue(key).jsonArray.map { it.jsonObject }

    private fun items(answer: Answer): Map<String, JsonObject> = answer.obj.objects("items").associateBy { it.str("name") }

    /** A WELL-FORMED bearer the stub does not know, and a MALFORMED one (the shape check fails before any lookup). */
    private val strangerToken = "Bearer flow_int_${"y".repeat(43)}"
    private val malformedToken = "Bearer flow_int_too-short"

    private fun planted(vararg path: String): String = figure("planted", *path).jsonPrimitive.content

    private fun assertProblem(answer: Answer, status: Int, detail: String? = null) {
        assertEquals(status, answer.status, answer.body.take(200))
        assertTrue(answer.contentType?.startsWith("application/problem+json") == true, "problem+json expected, got ${answer.contentType}")
        val problem = answer.obj
        assertEquals(status, problem.getValue("status").jsonPrimitive.content.toInt())
        detail?.let { assertEquals(it, problem.str("detail")) }
    }

    @Test
    fun `me answers the token's facts under exactly the contract's keys`() {
        val answer = call(FlowStubServer.mePath)
        assertEquals(200, answer.status, answer.body.take(200))
        assertEquals(strings("contract", "fields", "me"), answer.obj.keys.toList())
        assertEquals(figure("me"), answer.obj)
        assertEquals("astrolabe", answer.obj.str("name"))
        assertEquals(JsonNull, answer.obj.getValue("expiresAt"))
    }

    @Test
    fun `every other credential form is the one uniform 401 on both endpoints`() {
        val uniform = figure("contract", "unauthorized").jsonObject
        val bare = FlowStubServer.token
        val forms = mapOf(
            "no header" to null,
            "another scheme" to "Basic " + Base64.getEncoder().encodeToString("astrolabe:$bare".toByteArray()),
            "a wrong token" to "Bearer flow_int_${"x".repeat(43)}",
            "the token without a scheme" to bare,
            "another app's prefix" to "Bearer lettuce_int_${"x".repeat(43)}",
            "a JWT-shaped bearer" to "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
            "an empty bearer" to "Bearer ",
        )
        for ((label, header) in forms) {
            for (path in listOf(FlowStubServer.mePath, FlowStubServer.teamsPath)) {
                val answer = call(path, FlowStubServer.defaultSinceQuery, authorization = header)
                assertProblem(answer, 401, uniform.str("detail"))
                assertEquals(uniform, answer.obj, "$label on $path: one body for every reason")
            }
        }
        // The catch-all is the namespace's, not the two operations': a non-GET method (Flow would answer 404/405) or another
        // path under it is the same 401.
        assertProblem(call(FlowStubServer.teamsPath, method = "POST"), 401)
        assertProblem(call("/api/v1/integration/unknown"), 401)
        assertProblem(call("/api/v1/integration/unknown", authorization = null), 401)
    }

    @Test
    fun `teams answers one document under exactly the contract's keys, equal to the generator's figures`() {
        val answer = teams()
        assertEquals(200, answer.status, answer.body.take(200))
        val document = answer.obj
        assertEquals(strings("contract", "fields", "teams"), document.keys.toList())
        assertEquals(figure("document", "asOf"), document.getValue("asOf"))
        assertEquals(figure("document", "sprintsSince"), document.getValue("sprintsSince"))
        assertEquals(false, document.getValue("sprintsTruncated").jsonPrimitive.content.toBoolean())
        val served = document.getValue("items").jsonArray.map { it.jsonObject }
        assertEquals(figure("totals", "teams").jsonPrimitive.content.toInt(), served.size)
        assertEquals(figure("totals", "sprints").jsonPrimitive.content.toInt(), served.sumOf { it.getValue("sprints").jsonArray.size })
        assertEquals(figure("totals", "memberRows").jsonPrimitive.content.toInt(), served.sumOf { it.getValue("members").jsonArray.size })
        val teamKeys = strings("contract", "fields", "team")
        val memberKeys = strings("contract", "fields", "member")
        val sprintKeys = strings("contract", "fields", "sprint")
        val expectedTeams = figure("teams").jsonArray.map { it.jsonObject }
        assertEquals(expectedTeams.map { it.str("name") }, served.map { it.str("name") })
        for ((team, planned) in served.zip(expectedTeams)) {
            assertEquals(teamKeys, team.keys.toList(), planned.str("name"))
            team.getValue("members").jsonArray.forEach { assertEquals(memberKeys, it.jsonObject.keys.toList()) }
            team.getValue("sprints").jsonArray.forEach { assertEquals(sprintKeys, it.jsonObject.keys.toList()) }
            assertEquals(planned.int("sprints", "count"), team.getValue("sprints").jsonArray.size)
            assertEquals(planned.int("members", "rows"), team.getValue("members").jsonArray.size)
            assertEquals(planned.getValue("defaultCapacityMd"), team.getValue("defaultCapacityMd"))
        }
        // Every non-null capacitySource and state is in the contract's vocabulary.
        val sources = strings("contract", "capacitySources")
        val states = strings("contract", "sprintStates")
        for (sprint in served.flatMap { it.getValue("sprints").jsonArray }.map { it.jsonObject }) {
            sprint.getValue("capacitySource").let { assertTrue(it is JsonNull || it.jsonPrimitive.content in sources, it.toString()) }
            assertTrue(sprint.str("state") in states, sprint.str("state"))
        }
        // Names are unique (Flow's uq_teams_name_active) and the sprint ids are unique across the document.
        assertEquals(served.size, served.map { it.str("name") }.toSet().size)
        val ids = served.flatMap { it.getValue("sprints").jsonArray }.map { it.str("sprintId") }
        assertEquals(ids.size, ids.toSet().size)
    }

    @Test
    fun `sprintsSince takes any well-formed date or none, and a malformed value is the 400 problem`() {
        assertEquals(200, teams(FlowStubServer.sinceQuery("2024-01-31")).status)
        assertEquals(200, teams("").status, "the real server defaults it; so does the stub")
        for (bad in listOf("yesterday", "2025-13-45", "2025-1-5", "")) assertProblem(teams(FlowStubServer.sinceQuery(bad)), 400)
        // Authentication is decided first: a bad credential with a bad value is the 401, as on the real server.
        assertProblem(call(FlowStubServer.teamsPath, FlowStubServer.sinceQuery("yesterday"), authorization = null), 401)
    }

    @Test
    fun `the e2e team and the planted cases read as the generator documents them`() {
        val byName = items(teams())
        val e2e = byName.getValue(figure("e2e", "team").jsonPrimitive.content)
        val sprints = e2e.getValue("sprints").jsonArray.map { it.jsonObject }
        val preview = figure("e2e", "preview").jsonArray.map { it.jsonObject }
        assertEquals(6, sprints.size)
        for ((sprint, row) in sprints.zip(preview)) {
            assertEquals(row.getValue("sprintId"), sprint.getValue("sprintId"))
            assertEquals(row.str("name"), sprint.str("name"))
            assertEquals(row.getValue("startAt"), sprint.getValue("startAt"))
            assertEquals(row.getValue("endAt"), sprint.getValue("endAt"))
            assertEquals(row.getValue("flowMd"), sprint.getValue("capacityMd"))
            assertEquals("future", sprint.str("state"))
        }
        assertEquals(listOf("20.00", "18.00", "22.00", "20.00", "19.00", "21.00"), preview.map { it.str("mdPerWeek") })
        val roster = figure("e2e", "roster").jsonObject
        val members = e2e.objects("members")
        val current = members.filter { it.getValue("validTo") is JsonNull }.map { it.str("displayName") }
        assertEquals(roster.getValue("current").jsonArray.map { it.jsonPrimitive.content }, current)
        assertEquals(1, members.count { it.getValue("validTo") !is JsonNull })

        // SYNTHETIC: the dated sprints of the no-default team carry null capacity (Flow never derives that);
        // its undated sprint is the reachable null/null.
        val legacy = byName.getValue(planted("syntheticNoCapacity", "team"))
        assertEquals(JsonNull, legacy.getValue("managerName"))
        val (undatedLegacy, datedLegacy) = legacy.objects("sprints").partition { it.getValue("startAt") is JsonNull }
        assertEquals(listOf(planted("undatedNoDefault", "sprint")), undatedLegacy.map { it.str("name") })
        assertTrue((undatedLegacy + datedLegacy).all { it.getValue("capacityMd") is JsonNull && it.getValue("capacitySource") is JsonNull })
        assertEquals(figure("planted", "syntheticNoCapacity", "datedSprints").jsonPrimitive.content.toInt(), datedLegacy.size)
        // An undated sprint of a team WITH a default is derived from it.
        val analyticsTeam = byName.getValue(planted("undated", "team"))
        val analytics = analyticsTeam.objects("sprints").single { it.str("name") == planted("undated", "sprint") }
        assertTrue(listOf("startAt", "endAt", "completeAt").all { analytics.getValue(it) is JsonNull })
        assertEquals(listOf("TEAM_DEFAULT", "false"), listOf("capacitySource", "hasCalendar").map { analytics.str(it) })
        assertEquals(analyticsTeam.getValue("defaultCapacityMd"), analytics.getValue("capacityMd"))
        val mobile = byName.getValue(planted("defaultSource", "team")).objects("sprints").last()
        assertEquals(planted("defaultSource", "sprint"), mobile.str("name"))
        val mobileFacts = listOf("capacitySource", "hasCalendar", "capacityMd").map { mobile.str(it) }
        assertEquals(listOf("DEFAULT", "false", planted("defaultSource", "capacityMd")), mobileFacts)
        val frontend = byName.getValue(planted("unnamedMember", "team")).objects("members")
        val unnamed = frontend.count { it.getValue("displayName") is JsonNull }
        assertEquals(figure("planted", "unnamedMember", "count").jsonPrimitive.content.toInt(), unnamed)
        val empty = byName.getValue(planted("emptyTeam", "team"))
        assertEquals(listOf(0, 0), listOf("members", "sprints").map { empty.getValue(it).jsonArray.size })
        // The renamed team is spelled differently from the plan's, and the axe team exists.
        val renamedFrom = figure("suggestions", "renamedFrom").jsonPrimitive.content
        assertTrue(strings("suggestions", "none").all { it in byName } && renamedFrom !in byName)
    }

    @Test
    fun `the flow-day2 scenario drops Billing and changes the planted capacities, and resets`() {
        val day2 = figure("day2").jsonObject
        val gone = day2.getValue("gone").jsonArray.first().jsonPrimitive.content
        try {
            assertTrue(gone in items(teams()))
            FlowStubServer.setScenarioState(DAY2, figure("scenarios", "day2State").jsonPrimitive.content)
            val answer = teams()
            assertEquals(200, answer.status)
            val served = items(answer)
            assertEquals(day2.getValue("teams").jsonPrimitive.content.toInt(), served.size)
            assertEquals(day2.getValue("asOf"), answer.obj.getValue("asOf"))
            assertTrue(gone !in served)
            val sprintsById = served.values.flatMap { it.objects("sprints") }.associateBy { it.str("sprintId") }
            val changes = day2.getValue("capacityChanges").jsonArray.map { it.jsonObject }
            assertTrue(changes.isNotEmpty())
            for (change in changes) {
                assertEquals(change.getValue("to"), sprintsById.getValue(change.str("sprintId")).getValue("capacityMd"), change.str("name"))
            }
            // `me` is the same on both days.
            assertEquals(figure("me"), call(FlowStubServer.mePath).obj)
        } finally {
            FlowStubServer.resetScenarios()
        }
        assertTrue(gone in items(teams()))
    }

    @Test
    fun `the flow-outage scenario answers 500 to any well-formed bearer, 401 only to a malformed or missing one, and resets`() {
        try {
            FlowStubServer.setScenarioState(OUTAGE, figure("scenarios", "outageState").jsonPrimitive.content)
            // The lookup throws: a well-formed token, known or not, is a 500 (an outage is never read as a bad token); the shape check
            // fails before the lookup, so a malformed or missing header is still the uniform 401 (Flow plan sections 5 and 7).
            assertProblem(call(FlowStubServer.mePath), 500)
            assertProblem(teams(), 500)
            assertProblem(call(FlowStubServer.mePath, authorization = strangerToken), 500)
            assertProblem(teamsAs(strangerToken), 500)
            assertProblem(call(FlowStubServer.mePath, authorization = malformedToken), 401)
            assertProblem(call(FlowStubServer.mePath, authorization = null), 401)
            assertProblem(teamsAs(malformedToken), 401)
        } finally {
            FlowStubServer.resetScenarios()
        }
        assertEquals(200, call(FlowStubServer.mePath).status)
        assertEquals(200, teams().status)
    }

    @Test
    fun `the request journal keeps at most 50 entries and counts what a test asks about`() {
        FlowStubServer.resetRequests()
        assertEquals(200, call(FlowStubServer.mePath).status)
        assertEquals(1, FlowStubServer.countRequests(getRequestedFor(urlPathEqualTo(FlowStubServer.mePath))))
        assertEquals(0, FlowStubServer.countRequests(getRequestedFor(urlPathEqualTo(FlowStubServer.teamsPath))))
        repeat(JOURNAL_ENTRIES + 10) { assertEquals(200, call(FlowStubServer.mePath).status) }
        val kept = FlowStubServer.countRequests(getRequestedFor(urlPathEqualTo(FlowStubServer.mePath)))
        assertEquals(JOURNAL_ENTRIES, kept, "the cap, not the ${JOURNAL_ENTRIES + 11} calls")
    }

    @Test
    fun `the Flow stub image runs the same pinned WireMock as the Jira stub image and the test dependency`() {
        val catalog = Regex("""(?m)^wiremock\s*=\s*"([^"]+)"""").find(repoFile("gradle/libs.versions.toml").readText())?.groupValues?.get(1)
        val from = Regex("""(?m)^FROM wiremock/wiremock:(\S+)@sha256:[0-9a-f]{64}$""")
        val flow = from.find(repoFile("sample-data/flow-stub/Dockerfile").readText())
        val jira = from.find(repoFile("sample-data/jira-stub/Dockerfile").readText())
        assertNotNull(catalog, "no wiremock version in gradle/libs.versions.toml")
        assertNotNull(flow, "the Flow stub Dockerfile must pin wiremock/wiremock:<tag>@sha256:<digest>")
        assertNotNull(jira)
        assertEquals(catalog, flow.groupValues[1], "the test dependency and the Flow stub image must run the same WireMock")
        assertEquals(jira.value, flow.value, "both stub images pin the same tag AND digest")
        val mappings = File(repoFile("sample-data/flow-stub"), "mappings").list().orEmpty()
        assertTrue(mappings.isNotEmpty(), "the generated mappings are committed")
    }
}
