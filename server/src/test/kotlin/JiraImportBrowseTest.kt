package ch.nokillswit

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.jira.ImportBrowse
import ch.nokillswit.jira.ImportBrowseFilter
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraAuthScheme
import ch.nokillswit.jira.JiraBindContext
import ch.nokillswit.jira.JiraLevelFields
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraMappingState
import ch.nokillswit.jira.JiraTestTarget
import ch.nokillswit.jira.StoredMapping
import ch.nokillswit.jira.browseScope
import io.ktor.http.HttpHeaders
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.time.LocalDate
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * `browseScope` over a scripted site (a Ktor `MockEngine` under the real `HttpJiraClient` and transport): the paging stops at the cap, the
 * per-page stop runs before every page, the request names the mapped fields and the typed full-read JQL, each issue is read at its own plan
 * level, and its direct parent's issue type is kept. No database, no application.
 */
class JiraImportBrowseTest {
    private val token = "UNIT-TOKEN-do-not-leak"
    private val target = JiraTestTarget("https://unit.atlassian.net", "a@example.test", token, JiraAuthScheme.BASIC, listOf("IMP"))
    private val context = JiraBindContext(target, JiraMappingState(StoredMapping.Unset, IMPORT_DISCOVERY), true)

    private fun epic(id: Int, fields: String = "") = issueDoc("$id", "IMP-$id", fields = fields)

    private fun browse(
        site: ScriptedSite,
        mapping: JiraMapping = importMapping(),
        cap: Int = 2_000,
        beforePage: suspend () -> Unit = {},
        deadlineMillis: Long = 60_000,
        filter: ImportBrowseFilter? = null,
        now: Long = 1L,
    ): ImportBrowse = runBlocking {
        browseScope(site.connector, context, token, listOf("IMP"), mapping, IMPORT_DISCOVERY, now, beforePage, cap, deadlineMillis, filter)
    }

    // ---- the import filter (1.13.2): the query, the in-memory rule and the parents read by id -----------------------------------------

    private val today = java.time.Instant.parse("2026-11-11T00:00:00Z").toEpochMilli()
    private val recent = "2026-11-01T10:00:00.000+0000"
    private val quiet = "2025-01-01T10:00:00.000+0000"

    /** An issue entry at Jira level [level] (1 epic, 2 initiative, 3 program) under [parent] (one level up), with a status and a stamp. */
    private fun doc(
        id: Int,
        level: Int,
        parent: Int? = null,
        done: Boolean = false,
        updated: String = recent,
        key: String = "IMP-$id",
        docId: String = "$id",
    ): String {
        fun type(at: Int) = """{"id":"${10003 + at}","name":"L$at","subtask":false,"hierarchyLevel":$at}"""
        val category = if (done) "done" else "indeterminate"
        val parentMember = parent?.let { ""","parent":{"id":"$it","key":"IMP-$it","fields":{"issuetype":${type(level + 1)}}}""" }.orEmpty()
        return """{"id":"$docId","key":"$key","fields":{"summary":"Issue $key","issuetype":${type(level)},""" +
            """"status":{"name":"S","statusCategory":{"key":"$category"}},"updated":"$updated"$parentMember}}"""
    }

    private fun answer(body: String, status: Int = 200) = ScriptedIssue(status, body)

    /** A filter that leaves done items out and keeps what [live] holds (what the plan side says is linked), recording every ask. */
    private class Filter(
        val filter: JiraImportFilter = JiraImportFilter(excludeDone = true, updatedWithinDays = 365),
        val live: Set<String> = emptySet(),
    ) {
        val asked = mutableListOf<Set<String>>()
        val holder = ImportBrowseFilter(filter) { ids ->
            asked += ids.toSet()
            ids.filterTo(HashSet()) { it in live }
        }
    }

    private fun ids(browse: ImportBrowse) = browse.issues.map { it.observation.issueId }

