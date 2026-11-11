package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportInfo
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportPreview
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import com.github.tomakehurst.wiremock.client.MappingBuilder
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor
import com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The import filter (1.13.2) end to end against the stub's isolated `IMF` project (15 listed issues, one hidden parent `IMF-16` the stub
 * answers `404` for; `sample-data/jira/README.md`). The stub does NOT evaluate the filter: its windowed browse lists every issue, so the
 * server's own rule drops what it does not admit and the missing direct parents are read by id, which the stub answers per issue. The
 * stub's request journal proves WHAT was asked: the search's `jql` and the by-id reads in order. The figures are `expected.json`
 * `imf.byFilter`.
 * A caller makes at most five calls a minute (the `jira-import` bucket). An apply creates the global program names "IMF Program" and
 * "IMF Program Old": [deleteImfPrograms] in a `finally`.
 */
class JiraImportFilterPreviewTest {
    private val searchPattern = urlPathMatching(".*/rest/api/3/search/jql")
    private val issuePattern = urlPathMatching(".*/rest/api/3/issue/[0-9]+")
    private val both = JiraImportFilter(excludeDone = true, updatedWithinDays = 365)
    private val doneOnly = JiraImportFilter(excludeDone = true)
    private val windowOnly = JiraImportFilter(updatedWithinDays = 365)

    /** `IMF-n` has the id 98000 + n. */
    private fun keyOf(id: Long) = "IMF-${id - 98_000}"

    /** The search requests' `jql` and the by-id reads (as keys), in order, since the last [JiraStubServer.resetRequests]. */
    private fun journal(): Pair<List<String>, List<String>> {
        val searches = JiraStubServer.requests(getRequestedFor(searchPattern)).map { it.queryParameter("jql").firstValue() }
        val reads = JiraStubServer.requests(getRequestedFor(issuePattern))
            .map { keyOf(it.url.substringBefore('?').substringAfterLast('/').toLong()) }
        return searches to reads
    }

    private fun JiraImportPreview.byKey() = items.associateBy { it.issueKey }

    private fun JiraImportPreview.infoKeys(info: JiraImportInfo) = items.filter { info in it.infos }.map { it.issueKey }.sorted()

    private fun deleteImfPrograms() {
        jbSql(
            "UPDATE programs SET marked_as_deleted = TRUE " +
                "WHERE LOWER(name) IN ('imf program', 'imf program old') AND NOT marked_as_deleted",
        )
    }

    private fun failingIssue(key: Int): MappingBuilder =
        get(urlPathMatching(".*/rest/api/3/issue/${98_000 + key}")).atPriority(1).willReturn(aResponse().withStatus(500))

    private fun keysOf(preview: JiraImportPreview) = preview.items.map { it.issueKey }.sortedBy { it.substringAfter('-').toInt() }

    private fun left(vararg numbers: Int) = numbers.map { "IMF-$it" }

    /** What one filter must show (B6's table): [rows], the create/skip split, the left-out keys, the kept parents and the by-id reads. */
    private class Figures(
        val filter: JiraImportFilter?,
        val rows: Int,
        val create: Int,
        val leftOut: List<String>,
        val kept: List<String>,
        val reads: List<String>,
    )

    private val table = listOf(
        Figures(null, 15, 14, emptyList(), emptyList(), emptyList()),
        Figures(both, 11, 10, left(5, 9, 10, 11), left(3, 4, 12, 13), left(3, 4, 13, 16, 12)),
        Figures(doneOnly, 12, 11, left(5, 9, 10), left(3, 12, 13), left(3, 13, 16, 12)),
        Figures(windowOnly, 14, 13, left(11), left(4, 12, 13), left(4, 13, 16, 12)),
    )

