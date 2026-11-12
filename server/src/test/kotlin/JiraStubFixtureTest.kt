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
import kotlinx.serialization.json.JsonNull
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
        assertEquals(listOf("CE", "PF", "CG", "DI", "OE", "E2E", "OUT", "IMP", "COV", "IMF", "IMC"), projects)
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
    fun `the import's windowed browse lists what the typed read lists, page for page, for every import scope`() {
        // The stub does not evaluate the filter: the family answers with the typed read's own listing (1.13.2), whatever the clauses say.
        val types = "${typeId("program")},${typeId("initiative")},${typeId("epic")}"
        val window = " AND updated >= \"-525600m\""
        val done = " AND statusCategory != Done"
        for (key in listOf("IMF", "IMP", "CE")) {
            val typed = search("project in (\"$key\") AND issuetype in ($types) ORDER BY id ASC", fullFields)
            assertTrue(typed.first.isNotEmpty(), key)
            for (clauses in listOf(done + window, window)) {
                val windowed = search("project in (\"$key\") AND issuetype in ($types)$clauses ORDER BY id ASC", fullFields)
                assertEquals(typed.first.map { it.str("id") }, windowed.first.map { it.str("id") }, "$key$clauses: same issues, same order")
                assertEquals(typed.second, windowed.second, "$key$clauses: the same pages")
            }
            // The done-only form has no window: it is the typed read's own shape.
            val doneOnly = search("project in (\"$key\") AND issuetype in ($types)$done ORDER BY id ASC", fullFields)
            assertEquals(typed.first.map { it.str("id") }, doneOnly.first.map { it.str("id") }, key)
        }
        assertEquals(int("search", "imf/importwindow/eip/started", "issues"), 15)
        assertEquals(int("search", "ce/importwindow/eip/started", "pages"), int("search", "ce/fulltypes/eip/started", "pages"))

        // A windowed browse over another type set is an unmapped shape, never the incremental mapping's recent rows.
        val twoTypes = "${typeId("initiative")},${typeId("epic")}"
        val epicOnly = typeId("epic")
        val refused = listOf(
            "project in (\"IMF\") AND issuetype in ($twoTypes)$done$window ORDER BY id ASC",
            "project in ($SAMPLE) AND issuetype in ($epicOnly)$window ORDER BY id ASC",
        )
        for (jql in refused) {
            assertEquals(401, api("/search/jql", mapOf("jql" to jql, "fields" to fullFields)).status, jql)
        }
        // The incremental read still answers the recent set (nothing for IMF), and the sweep still answers ids.
        val recent = figure("incremental", "epics").jsonArray.map { it.jsonPrimitive.content }.toSet()
        val sampleRecent = search("project in ($SAMPLE) AND updated >= \"-15m\" ORDER BY updated ASC", fullFields).first
        assertEquals(recent, sampleRecent.map { it.str("key") }.toSet())
        assertEquals(0, search("project in (\"IMF\") AND updated >= \"-15m\" ORDER BY updated ASC", fullFields).first.size)
        assertEquals(15, search("project in (\"IMF\") AND issuetype in ($types) ORDER BY id ASC", "id").first.size)
    }

    @Test
    fun `IMF lists fifteen issues, every one answers by id and by key, and its hidden parent answers 404 while IMF-15 names it`() {
        val types = listOf("program", "initiative", "epic").joinToString(",") { typeId(it) }
        val listed = search("project in (\"IMF\") AND issuetype in ($types) ORDER BY id ASC", fullFields).first
        val expectedIssues = figure("imf", "issues").jsonArray
        assertEquals(expectedIssues.map { it.str("key") }, listed.map { it.str("key") })
        for ((entry, issue) in listed.zip(expectedIssues)) {
            val key = issue.str("key")
            val category = entry.str("fields", "status", "statusCategory", "key")
            assertEquals(issue.str("status") == "done", category == "done", "$key: the status category")
            assertEquals(issue.str("updated"), entry.str("fields", "updated"), "$key: the stamp")
            assertEquals(entry.str("id"), api("/issue/$key").obj.str("id"), "$key by key")
            assertEquals(key, api("/issue/${entry.str("id")}").obj.str("key"), "$key by id")
        }
        // The hidden parent: in no listing, no mapping answers it, so both forms are the stub's 404; IMF-15's document still names it.
        val hidden = figure("imf", "hidden").jsonArray.single()
        assertEquals("IMF-16", hidden.str("key"))
        assertEquals(404, api("/issue/${hidden.str("id")}").status)
        assertEquals(404, api("/issue/IMF-16").status)
        assertTrue(listed.none { it.str("key") == "IMF-16" })
        for (doc in listOf(listed.single { it.str("key") == "IMF-15" }, api("/issue/IMF-15").obj)) {
            assertEquals(hidden.str("key"), doc.str("fields", "parent", "key"))
            assertEquals(hidden.str("id"), doc.str("fields", "parent", "id"))
        }
        // The parent member carries what the import classifies a parent outside its set by: the issue type.
        assertEquals("Initiative", api("/issue/IMF-15").obj.str("fields", "parent", "fields", "issuetype", "name"))
    }

    /** The keys the stub lists for a children read: the IMC issues of `typeIds` whose parent is one of `parentKeys`, in id order. */
    private fun expectedChildren(parentKeys: List<String>, typeIds: List<String>): List<String> =
        figure("imc", "issues").jsonArray.filter { issue ->
            val parent = issue.jsonObject.getValue("parent")
            parent !is JsonNull && parent.jsonPrimitive.content in parentKeys &&
                typeId(if (issue.str("level") == "project") "initiative" else "epic") in typeIds
        }.map { it.str("key") }

    private fun childrenJql(typeIds: List<String>, parentIds: List<String>, clauses: String = "") =
        "project in (\"IMC\") AND issuetype in (${typeIds.joinToString(",")}) " +
            "AND parent in (${parentIds.joinToString(",")})$clauses ORDER BY id ASC"

    /** The status of a children query read with the observation `fields` (the typed read's shape), under the given Authorization. */
    private fun childrenStatus(jql: String, authorization: String? = GOOD): Int =
        api("/search/jql", mapOf("jql" to jql, "fields" to fullFields), authorization).status

    @Test
    fun `IMC lists fourteen issues and the four parent sets are replayed with and without the filter's clauses`() {
        val program = typeId("program")
        val initiative = typeId("initiative")
        val epic = typeId("epic")
        val listed = search("project in (\"IMC\") AND issuetype in ($program,$initiative,$epic) ORDER BY id ASC", fullFields).first
        val issues = figure("imc", "issues").jsonArray
        assertEquals(issues.map { it.str("key") }, listed.map { it.str("key") })
        assertEquals(14, int("search", "imc/full/any/started", "issues"))
        for ((entry, issue) in listed.zip(issues)) {
            val key = issue.str("key")
            val category = entry.str("fields", "status", "statusCategory", "key")
            assertEquals(issue.str("status") == "done", category == "done", "$key: the status category")
            assertEquals(issue.str("updated"), entry.str("fields", "updated"), "$key: the stamp")
            assertEquals(entry.str("id"), api("/issue/$key").obj.str("id"), "$key by key")
            assertEquals(key, api("/issue/${entry.str("id")}").obj.str("key"), "$key by id")
        }
        val idOf = issues.associate { it.str("key") to it.str("id") }
        val clauseVariants = listOf(
            "",
            " AND statusCategory != Done",
            " AND updated >= \"-525600m\"",
            " AND statusCategory != Done AND updated >= \"-525600m\"",
        )
        // The four sets of the children family (expected.json imc.childSets) over the type sets the rooted browse sends; the stub evaluates
        // no clause, so every variant lists the SAME issues, in id order, in the pages expected.json counts.
        for (set in figure("imc", "childSets").jsonArray) {
            val parentKeys = set.jsonObject.getValue("parents").jsonArray.map { it.jsonPrimitive.content }
            for ((typeSet, types) in mapOf("ei" to listOf(initiative, epic), "e" to listOf(epic))) {
                val want = expectedChildren(parentKeys, types)
                for (clauses in clauseVariants) {
                    val (found, pages) = search(childrenJql(types, parentKeys.map { idOf.getValue(it) }, clauses), fullFields)
                    assertEquals(want, found.map { it.str("key") }, "${set.str("name")}/$typeSet$clauses")
                    assertEquals(int("search", "imc/children-${set.str("name")}/$typeSet/started", "pages"), pages)
                    assertTrue(found.all { it.str("fields", "parent", "key") in parentKeys }, "only the named parents' children")
                }
                assertEquals(want.size, int("search", "imc/children-${set.str("name")}/$typeSet/started", "issues"))
            }
        }
        // The rooted walks end in the rows expected.json promises: the program root's two reads together hold every row of the unfiltered
        // outcome, and IMC-11..13 (under another program) appear in no children answer at all.
        val rootOnes = expectedChildren(listOf("IMC-1"), listOf(initiative, epic))
        val rootTwos = expectedChildren(listOf("IMC-2", "IMC-3", "IMC-4"), listOf(epic))
        val walked = (rootOnes + rootTwos).distinct()
        val rows = figure("imc", "byRoot", "IMC-1", "none", "rowKeys").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(rows.toSet(), walked.toSet())
        assertEquals(rows.size, walked.size, "no issue is read twice")
        val never = figure("imc", "neverListed").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("IMC-11", "IMC-12", "IMC-13"), never)
        assertTrue(never.none { it in walked })
        assertEquals(
            figure("imc", "byRoot", "IMC-2", "none", "rowKeys").jsonArray.map { it.jsonPrimitive.content },
            expectedChildren(listOf("IMC-2"), listOf(epic)),
        )
        // A root with nothing under it: one page, no issues (not a 401).
        assertEquals(0, search(childrenJql(listOf(initiative, epic), listOf(idOf.getValue("IMC-14"))), fullFields).first.size)
        // The root's by-id read carries the type the kernel classifies it by.
        assertEquals("Program", api("/issue/IMC-1").obj.str("fields", "issuetype", "name"))
    }

    @Test
    fun `the server's own children builder emits the texts the stub's family answers - every set, with and without the filter's clauses`() {
        val initiative = typeId("initiative")
        val epic = typeId("epic")
        val idOf = figure("imc", "issues").jsonArray.associate { it.str("key") to it.str("id") }
        for (set in figure("imc", "childSets").jsonArray) {
            val parentKeys = set.jsonObject.getValue("parents").jsonArray.map { it.jsonPrimitive.content }
            val parentIds = parentKeys.map { idOf.getValue(it) }
            // The rooted browse asks round one for the project and milestone types (top down), round two for the milestone type only.
            for (types in listOf(listOf(initiative, epic), listOf(epic))) {
                val variants = listOf(
                    Triple(false, null, ""),
                    Triple(true, null, " AND statusCategory != Done"),
                    Triple(false, 365, " AND updated >= \"-525600m\""),
                    Triple(true, 365, " AND statusCategory != Done AND updated >= \"-525600m\""),
                )
                for ((excludeDone, days, clauses) in variants) {
                    val built = ch.nokillswit.jira.JiraJql.children(listOf("IMC"), types, parentIds, excludeDone, days)
                    assertEquals(childrenJql(types, parentIds, clauses), built, "${set.str("name")} $types$clauses")
                    val (found, _) = search(built, fullFields)
                    assertEquals(expectedChildren(parentKeys, types), found.map { it.str("key") }, "${set.str("name")} $types$clauses")
                }
            }
        }
        // A set the builder could name but the stub does not know is its 401 (a rooted read of an unprepared root reads as a 502).
        val unknown = ch.nokillswit.jira.JiraJql.children(listOf("IMC"), listOf(initiative, epic), listOf(idOf.getValue("IMC-11")))
        assertEquals(401, api("/search/jql", mapOf("jql" to unknown, "fields" to fullFields)).status)
    }

    @Test
    fun `an unknown parent set is a 401, a children query needs the scheme and fields, and the rejected token is refused`() {
        val initiative = typeId("initiative")
        val epic = typeId("epic")
        val known = childrenJql(listOf(initiative, epic), listOf("99001"))
        assertEquals(200, childrenStatus(known))
        // Another set - an unlisted id, a subset, a superset - is the unmapped-shape 401, never the typed read's listing.
        for (parents in listOf("99011", "99002,99003", "99001,99002", "99002,99003,99004,99014", "99005")) {
            val jql = childrenJql(listOf(initiative, epic), parents.split(","))
            val answer = api("/search/jql", mapOf("jql" to jql, "fields" to fullFields))
            assertEquals(401, answer.status, parents)
            assertTrue("issues" !in answer.body, "$parents: no listing leaks through")
        }
        // The filter's clauses do not change which sets are known, nor does the type set's order.
        assertEquals(401, childrenStatus(childrenJql(listOf(epic), listOf("99011"), " AND statusCategory != Done")))
        assertEquals(200, childrenStatus(childrenJql(listOf(epic, initiative), listOf("99001"))), "type order is free")
        // The scheme is demanded, and `fields` must carry summary and issuetype (a request without them fails a client that forgot them).
        assertEquals(401, childrenStatus(known, authorization = null))
        assertEquals(401, childrenStatus(known, authorization = "Token abc"))
        assertEquals(401, api("/search/jql", mapOf("jql" to known)).status)
        // The rejected token meets only auth-wrong-token-401 on a children query (the family's header `and` steps aside), in each
        // form; right after it the good token still reads the same set.
        val rejected = expected.str("rejectedToken")
        val north = childrenJql(listOf(epic), listOf("99002"))
        for (authorization in listOf("Bearer $rejected", basic("e2e-jira@astrolabe.local", rejected), basic("a@b.c", rejected))) {
            assertEquals(401, childrenStatus(known, authorization), authorization.take(12))
            assertEquals(401, childrenStatus(north, authorization), authorization.take(12))
            assertEquals(401, api("/issue/IMC-1", authorization = authorization).status)
        }
        assertEquals(200, childrenStatus(known))
    }

    @Test
    fun `a full read pages every issue in scope, in any key order, and needs fields`() {
        val (issues, pages) = search("project in ($SAMPLE) ORDER BY id ASC", fullFields)
        assertEquals(int("search", "sample/full/any/started", "issues"), issues.size)
        assertEquals(int("search", "sample/full/any/started", "pages"), pages)
        // The untyped full read lists the plan's issues AND the stories under every fifth epic (1.4: totals.stories).
        assertEquals(int("totals", "issues") + int("totals", "stories"), issues.size, "totals.issues (the plan levels) + totals.stories")
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
    fun `the child level answers the typed read and the sweep per scope, and COV's roll-up figures equal expected json`() {
        val childTypes = listOf("story", "task", "bug").joinToString(",") { typeId(it) }
        // The sweep: ids only, the stories of the sample scope and nothing else.
        val (ids, sweepPages) = search("project in ($SAMPLE) AND issuetype in ($childTypes) ORDER BY id ASC", "id")
        assertEquals(int("search", "sample/sweep/s/started", "issues"), ids.size)
        assertEquals(int("totals", "stories"), ids.size)
        assertEquals(int("search", "sample/sweep/s/started", "pages"), sweepPages)
        assertTrue(ids.all { it.keys == setOf("id") }, "ids only")

        // The typed full read of the sample scope: full documents, every one hanging under an epic.
        val (stories, storyPages) = search("project in ($SAMPLE) AND issuetype in ($childTypes) ORDER BY id ASC", fullFields)
        assertEquals(int("search", "sample/fulltypes/s/started", "issues"), stories.size)
        assertEquals(int("search", "sample/fulltypes/s/started", "pages"), storyPages)
        assertTrue(
            stories.all { it.str("fields", "parent", "fields", "issuetype", "id") == typeId("epic") },
            "every story hangs under an epic",
        )
        assertEquals(ids.map { it.str("id") }, stories.map { it.str("id") }, "the sweep and the full read list the same stories, in order")

        // COV: the typed read of the child level, folded by parent, equals the roll-ups expected json promises.
        val (children, covPages) = search("project in (\"COV\") AND issuetype in ($childTypes) ORDER BY id ASC", fullFields)
        assertEquals(int("search", "cov/fulltypes/s/started", "issues"), children.size)
        assertEquals(int("search", "cov/fulltypes/s/started", "pages"), covPages)
        val rollups = figure("cov", "rollups").jsonObject
        val parents = children.map { it.str("fields", "parent", "key") }.toSet()
        assertEquals(rollups.keys, parents, "COV children hang under the rolled-up epics")
        for ((epic, rollup) in rollups) {
            val mine = children.filter { it.str("fields", "parent", "key") == epic }
            assertEquals(rollup.str("children").toInt(), mine.size, "$epic children")
            val done = mine.count { it.str("fields", "status", "statusCategory", "key") == "done" }
            assertEquals(rollup.str("done").toInt(), done, "$epic done")
            val points = mine.sumOf { it.str("fields", "customfield_10026").toDouble() }
            assertEquals(rollup.str("points").toDouble(), points, "$epic points")
        }

        // COV's documents by key: type, parent and points as expected json lists them (a Task and a Bug among the stories).
        for (issue in figure("cov", "issues").jsonArray) {
            val doc = api("/issue/${issue.str("key")}").obj
            assertEquals(issue.str("type"), doc.str("fields", "issuetype", "name"), issue.str("key"))
            val parent = issue.jsonObject.getValue("parent")
            if (parent is JsonNull) {
                assertTrue("parent" !in doc.getValue("fields").jsonObject, issue.str("key"))
            } else {
                assertEquals(parent.jsonPrimitive.content, doc.str("fields", "parent", "key"), issue.str("key"))
            }
            val points = issue.jsonObject.getValue("points")
            if (points !is JsonNull) {
                assertEquals(points.jsonPrimitive.content.toDouble(), doc.str("fields", "customfield_10026").toDouble(), issue.str("key"))
            }
        }
        assertEquals(setOf("COV-5"), figure("cov", "unlinkedOpen").jsonArray.map { it.jsonPrimitive.content }.toSet())
        assertEquals(setOf("COV-10"), figure("cov", "unlinkedDone").jsonArray.map { it.jsonPrimitive.content }.toSet())
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