    @Test
    fun `an active filter narrows the query - done only, window only, both - and an absent or inactive one sends the plain full read`() {
        val types = "10006,10005,10004"
        val expected = mapOf(
            JiraImportFilter(excludeDone = true, updatedWithinDays = 365) to
                """project in ("IMP") AND issuetype in ($types) AND statusCategory != Done AND updated >= "-525600m" ORDER BY id ASC""",
            JiraImportFilter(excludeDone = true) to
                """project in ("IMP") AND issuetype in ($types) AND statusCategory != Done ORDER BY id ASC""",
            JiraImportFilter(updatedWithinDays = 30) to
                """project in ("IMP") AND issuetype in ($types) AND updated >= "-43200m" ORDER BY id ASC""",
            JiraImportFilter() to """project in ("IMP") AND issuetype in ($types) ORDER BY id ASC""",
        )
        for ((filter, jql) in expected) {
            val site = ScriptedSite(searchPage(doc(1, 1)))
            browse(site, filter = Filter(filter).holder, now = today)
            assertEquals(jql, site.searches.single().url.parameters["jql"], filter.toString())
        }
        val plain = ScriptedSite(searchPage(doc(1, 1, parent = 20)))
        browse(plain, filter = null)
        assertEquals("""project in ("IMP") AND issuetype in ($types) ORDER BY id ASC""", plain.searches.single().url.parameters["jql"])
    }

    @Test
    fun `without an active filter no parent is ever read by id, even when a parent is missing`() {
        for (filter in listOf(null, Filter(JiraImportFilter()).holder)) {
            val site = ScriptedSite(searchPage(doc(1, 1, parent = 20)))
            val result = browse(site, filter = filter, now = today)
            assertEquals(listOf("1"), ids(result))
            assertTrue(site.issueRequests.isEmpty(), "no by-id request: ${site.issueReads}")
        }
    }

    @Test
    fun `an entry the rule does not admit is dropped at once and never counts toward the cap`() {
        // The site ignored the clauses (as the stub does): the server's own rule filters. cap 2, four entries, two admitted.
        val site = ScriptedSite(searchPage(doc(1, 1, done = true), doc(2, 1), doc(3, 1, updated = quiet), doc(4, 1)))
        val result = browse(site, cap = 2, filter = Filter().holder, now = today)
        assertEquals(listOf("2", "4"), ids(result))
        assertFalse(result.truncated, "what was dropped never counted")
    }

    @Test
    fun `a missing parent is read by id with the search's fields, kept as a parent, and its own missing parent in a second round only`() {
        val filter = Filter()
        val site = ScriptedSite(
            searchPage(doc(1, 1, parent = 20)),
            issues = mapOf(
                "20" to answer(doc(20, 2, parent = 30, done = true)),
                "30" to answer(doc(30, 3, parent = 40, updated = quiet)),
                "40" to answer(doc(40, 3)),
            ),
        )
        val result = browse(site, filter = filter.holder, now = today)
        assertEquals(listOf("20", "30"), site.issueReads, "one read per missing parent, a program is the top: its parent is never read")
        assertEquals(listOf("1", "20", "30"), ids(result))
        assertEquals(listOf(false, true, true), result.issues.map { it.keptAsParent })
        assertFalse(result.truncated)
        val fields = site.searches.single().url.parameters["fields"]
        assertTrue(!fields.isNullOrBlank())
        assertTrue(site.issueRequests.all { it.url.parameters["fields"] == fields }, "the by-id reads carry the search's fields")
        assertEquals(2, filter.asked.size, "one short read of the bindings per round, never a third")
    }

    @Test
    fun `a parent two items name is read once, and ascending`() {
        val site = ScriptedSite(
            searchPage(doc(1, 1, parent = 100), doc(2, 1, parent = 9), doc(3, 1, parent = 100)),
            issues = mapOf("100" to answer(doc(100, 2, done = true)), "9" to answer(doc(9, 2, done = true))),
        )
        browse(site, filter = Filter().holder, now = today)
        assertEquals(listOf("9", "100"), site.issueReads)
    }

