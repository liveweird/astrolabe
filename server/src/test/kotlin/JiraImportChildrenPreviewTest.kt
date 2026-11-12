package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportInfo
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportPreview
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraImportRoot
import ch.nokillswit.jira.JiraImportRootLevel
import ch.nokillswit.jira.JiraLevel
import com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor
import com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The rooted preview (1.14) against the stub's `IMC` project: the table of `sample-data/jira/expected.json` `imc.byRoot` for `IMC-1`
 * (the world's program linked to it), `IMC-2` (the world's project) and `IMC-14`, the requests the stub saw (the root by id, then the
 * `parent in (...)` rounds), where each row lands, and that the root, and the tree of `IMC-11..13`, are never rows. A preview writes
 * nothing; each caller makes at most five calls a minute.
 */
class JiraImportChildrenPreviewTest {
    private val searchPattern = urlPathMatching(".*/rest/api/3/search/jql")
    private val issuePattern = urlPathMatching(".*/rest/api/3/issue/[0-9]+")

    /** The `jql` of every search that reached the stub since the last [JiraStubServer.resetRequests], in order. */
    private fun stubSearches(): List<String> =
        JiraStubServer.requests(getRequestedFor(searchPattern)).map { it.queryParameter("jql").firstValue() }

    /** The Jira ids read BY ID since the last reset, in order. */
    private fun stubIssueReads(): List<String> =
        JiraStubServer.requests(getRequestedFor(issuePattern)).map { it.url.substringBefore('?').substringAfterLast('/') }

    private val both = JiraImportFilter(excludeDone = true, updatedWithinDays = 365)
    private val doneOnly = JiraImportFilter(excludeDone = true)
    private val windowOnly = JiraImportFilter(updatedWithinDays = 365)

    /** What one root under one filter must show: the rows, the create count, the skipped (`IMC-9`) count and the kept parents. */
    private class Figures(val filter: JiraImportFilter?, val rows: List<Int>, val create: Int, val skip: Int, val kept: List<String>)

    private val program = listOf(
        Figures(null, (2..10).toList(), 8, 1, emptyList()),
        Figures(both, listOf(2, 3, 5, 7, 9), 4, 1, listOf("IMC-3")),
        Figures(doneOnly, listOf(2, 3, 5, 7, 9, 10), 5, 1, listOf("IMC-3")),
        Figures(windowOnly, (2..9).toList(), 7, 1, emptyList()),
    )

    private fun JiraImportPreview.byKey() = items.associateBy { it.key() }

    @Test
    fun `a program root lists its projects and milestones under the filters of the table, and never the root or another program's tree`() =
        testApplication {
            val f = importFixture("jcp1", keys = listOf("IMC"))
            val root = f.linkProgram()
            val admin = f.w.admin.client
            val revision = TestPlan.revision()
            val bindings = activeBindingCount(f.connectionId)
            for (figures in program) {
                val label = figures.filter.toString()
                JiraStubServer.resetRequests()
                val preview = admin.preview(f.connectionId, f.scope(filter = figures.filter, root = root)).previewBody()
                assertEquals(figures.rows.map { "IMC-$it" }, preview.keys().sortedBy { it.substringAfter('-').toInt() }, label)
                val totals = preview.totals.let { listOf(it.items, it.create, it.skip) }
                assertEquals(listOf(figures.rows.size, figures.create, figures.skip), totals, label)
                assertFalse(preview.totals.truncated, label)
                val never = listOf("IMC-1", "IMC-11", "IMC-12", "IMC-13", "IMC-14")
                assertTrue(preview.keys().none { it in never }, "$label: ${preview.keys()}")
                val orphan = preview.byKey().getValue("IMC-9")
                assertEquals(listOf(JiraImportAction.SKIP, JiraImportReason.NO_PARENT), listOf(orphan.action, orphan.reason), label)
                val kept = preview.items.filter { JiraImportInfo.KEPT_AS_PARENT in it.infos }.map { it.key() }
                assertEquals(figures.kept, kept, label)
                assertEquals(listOf(imcId(1)), stubIssueReads(), "$label: the root by id, and no parent is read by id")
                checkJournal(figures.filter)
            }
            assertEquals(revision, TestPlan.revision(), "a preview bumps nothing")
            assertEquals(bindings, activeBindingCount(f.connectionId), "and links nothing")
        }

