package ch.nokillswit

import java.io.File
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Pins the contract of the Jira stub (`sample-data/jira/README.md`) over plain HTTP against the generator's own `expected.json`, so the
 * dataset, the mappings and the figures a later step compares with cannot drift apart; also the `wiremock` pin shared by the test
 * dependency and the stub image. Everything is read through [JiraStubServer], warmed in a `@BeforeClass` like every reader of it.
 */
class JiraStubFixtureTest {
    private companion object {
        const val GOOD = "Bearer good-token"
        const val SAMPLE = """"CE","PF","CG","DI","OE""""
        const val DAY2 = "jira-day2"
        const val MAX_PAGES = 50

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }

        private fun repoFile(path: String): File =
            File(System.getProperty("repo.root") ?: "..", path).also { assertTrue(it.exists(), "$path not found (${it.absolutePath})") }

        val expected: JsonObject by lazy { Json.parseToJsonElement(repoFile("sample-data/jira/expected.json").readText()).jsonObject }
        val http: HttpClient = HttpClient.newHttpClient()
    }

    private class Answer(val status: Int, val body: String) {
        val json: JsonElement get() = Json.parseToJsonElement(body)
        val obj: JsonObject get() = json.jsonObject
    }

    private fun call(path: String, query: Map<String, String> = emptyMap(), authorization: String? = GOOD): Answer {
        val queryString = query.entries.joinToString("&", prefix = if (query.isEmpty()) "" else "?") { (key, value) ->
            "$key=${URLEncoder.encode(value, Charsets.UTF_8)}"
        }
        val uri = URI.create("${JiraStubServer.baseUrl}$path$queryString")
        val request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(30)).GET().apply {
            authorization?.let { header("Authorization", it) }
        }.build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofString())
        return Answer(response.statusCode(), response.body())
    }

    private fun api(path: String, query: Map<String, String> = emptyMap(), authorization: String? = GOOD) =
        call("/ex/jira/${JiraStubServer.CLOUD_ID}/rest/api/3$path", query, authorization)

    private fun figure(vararg path: String): JsonElement = path.fold(expected as JsonElement) { node, key -> node.jsonObject.getValue(key) }

    private fun int(vararg path: String): Int = figure(*path).jsonPrimitive.content.toInt()

    /** The string at `keys` below this node (objects only). */
    private fun JsonElement.str(vararg keys: String): String =
        keys.fold(this) { node, key -> node.jsonObject.getValue(key) }.jsonPrimitive.content

    private fun basic(email: String, token: String) = "Basic " + Base64.getEncoder().encodeToString("$email:$token".toByteArray())

    private fun typeId(name: String) = figure("issueTypes", name).str("id")

    /** Follows `nextPageToken` to the end; returns (issues, pages). */
    private fun search(jql: String, fields: String): Pair<List<JsonObject>, Int> {
        val issues = mutableListOf<JsonObject>()
        var pages = 0
        var token: String? = null
        do {
            val query = buildMap {
                put("jql", jql)
                put("fields", fields)
                token?.let { put("nextPageToken", it) }
            }
            val answer = api("/search/jql", query)
            assertEquals(200, answer.status, "search page ${pages + 1} of $jql: ${answer.body.take(200)}")
            pages++
            assertTrue(pages <= MAX_PAGES, "the page chain of $jql does not end")
            issues += answer.obj.getValue("issues").jsonArray.map { it.jsonObject }
            token = answer.obj["nextPageToken"]?.jsonPrimitive?.content
            assertEquals(token == null, answer.obj.getValue("isLast").jsonPrimitive.content.toBoolean(), "isLast tells the last page")
        } while (token != null)
        return issues to pages
    }

    private val fullFields =
        "id,key,summary,status,issuetype,parent,updated,customfield_10022,customfield_10023,customfield_10026,customfield_10001"

    @Test
    fun `tenant_info is public, the rest needs a scheme and the rejected token is refused in both forms`() {
        val tenant = call("/_edge/tenant_info", authorization = null)
        assertEquals(200, tenant.status)
        assertEquals(JiraStubServer.CLOUD_ID, tenant.json.str("cloudId"))
        assertEquals(expected.str("cloudId"), JiraStubServer.CLOUD_ID)

        assertEquals(200, api("/myself").status)
        assertEquals(200, api("/myself", authorization = basic("who@example.test", "good-token")).status)
        assertEquals(401, api("/myself", authorization = null).status, "no Authorization header: the catch-all")
        assertEquals(401, api("/myself", authorization = "Token abc").status, "a scheme the stub does not know")
        val rejected = expected.str("rejectedToken")
        assertEquals(401, api("/myself", authorization = "Bearer $rejected").status)
        for (email in listOf("a@b.c", "ab@b.c", "e2e-jira@astrolabe.local", "someone.long@example.test")) {
            assertEquals(401, api("/field", authorization = basic(email, rejected)).status, "Basic $email")
        }
    }

    @Test
    fun `the reference endpoints describe the site the sync discovers`() {
        val fields = api("/field").json.jsonArray
        assertTrue(fields.size in 55..65, "about 60 fields, got ${fields.size}")
        fun custom(name: String) = assertNotNull(fields.firstOrNull { it.str("name") == name }, name).str("schema", "custom")
        assertTrue("jpo-custom-field-baseline-start" in custom("Target start"))
        assertTrue("jpo-custom-field-baseline-end" in custom("Target end"))
        assertTrue("atlassian-team" in custom("Team"))
        assertTrue("jpo-custom-field-parent" in custom("Parent Link"))
        val order = fields.map { it.str("name") }
        assertTrue(order.indexOf("Story Points") < order.indexOf("Story point estimate"), "the default picks the FIRST story-point field")

        val types = api("/issuetype").json.jsonArray.associate { it.str("name") to it.str("hierarchyLevel").toInt() }
        assertEquals(mapOf("Sub-task" to -1, "Story" to 0, "Task" to 0, "Bug" to 0, "Epic" to 1, "Initiative" to 2, "Program" to 3), types)

        val projects = api("/project/search").obj.getValue("values").jsonArray.map { it.str("key") }
        assertEquals(listOf("CE", "PF", "CG", "DI", "OE", "E2E", "OUT", "IMP"), projects)
    }

    @Test
    fun `a typed full read - the run's first read - answers each issue-type set with the observation fields`() {
        val epic = typeId("epic")
        val initiative = typeId("initiative")
        val program = typeId("program")
        for ((set, ids) in mapOf("e" to listOf(epic), "ei" to listOf(epic, initiative), "eip" to listOf(epic, initiative, program))) {
            val (issues, pages) = search("project in ($SAMPLE) AND issuetype in (${ids.joinToString(",")}) ORDER BY id ASC", fullFields)
            assertEquals(int("search", "sample/fulltypes/$set/started", "issues"), issues.size, set)
            assertEquals(int("search", "sample/fulltypes/$set/started", "pages"), pages, set)
            assertTrue(issues.all { it.str("fields", "issuetype", "id") in ids }, "$set: only the asked types")
            assertTrue(issues.all { "customfield_10022" in it.getValue("fields").jsonObject }, "$set: full documents, not ids")
        }
        assertEquals(1000, int("search", "sample/fulltypes/e/started", "issues"))
    }

    @Test
    fun `the import's scopes answer the typed read - IMP through the default type set, CE as a single key - with every page`() {
        val types = "${typeId("epic")},${typeId("initiative")},${typeId("program")}"
        for ((key, group) in mapOf("IMP" to "imp/fulltypes/eip/started", "CE" to "ce/fulltypes/eip/started")) {
            val (issues, pages) = search("project in (\"$key\") AND issuetype in ($types) ORDER BY id ASC", fullFields)
            assertEquals(int("search", group, "issues"), issues.size, key)
            assertEquals(int("search", group, "pages"), pages, key)
            assertTrue(issues.all { it.str("key").startsWith("$key-") }, "$key: only its own project")
        }
    }

    @Test
    fun `a full read pages every issue in scope, in any key order, and needs fields`() {
        val (issues, pages) = search("project in ($SAMPLE) ORDER BY id ASC", fullFields)
        assertEquals(int("search", "sample/full/any/started", "issues"), issues.size)
        assertEquals(int("search", "sample/full/any/started", "pages"), pages)
        assertEquals(int("totals", "issues"), issues.size)
        assertEquals(issues.size, issues.map { it.str("id") }.toSet().size)
        val fields = issues.first { it.str("fields", "issuetype", "name") == "Epic" }.getValue("fields")
        assertTrue(fields.str("customfield_10022").startsWith("20"), "Target start is an ISO date")
        assertTrue("parent" in fields.jsonObject)

        val reordered = search("project in (\"OE\", \"DI\", CG, PF, CE) ORDER BY id ASC", fullFields)
        assertEquals(issues.size, reordered.first.size)
        // `fields=id` (or none) on the full shape matches nothing, as the real site fails a client that forgot `fields`.
        val jql = "project in ($SAMPLE) ORDER BY id ASC"
        assertEquals(401, api("/search/jql", mapOf("jql" to jql, "fields" to "id", "maxResults" to "50")).status)
        assertEquals(401, api("/search/jql", mapOf("jql" to jql)).status)
        val singleKey = mapOf("jql" to "project in (\"CE\")", "fields" to fullFields)
        assertEquals(401, api("/search/jql", singleKey).status, "a single key is listed for the typed read only, not the unfiltered one")
    }

    @Test
    fun `the sweep answers ids only per issue-type set, the probe one epic and the incremental the recent ones`() {
        val epic = typeId("epic")
        val initiative = typeId("initiative")
        val (ids, pages) = search("project in ($SAMPLE) AND issuetype in ($epic, $initiative) ORDER BY id ASC", "id")
        assertEquals(int("search", "sample/sweep/ei/started", "issues"), ids.size)
        assertEquals(int("search", "sample/sweep/ei/started", "pages"), pages)
        assertTrue(ids.all { it.keys == setOf("id") }, "ids only")
        assertEquals(1000, search("project in ($SAMPLE) AND issuetype in ($epic) ORDER BY id ASC", "id").first.size)

        val probeQuery = mapOf("jql" to "project in ($SAMPLE) AND issuetype in ($epic)", "fields" to "id", "maxResults" to "1")
        val probe = api("/search/jql", probeQuery)
        assertEquals(1, probe.obj.getValue("issues").jsonArray.size)

        val incremental = search("project in ($SAMPLE) AND updated >= \"-15m\" ORDER BY updated ASC", fullFields)
        val recent = figure("incremental", "epics").jsonArray.map { it.jsonPrimitive.content }.toSet()
        assertEquals(recent, incremental.first.map { it.str("key") }.toSet())
    }

    @Test
    fun `an issue answers by id and by key alike, an unknown key is a 404 and the E2E epic carries its 2044 dates`() {
        val key = figure("keys", "milestones").jsonArray.first().jsonPrimitive.content
        val byKey = api("/issue/$key", mapOf("fields" to "id")).obj
        assertEquals(byKey, api("/issue/${byKey.str("id")}").obj)
        assertEquals(404, api("/issue/NOPE-1").status)
        assertEquals(401, api("/issue/$key", authorization = null).status)

        val linked = figure("e2e", "linkedEpic")
        val fields = api("/issue/${linked.str("key")}").obj.getValue("fields")
        assertEquals(linked.str("jira", "start"), fields.str("customfield_10022"))
        assertEquals(linked.str("jira", "end"), fields.str("customfield_10023"))
        assertTrue(fields.str("customfield_10022").startsWith("2044-"))
    }

    @Test
    fun `day 2 deletes and moves the planted issues and a reset brings them back`() {
        val deletedKey = figure("day2", "deleted", "keys").jsonArray.first().jsonPrimitive.content
        val moved = figure("day2", "movedOut").jsonArray.first()
        val e2eDeleted = figure("e2e", "deletedOnDay2").jsonArray.first().jsonPrimitive.content
        assertEquals(200, api("/issue/$deletedKey").status)
        assertEquals(404, api("/issue/${moved.str("movedKey")}").status, "before day 2 the new key does not exist")
        try {
            JiraStubServer.setScenarioState(DAY2, "day2")
            assertEquals(404, api("/issue/$deletedKey").status)
            assertEquals(404, api("/issue/$e2eDeleted").status)
            assertEquals(404, api("/issue/${moved.str("key")}").status, "the old key of a moved issue")
            val atNewKey = api("/issue/${moved.str("id")}").obj
            assertEquals(moved.str("movedKey"), atNewKey.str("key"))
            assertEquals("OUT", atNewKey.str("fields", "project", "key"))
            assertEquals(moved.str("id"), api("/issue/${moved.str("movedKey")}").obj.str("id"))

            val epics = search("project in ($SAMPLE) AND issuetype in (${typeId("epic")}) ORDER BY id ASC", "id").first
            assertEquals(int("search", "sample/sweep/e/day2", "issues"), epics.size)
            assertEquals(1000 - int("day2", "inScopeDelta"), epics.size)
            val full = search("project in ($SAMPLE) ORDER BY id ASC", fullFields).first
            assertEquals(int("search", "sample/full/any/day2", "issues"), full.size)
        } finally {
            JiraStubServer.resetScenarios()
        }
        assertEquals(200, api("/issue/$deletedKey").status, "a reset restores the Started state")
    }

    @Test
    fun `the generated directory matches expected json and the wiremock pin is one version in the catalog and the stub image`() {
        val root = repoFile("sample-data/jira-stub")
        assertEquals(int("stub", "mappings"), File(root, "mappings").list().orEmpty().size)
        assertEquals(int("stub", "bodies"), File(root, "__files").list().orEmpty().size)

        val catalog = Regex("""(?m)^wiremock\s*=\s*"([^"]+)"""").find(repoFile("gradle/libs.versions.toml").readText())?.groupValues?.get(1)
        val dockerfile = repoFile("sample-data/jira-stub/Dockerfile").readText()
        val image = Regex("""(?m)^FROM wiremock/wiremock:(\S+)@sha256:[0-9a-f]{64}$""").find(dockerfile)
        assertNotNull(catalog, "no wiremock version in gradle/libs.versions.toml")
        assertNotNull(image, "the stub Dockerfile must pin wiremock/wiremock:<tag>@sha256:<digest>")
        assertEquals(catalog, image.groupValues[1], "the test dependency and the stub image must run the same WireMock")
    }
}