    @Test
    fun `each filter shows its rows, keeps the parents it needs and reads them by id in the order of the chain`() = testApplication {
        val f = importFixture("jif1", keys = listOf("IMF"))
        val admin = f.w.admin.client
        for (figures in table) {
            JiraStubServer.resetRequests()
            val preview = admin.preview(f.connectionId, f.scope(filter = figures.filter)).previewBody()
            val label = figures.filter.toString()
            assertEquals(figures.rows, preview.totals.items, label)
            assertEquals(listOf(figures.create, 1), listOf(preview.totals.create, preview.totals.skip), label)
            assertTrue(!preview.totals.truncated, label)
            val shown = keysOf(preview).toSet()
            assertTrue(figures.leftOut.none { it in shown }, "$label: nothing left out is shown")
            assertEquals((1..15).map { "IMF-$it" }.filter { it !in figures.leftOut }.toSet(), shown, label)
            assertEquals(figures.kept, preview.infoKeys(JiraImportInfo.KEPT_AS_PARENT).sortedBy { it.substringAfter('-').toInt() }, label)
            val skipped = preview.items.single { it.action == JiraImportAction.SKIP }
            assertEquals(listOf("IMF-15", JiraImportReason.NO_PARENT), listOf(skipped.issueKey, skipped.reason), label)
            val unreadable = if (figures.filter == null) emptyList() else listOf(JiraImportInfo.PARENT_UNREADABLE)
            assertEquals(unreadable, skipped.infos, label)

            val (searches, reads) = journal()
            assertEquals(1, searches.size, label)
            val jql = searches.single()
            assertEquals(figures.filter?.excludeDone == true, "statusCategory != Done" in jql, "$label: $jql")
            assertEquals(figures.filter?.updatedWithinDays != null, "updated >= \"-525600m\"" in jql, "$label: $jql")
            assertEquals(figures.reads, reads, "$label: the by-id reads, in order")
        }
    }

    @Test
    fun `a chain through two left-out levels lands under the kept parents, and a parent that answers 404 is not replaced by a default`() =
        testApplication {
            val f = importFixture("jif2", keys = listOf("IMF"))
            val admin = f.w.admin.client
            val withProject = JiraImportDefaults(projectId = f.w.projectId, teamId = f.defaultTeam)
            val filtered = admin.preview(f.connectionId, f.scope(withProject, filter = both)).previewBody().byKey()
            val under = { key: String -> filtered.getValue(key).parent }
            assertEquals(listOf(JiraImportParentKind.NEW_ROW, "IMF Initiative Done"), under("IMF-7")!!.let { listOf(it.kind, it.nodeName) })
            assertEquals(listOf(JiraImportParentKind.NEW_ROW, "IMF Initiative Old"), under("IMF-14")!!.let { listOf(it.kind, it.nodeName) })
            assertEquals(JiraImportAction.CREATE, filtered.getValue("IMF-13").action)
            assertEquals(JiraLevel.PROGRAM, filtered.getValue("IMF-12").level)
            val unreadable = filtered.getValue("IMF-15")
            assertEquals(JiraImportReason.NO_PARENT, unreadable.reason, "a default project does not take a child of an unreadable parent")
            assertEquals(listOf(JiraImportInfo.PARENT_UNREADABLE), unreadable.infos)
            // Without a filter nothing was read, so nothing is known about that parent: the default project takes it, as it always did.
            val plain = admin.preview(f.connectionId, f.scope(withProject)).previewBody().byKey().getValue("IMF-15")
            assertEquals(listOf(JiraImportAction.CREATE, JiraImportParentKind.DEFAULT), listOf(plain.action, plain.parent?.kind))
            assertTrue(JiraImportInfo.PARENT_UNREADABLE !in plain.infos, "nothing was read, so nothing is claimed")
        }

    @Test
    fun `a parent already linked to a plan node is not read, and its children land on that node`() = testApplication {
        val f = importFixture("jif3", keys = listOf("IMF"))
        val admin = f.w.admin.client
        admin.jbBind(f.connectionId, JiraLevel.PROJECT, f.w.projectId, "IMF-3").jbBinding()
        JiraStubServer.resetRequests()
        val preview = admin.preview(f.connectionId, f.scope(filter = both)).previewBody()
        val (_, reads) = journal()
        assertEquals(left(4, 13, 16, 12), reads, "IMF-3 is linked: no read")
        val seven = preview.byKey().getValue("IMF-7")
        assertEquals(listOf(JiraImportParentKind.EXISTING, f.w.projectId), listOf(seven.parent?.kind, seven.parent?.nodeId))
        assertTrue("IMF-3" !in preview.items.map { it.issueKey }, "a linked parent needs no row")
        assertEquals(left(4, 12, 13), preview.infoKeys(JiraImportInfo.KEPT_AS_PARENT).sortedBy { it.substringAfter('-').toInt() })
    }

