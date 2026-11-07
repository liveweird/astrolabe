package ch.nokillswit

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.jira.ImportBrowse
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
    ): ImportBrowse = runBlocking {
        browseScope(site.connector, context, token, listOf("IMP"), mapping, IMPORT_DISCOVERY, 1L, beforePage, cap, deadlineMillis)
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
