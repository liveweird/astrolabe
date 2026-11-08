package ch.nokillswit

import ch.nokillswit.jira.DiscoveredFields
import ch.nokillswit.jira.DiscoveredIssueType
import ch.nokillswit.jira.JiraAuthScheme
import ch.nokillswit.jira.JiraClient
import ch.nokillswit.jira.JiraConnector
import ch.nokillswit.jira.JiraSearchPage
import ch.nokillswit.jira.JiraStartAtPage
import ch.nokillswit.jira.JiraTestResult
import ch.nokillswit.jira.JiraTestTarget
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The connector's `projects` / `project:<KEY>` probes over a scripted [JiraClient]: how `project/search` pages are followed (`isLast`,
 * the `total` fallback when `isLast` is absent), the page bound, and which keys count as visible.
 */
class JiraConnectorTest {
    private fun page(vararg keys: String, startAt: Int = 0, total: Int = keys.size, isLast: Boolean? = null): JiraStartAtPage {
        val values = keys.joinToString(prefix = "[", postfix = "]") { """{"key":"$it"}""" }
        return JiraStartAtPage(startAt, 50, total, isLast, Json.parseToJsonElement(values) as JsonArray)
    }

    /** A client answering every probe but `project/search`, which [pages] scripts by the `startAt` asked for. */
    private class Scripted(val pages: (Int) -> JiraStartAtPage) : JiraClient {
        val asked = mutableListOf<Pair<List<String>, Int>>()
        override val maxConcurrentRequests = 1
        override suspend fun resolveCloudId() = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        override suspend fun myself() = JsonObject(emptyMap())
        override suspend fun searchJql(jql: String, fields: String?, nextPageToken: String?, maxResults: Int) =
            JiraSearchPage(Json.parseToJsonElement("""[{"id":"1"}]""") as JsonArray)
        override suspend fun issue(idOrKey: String, fields: String?) = JsonObject(emptyMap())
        override suspend fun fields() = DiscoveredFields(0, emptyList())
        override suspend fun issueTypes() = listOf(DiscoveredIssueType("10004", "Epic", 1, false))
        override suspend fun projectsSearch(keys: List<String>, startAt: Int): JiraStartAtPage {
            asked += keys to startAt
            return pages(startAt)
        }
    }

    private fun probe(client: Scripted, keys: List<String>) = runBlocking {
        val connector = JiraConnector({ _, _, _, _ -> client }, pageSize = 100, incrementalOverlapMinutes = 10)
        connector.testConnection(JiraTestTarget("https://sample.atlassian.net", "a@b.test", "tok", JiraAuthScheme.BASIC, keys)).result
    }

    @Test
    fun `testConnection says stub only when the probes ran - a refused host or an unreadable token reads false`() = runBlocking {
        val stubSite = "https://stub-sample.atlassian.net"
        suspend fun result(routed: Boolean, site: String, token: String?): JiraTestResult {
            val connector = JiraConnector(
                { _, _, _, _ -> Scripted { page("E2E", total = 1) } }, pageSize = 100, incrementalOverlapMinutes = 10,
                routedToStub = { routed }, // true for EVERY site: only the code path may decide
            )
            return connector.testConnection(JiraTestTarget(site, "a@b.test", token, JiraAuthScheme.BASIC, listOf("E2E"))).result
        }
        assertTrue(result(true, stubSite, "tok").stub, "a probed, routed site")
        assertFalse(result(false, stubSite, "tok").stub, "a probed site the predicate does not route")
        val unreadable = result(true, stubSite, null)
        assertEquals(listOf("stored_token"), unreadable.rows.map { it.name })
        assertFalse(unreadable.stub, "no call was made, so the stub answered nothing")
        val refused = result(true, "$stubSite/x", "tok")
        assertEquals(listOf("BLOCKED_HOST"), refused.rows.map { it.code })
        assertFalse(refused.stub, "no call was made, so the stub answered nothing")
        assertFalse(probe(Scripted { page("E2E", total = 1) }, listOf("E2E")).stub, "no predicate = never a stub")
    }

    @Test
    fun `a key on a later page counts when isLast says there is more, and the keys filter travels with every page`() {
        val client = Scripted { startAt ->
            if (startAt == 0) page("E2E", isLast = false, total = 2) else page("CE", startAt = 1, isLast = true, total = 2)
        }
        val result = probe(client, listOf("E2E", "CE"))
        assertEquals(listOf(listOf("E2E", "CE") to 0, listOf("E2E", "CE") to 1), client.asked)
        assertTrue(result.rows.filter { it.name.startsWith("project:") }.all { it.ok }, "${result.rows}")
        assertTrue(result.passed, "${result.rows}")
    }

    @Test
    fun `without isLast the total decides - a page short of it is followed, reaching it stops`() {
        val client = Scripted { startAt -> if (startAt == 0) page("E2E", total = 2) else page("CE", startAt = 1, total = 2) }
        val result = probe(client, listOf("E2E", "CE"))
        assertEquals(2, client.asked.size)
        assertTrue(result.passed, "${result.rows}")
        val one = Scripted { page("E2E", total = 1) }
        probe(one, listOf("E2E"))
        assertEquals(1, one.asked.size, "total reached on the first page")
    }

    @Test
    fun `an empty page ends the paging, and a key it never listed is a failed project row`() {
        val client = Scripted { startAt -> if (startAt == 0) page("E2E", isLast = false, total = 9) else page(startAt = 1, total = 9) }
        val result = probe(client, listOf("E2E", "CE"))
        val rows = result.rows.filter { it.name.startsWith("project:") }
        assertEquals(listOf("project:E2E" to true, "project:CE" to false), rows.map { it.name to it.ok })
        assertEquals("PROJECT_NOT_VISIBLE", rows.last().code)
    }

    @Test
    fun `a site that keeps answering more pages is LIMIT_EXCEEDED on the projects row after a bounded number of pages`() {
        val client = Scripted { startAt -> page("E2E", startAt = startAt, isLast = false, total = 1_000_000) }
        val result = probe(client, listOf("E2E"))
        assertEquals(5, client.asked.size, "the loop is bounded")
        val row = result.rows.single { it.name == "projects" }
        assertEquals(false, row.ok)
        assertEquals("LIMIT_EXCEEDED", row.code)
        assertTrue(result.rows.none { it.name.startsWith("project:") }, "no key rows once the listing failed")
    }

    @Test
    fun `an entry that is not a project key is ignored`() {
        val client = Scripted { page("E2E", "bad key", "lower", "A".repeat(30), isLast = true) }
        val result = probe(client, listOf("E2E"))
        assertTrue(result.passed, "${result.rows}")
    }
}