    @Test
    fun `a parent read that fails with a 500 is the 502, with the code only`() = testApplication {
        val f = importFixture("jif4", keys = listOf("IMF"))
        val override = JiraStubServer.addOverride(failingIssue(3))
        try {
            val response = f.w.admin.client.preview(f.connectionId, f.scope(filter = both))
            val body = response.bodyAsText()
            assertEquals(HttpStatusCode.BadGateway, response.status, body)
            val problem = jbJson.decodeFromString<ch.nokillswit.plugins.ProblemDetail>(body)
            assertTrue(Regex("Jira did not answer \\([A-Z_0-9]+\\)").matches(problem.detail.orEmpty()), problem.detail)
            assertEquals("urn:astrolabe:problem:jira-upstream", problem.type)
            assertTrue("98003" !in body && f.token !in body && "IMF-3" !in body, "nothing of the upstream reaches the client")
        } finally {
            JiraStubServer.removeOverride(override)
        }
    }

    @Test
    fun `an apply of the filtered preview writes its rows, and a second preview reads one parent only`() = testApplication {
        val f = importFixture("jif5", keys = listOf("IMF"))
        val admin = f.w.admin.client
        try {
            val scope = f.scope(filter = both)
            val preview = admin.preview(f.connectionId, scope).previewBody()
            val result = admin.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
            assertEquals(10, result.created.size)
            assertTrue(result.skipped.isEmpty(), result.skipped.toString())
            assertEquals(left(1, 2, 3, 4, 6, 7, 8, 12, 13, 14).toSet(), result.created.map { it.issueKey }.toSet())

            JiraStubServer.resetRequests()
            val again = admin.preview(f.connectionId, scope).previewBody()
            assertEquals(7, again.totals.items, "the seven items the filter admits")
            val reasons = again.items.associate { it.issueKey to it.reason }
            val bound = left(1, 2, 6, 7, 8, 14)
            assertTrue(bound.all { reasons[it] == JiraImportReason.ALREADY_BOUND }, reasons.toString())
            assertEquals(JiraImportReason.NO_PARENT, reasons["IMF-15"])
            assertEquals(left(16), journal().second, "ONE by-id read: only the child that is not linked asks for its parent")
        } finally {
            deleteImfPrograms()
        }
    }

    @Test
    fun `an apply under a narrower filter than its preview answers CHANGED for what the filter now leaves out and re-homes nothing`() =
        testApplication {
            val f = importFixture("jif6", keys = listOf("IMF"))
            val admin = f.w.admin.client
            try {
                val preview = admin.preview(f.connectionId, f.scope(filter = doneOnly)).previewBody()
                assertTrue("IMF-11" in preview.items.map { it.issueKey }, "the quiet open epic is in the done-only preview")
                withAuditCapture { audit ->
                    val result = admin.applyImport(f.connectionId, f.scope(filter = both), preview.ticks()).applyBody()
                    // IMF-11 (id 98011) is quiet: the re-browse under the narrower filter no longer holds it: CHANGED, no key.
                    val skipped = result.skipped.single()
                    assertEquals(listOf("98011", null, JiraImportReason.CHANGED), listOf(skipped.jiraId, skipped.issueKey, skipped.reason))
                    assertEquals(10, result.created.size, "every other ticked row is written where the preview showed it")
                    val event = assertNotNull(audit.awaitEvent { it.message == "jira.import_applied" })
                    assertTrue(event.hasKeyValue("excludeDone", true))
                    assertTrue(event.hasKeyValue("updatedWithinDays", 365))
                }
            } finally {
                deleteImfPrograms()
            }
        }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