    private fun checkJournal(filter: JiraImportFilter?) {
        val clauses = buildString {
            if (filter?.excludeDone == true) append(" AND statusCategory != Done")
            if (filter?.updatedWithinDays != null) append(""" AND updated >= "-525600m"""")
        }
        assertEquals(
            listOf(
                """project in ("IMC") AND issuetype in (10005,10004) AND parent in (99001) ORDER BY id ASC""",
                """project in ("IMC") AND issuetype in (10004) AND parent in (99002,99003,99004)$clauses ORDER BY id ASC""",
            ),
            stubSearches(),
            "round one is unfiltered at the source, round two (the leaf level) carries the filter's clauses",
        )
    }

    @Test
    fun `each row lands under the root's own node or under its project's row, and a default project homes the item under the program`() =
        testApplication {
            val f = importFixture("jcp2", keys = listOf("IMC"))
            val root = f.linkProgram()
            val admin = f.w.admin.client
            val plain = admin.preview(f.connectionId, f.scope(root = root)).previewBody().byKey()
            for (key in listOf("IMC-2", "IMC-3", "IMC-4")) {
                val project = plain.getValue(key)
                assertEquals(listOf(JiraLevel.PROJECT, JiraImportAction.CREATE), listOf(project.level, project.action), key)
                assertEquals(listOf(JiraImportParentKind.EXISTING, f.w.programId), project.parent!!.let { listOf(it.kind, it.nodeId) }, key)
            }
            for ((key, parent) in mapOf("IMC-5" to 2, "IMC-6" to 2, "IMC-10" to 2, "IMC-7" to 3, "IMC-8" to 4)) {
                val milestone = plain.getValue(key)
                val under = milestone.parent!!.let { listOf(it.kind, it.rowJiraId) }
                assertEquals(listOf(JiraImportParentKind.NEW_ROW, imcId(parent)), under, key)
            }
            // IMC-9 hangs straight under the program: the default project (one of the root program's projects) takes it.
            val defaults = JiraImportDefaults(projectId = f.w.projectId, teamId = f.defaultTeam)
            val homed = admin.preview(f.connectionId, f.scope(defaults, root = root)).previewBody()
            val nine = homed.byKey().getValue("IMC-9")
            assertEquals(listOf(JiraImportAction.CREATE, JiraImportParentKind.DEFAULT), listOf(nine.action, nine.parent!!.kind))
            assertEquals(f.w.projectId, nine.parent!!.nodeId)
            assertEquals(listOf(9, 9, 0), homed.totals.let { listOf(it.items, it.create, it.skip) })
        }

    @Test
    fun `a project root lists its milestones only, and a program with nothing under it lists nothing`() = testApplication {
        val f = importFixture("jcp3", keys = listOf("IMC"))
        val project = f.linkProject("IMC-2")
        // The world's program is a different node: it can hold the empty root IMC-14 at the same time.
        val empty = f.linkProgram("IMC-14")
        val admin = f.w.admin.client
        JiraStubServer.resetRequests()
        val plain = admin.preview(f.connectionId, f.scope(root = project)).previewBody()
        assertEquals(listOf("IMC-5", "IMC-6", "IMC-10"), plain.keys())
        assertEquals(listOf(3, 3, 0), plain.totals.let { listOf(it.items, it.create, it.skip) })
        assertTrue(plain.items.all { it.parent!!.let { p -> p.kind == JiraImportParentKind.EXISTING && p.nodeId == f.w.projectId } })
        assertEquals(listOf(imcId(2)), stubIssueReads())
        assertEquals(listOf("""project in ("IMC") AND issuetype in (10004) AND parent in (99002) ORDER BY id ASC"""), stubSearches())

        val narrowed = admin.preview(f.connectionId, f.scope(filter = both, root = project)).previewBody()
        assertEquals(listOf("IMC-5"), narrowed.keys())
        assertEquals(listOf(1, 1), narrowed.totals.let { listOf(it.items, it.create) })

        JiraStubServer.resetRequests()
        val nothing = admin.preview(f.connectionId, f.scope(filter = both, root = empty)).previewBody()
        assertEquals(emptyList(), nothing.items)
        assertEquals(listOf(0, 0, 0, 0), nothing.totals.let { listOf(it.items, it.create, it.bind, it.skip) })
        assertEquals(listOf(imcId(14)), stubIssueReads())
        assertEquals(1, stubSearches().size, "round one only: no project, so no round two")
    }

    @Test
    fun `the program's owner previews under their program while their whole-scope preview is a 403`() = testApplication {
        val f = importFixture("jcp4", keys = listOf("IMC"))
        val root = f.linkProgram()
        val owner = f.w.programOwner.client
        val rooted = owner.preview(f.connectionId, f.scope(root = root))
        assertEquals(HttpStatusCode.OK, rooted.status, rooted.bodyAsText())
        assertEquals(8, rooted.previewBody().totals.create)
        // The whole scope would also create the programs IMC-11 and IMC-14 under the work stream, which the program's owner does not own.
        val whole = owner.preview(f.connectionId, f.scope())
        assertEquals(HttpStatusCode.Forbidden, whole.status)
        assertTrue("work stream" in whole.jbProblem().detail.orEmpty())
    }

    @Test
    fun `an answered rooted preview leaves ONE jira_import_previewed line of ids, a refused one none, and no log line carries the token`() =
        testApplication {
            val f = importFixture("jcp5", keys = listOf("IMC"))
            val root = f.linkProgram()
            val owner = f.w.programOwner
            val logs = LogCapture("ROOT")
            try {
                withAuditCapture { audit ->
                    // The refusals first: a stranger (403) and an unlinked project root (409) leave no preview line.
                    assertEquals(HttpStatusCode.Forbidden, f.w.stranger.client.preview(f.connectionId, f.scope(root = root)).status)
                    val unlinked = JiraImportRoot(JiraImportRootLevel.PROJECT, f.w.projectId)
                    assertEquals(HttpStatusCode.Conflict, f.w.admin.client.preview(f.connectionId, f.scope(root = unlinked)).status)
                    assertTrue(audit.events.none { it.message == "jira.import_previewed" }, "a refused preview is not audited as a read")

                    val preview = owner.client.preview(f.connectionId, f.scope(root = root)).previewBody()
                    val lines = audit.events.filter { it.message == "jira.import_previewed" }
                    val line = lines.single()
                    assertTrue(line.hasKeyValue("byUserId", owner.userId.toLong()))
                    assertTrue(line.hasKeyValue("connectionId", f.connectionId.toLong()))
                    assertTrue(line.hasKeyValue("rootLevel", "PROGRAM"))
                    assertTrue(line.hasKeyValue("rootNodeId", f.w.programId.toLong()))
                    assertTrue(line.hasKeyValue("rows", preview.items.size))
                    assertEquals(
                        setOf("byUserId", "connectionId", "rootLevel", "rootNodeId", "rows"),
                        line.keyValuePairs.orEmpty().map { it.key }.toSet(),
                        "ids and a count: no key, name or summary",
                    )
                    val text = line.formattedMessage + line.keyValuePairs.orEmpty().joinToString { "${it.key}=${it.value}" }
                    assertTrue(listOf("IMC", "Initiative", "Issue").none { it in text }, text)

                    // The rooted apply logs its own line and still reads no Jira text into a log.
                    owner.client.applyImport(f.connectionId, f.scope(root = root), preview.ticks()).applyBody()
                    assertEquals(1, audit.events.count { it.message == "jira.import_applied" })
                    assertEquals(1, audit.events.count { it.message == "jira.import_previewed" }, "the apply is not a preview")
                }
                val host = f.site.substringAfter("://")
                val everything = logs.events.map { it.formattedMessage + it.keyValuePairs.orEmpty().joinToString { kv -> "${kv.value}" } }
                assertTrue(everything.none { f.token in it }, "the token never reaches a log line")
                assertTrue(everything.none { host in it }, "nor does the site's address")
            } finally {
                logs.detach()
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