    @Test
    fun `a linked child or a linked parent costs no read, and an unlinked pair does`() {
        val filter = Filter(live = setOf("1", "21"))
        val site = ScriptedSite(
            searchPage(doc(1, 1, parent = 20), doc(2, 1, parent = 21), doc(3, 1, parent = 22)),
            issues = mapOf("22" to answer(doc(22, 2, done = true))),
        )
        browse(site, filter = filter.holder, now = today)
        assertEquals(listOf("22"), site.issueReads)
        assertTrue(filter.asked.first().containsAll(setOf("1", "20", "21", "22")), "the round asks about children and parents alike")
    }

    @Test
    fun `a 404 and a 403 flag the child, are read once however many children name them, and are never retried`() {
        val site = ScriptedSite(
            searchPage(doc(1, 1, parent = 20), doc(2, 1, parent = 21), doc(3, 1, parent = 20), doc(4, 1)),
            issues = mapOf("21" to answer("""{"errorMessages":["no"]}""", 403)),
        )
        val result = browse(site, filter = Filter().holder, now = today)
        assertEquals(listOf("20", "21"), site.issueReads)
        assertEquals(listOf("1", "2", "3", "4"), ids(result), "nothing was added")
        assertEquals(listOf(true, true, true, false), result.issues.map { it.parentUnreadable })
        assertFalse(result.truncated)
    }

    @Test
    fun `a parent failure that says nothing about the issue is the FetchException, not a flag`() {
        val site = ScriptedSite(
            searchPage(doc(1, 1, parent = 20)),
            issues = mapOf("20" to answer("""{"message":"boom"}""", 500)),
        )
        val failure = assertFailsWith<FetchException> { browse(site, filter = Filter().holder, now = today) }
        assertTrue(failure.code != "NOT_FOUND" && failure.code != "FORBIDDEN_SCOPE", failure.code)
    }

    @Test
    fun `a 200 of another id is unreadable, one outside the keys or at another level is dropped and flags nothing`() {
        val site = ScriptedSite(
            searchPage(doc(1, 1, parent = 20), doc(2, 1, parent = 21), doc(3, 1, parent = 22), doc(4, 1, parent = 23)),
            issues = mapOf(
                "20" to answer(doc(20, 2, docId = "999")),
                "21" to answer(doc(21, 2, key = "OTHER-21")),
                "22" to answer(doc(22, 1)),
                "23" to answer(doc(23, 2, done = true)),
            ),
        )
        val result = browse(site, filter = Filter().holder, now = today)
        assertEquals(listOf("20", "21", "22", "23"), site.issueReads)
        assertEquals(listOf("1", "2", "3", "4", "23"), ids(result), "only the good parent joined")
        val flagged = result.issues.filter { it.parentUnreadable }.map { it.observation.issueId }
        assertEquals(listOf("1"), flagged, "another id is unreadable; the other two are orphans as today")
    }

    @Test
    fun `the 201st parent truncates the browse, 200 do not`() {
        fun site(count: Int) = ScriptedSite(searchPage(*(1..count).map { doc(it, 1, parent = 1000 + it) }.toTypedArray()))
        val exact = site(200)
        assertFalse(browse(exact, filter = Filter().holder, now = today).truncated)
        assertEquals(200, exact.issueReads.size)
        val over = site(201)
        assertTrue(browse(over, filter = Filter().holder, now = today).truncated)
        assertEquals(200, over.issueReads.size, "the 201st is never sent")
    }

    @Test
    fun `the rows with the fetched parents count against the cap`() {
        val issues = mapOf("20" to answer(doc(20, 2, done = true)), "21" to answer(doc(21, 2, done = true)))
        val over = ScriptedSite(searchPage(doc(1, 1, parent = 20), doc(2, 1, parent = 21)), issues = issues)
        val result = browse(over, cap = 3, filter = Filter().holder, now = today)
        assertTrue(result.truncated)
        assertEquals(listOf("20"), over.issueReads, "the second parent would be the 4th row")
        val fits = ScriptedSite(searchPage(doc(1, 1, parent = 20), doc(2, 1, parent = 21)), issues = issues)
        assertFalse(browse(fits, cap = 4, filter = Filter().holder, now = today).truncated)
    }

    @Test
    fun `a search that itself passed the cap reads no parent`() {
        val site = ScriptedSite(searchPage(doc(1, 1, parent = 20), doc(2, 1, parent = 21)))
        val result = browse(site, cap = 1, filter = Filter().holder, now = today)
        assertTrue(result.truncated)
        assertTrue(site.issueRequests.isEmpty())
    }

    @Test
    fun `the connection's stop runs before every by-id read`() {
        val site = ScriptedSite(
            searchPage(doc(1, 1, parent = 20), doc(2, 1, parent = 21)),
            issues = mapOf("20" to answer(doc(20, 2, done = true)), "21" to answer(doc(21, 2, done = true))),
        )
        val asked = AtomicInteger()
        val stopped = assertFailsWith<IllegalStateException> {
            // call 1 is the search page, call 2 the first by-id read, call 3 the second
            val stop: suspend () -> Unit = { if (asked.incrementAndGet() == 3) error("the connection went away") }
            browse(site, beforePage = stop, filter = Filter().holder, now = today)
        }
        assertEquals("the connection went away", stopped.message)
        assertEquals(listOf("20"), site.issueReads, "the second read was never sent")
    }

    @Test
    fun `a slow parent read is the browse's TIMEOUT`() {
        val site = ScriptedSite(
            searchPage(doc(1, 1, parent = 20)),
            issues = mapOf("20" to answer(doc(20, 2, done = true))),
            onIssue = { delay(5_000) },
        )
        val failure = assertFailsWith<FetchException> { browse(site, deadlineMillis = 300, filter = Filter().holder, now = today) }
        assertEquals("TIMEOUT", failure.code)
    }

    @Test
    fun `paging stops at the cap, at the first issue beyond it`() {
        val site = ScriptedSite(
            searchPage(epic(1), epic(2), next = "t2"), searchPage(epic(3), epic(4), next = "t3"), searchPage(epic(5)),
        )
        val result = browse(site, cap = 3)
        assertEquals(listOf("1", "2", "3"), result.issues.map { it.observation.issueId })
        assertTrue(result.truncated)
        assertEquals(2, site.searches.size, "the third page is never asked for")
    }

    @Test
    fun `exactly the cap is not truncated, and a full page at the cap costs one more page to find out`() {
        val exact = ScriptedSite(searchPage(epic(1), epic(2)))
        assertFalse(browse(exact, cap = 2).truncated)
        assertEquals(1, exact.searches.size)
        val more = ScriptedSite(searchPage(epic(1), epic(2), next = "t2"), searchPage(epic(3)))
        val result = browse(more, cap = 2)
        assertTrue(result.truncated)
        assertEquals(listOf("1", "2"), result.issues.map { it.observation.issueId })
        assertEquals(2, more.searches.size)
    }

    @Test
    fun `an issue a restart delivers twice counts once toward the cap`() {
        val site = ScriptedSite(searchPage(epic(1), epic(2), next = "t2"), searchPage(epic(2), epic(3)))
        val result = browse(site, cap = 3)
        assertEquals(listOf("1", "2", "3"), result.issues.map { it.observation.issueId })
        assertFalse(result.truncated)
    }

    @Test
    fun `the per-page stop runs before every page and ends the browse`() {
        val site = ScriptedSite(searchPage(epic(1), next = "t2"), searchPage(epic(2)))
        val asked = AtomicInteger()
        val stopped = assertFailsWith<IllegalStateException> {
            browse(site, beforePage = { if (asked.incrementAndGet() == 2) error("the connection went away") })
        }
        assertEquals("the connection went away", stopped.message)
        assertEquals(2, asked.get())
        assertEquals(1, site.searches.size, "the second page was never requested")
    }

    @Test
    fun `the request is the typed full read and names the mapped fields, and the token is only the Authorization header`() {
        val site = ScriptedSite(searchPage(epic(1)))
        browse(site)
        val request = site.searches.single()
        val jql = request.url.parameters["jql"].orEmpty()
        assertTrue(jql.startsWith("""project in ("IMP") AND issuetype in (""") && jql.endsWith(") ORDER BY id ASC"), jql)
        assertEquals(setOf("10004", "10005", "10006"), jql.substringAfter("issuetype in (").substringBefore(")").split(",").toSet())
        val fields = request.url.parameters["fields"].orEmpty().split(",")
        val wanted = listOf("summary", "issuetype", "parent", "customfield_1", "customfield_2", "customfield_3", "customfield_9")
        assertTrue(wanted.all { it in fields }, fields.toString())
        assertEquals("2", request.url.parameters["maxResults"])
        assertTrue(token !in request.url.toString(), "the token never rides the URL")
        assertTrue(request.headers[HttpHeaders.Authorization].orEmpty().startsWith("Basic "))
    }

    @Test
    fun `each issue is read at its own plan level and keeps its direct parent's issue type`() {
        val mapping = importMapping().let {
            it.copy(levels = it.levels.copy(project = JiraLevelMapping(JIRA_PROJECT, JiraLevelFields("customfield_4", "customfield_5"))))
        }
        val initiative = issueDoc(
            "20", "IMP-20", typeId = "10005", typeName = "Initiative", level = null,
            fields = """"customfield_4":"2027-03-01","customfield_5":"2027-03-05","customfield_1":"2030-01-01",""" +
                """"parent":{"id":"10","key":"IMP-10","fields":{"issuetype":{"id":"10006","name":"Program"}}}""",
        )
        val epic = issueDoc(
            "30", "IMP-30", fields = """"customfield_1":"2027-04-01","parent":{"id":"20","key":"IMP-20","fields":{"issuetype":""" +
                """{"id":"10005","name":"Initiative","hierarchyLevel":2}}}""",
        )
        val result = browse(ScriptedSite(searchPage(initiative, epic)), mapping).issues.associateBy { it.observation.issueId }
        val project = result.getValue("20")
        assertEquals(JIRA_PROJECT, project.observation.hierarchyLevel, "the level comes from the discovery by type id")
        val dates = project.observation.let { listOf(it.startDate, it.endDate) }
        assertEquals(listOf(LocalDate.parse("2027-03-01"), LocalDate.parse("2027-03-05")), dates)
        assertEquals(listOf("10006", null), listOf(project.parentTypeId, project.parentTypeHierarchyLevel))
        val milestone = result.getValue("30")
        assertEquals(LocalDate.parse("2027-04-01"), milestone.observation.startDate)
        assertEquals(listOf("10005", JIRA_PROJECT), listOf(milestone.parentTypeId, milestone.parentTypeHierarchyLevel))
        assertEquals("20", milestone.observation.parentIssueId)
    }

    @Test
    fun `a mapped level with no issue type is a 409 before any request`() {
        val site = ScriptedSite(searchPage(epic(1)))
        val mapping = importMapping().let { it.copy(levels = it.levels.copy(program = JiraLevelMapping(7))) }
        assertFailsWith<ConflictException> { browse(site, mapping) }
        assertTrue(site.engine.requestHistory.isEmpty())
    }

    @Test
    fun `a page that is no listing is INVALID_RESPONSE, and nothing is partially kept`() {
        val site = ScriptedSite("""{"isLast":true}""")
        val failure = assertFailsWith<FetchException> { browse(site) }
        assertEquals("INVALID_RESPONSE", failure.code)
    }

    @Test
    fun `a browse past its deadline fails TIMEOUT, and the caller's own cancellation is not mistaken for it`() {
        val slow = ScriptedSite(searchPage(epic(1)), onSearch = { delay(5_000) })
        val failure = assertFailsWith<FetchException> { browse(slow, deadlineMillis = 300) }
        assertEquals("TIMEOUT", failure.code)
        val cancelled = ScriptedSite(searchPage(epic(1)), onSearch = { delay(5_000) })
        val outcome = runBlocking {
            val job = launch { browse(cancelled) }
            delay(300)
            job.cancelAndJoin()
            job.isCancelled
        }
        assertTrue(outcome, "a cancelled caller is cancelled, not turned into a TIMEOUT failure")
    }
}
