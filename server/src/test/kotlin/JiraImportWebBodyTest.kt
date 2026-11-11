package ch.nokillswit

import ch.nokillswit.jira.ImportApply
import ch.nokillswit.jira.ImportTree
import ch.nokillswit.jira.JiraImportApplyRequest
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import io.ktor.serialization.kotlinx.json.DefaultJson
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The web client's apply body, as literal JSON, through the REAL deserialization (the app's `json()` is Ktor's `DefaultJson`: strict, no
 * `ignoreUnknownKeys`) and the kernel's own `matches`: no ticked row of any shape may read `CHANGED`, and every one is written.
 * Each literal
 * is what `web/src/utils/jiraImport.ts` `toApplyRequest` / `expectedOf` emits for that row (keys that do not apply are OMITTED; a CREATE's
 * `parent` is projected to `{kind, nodeId}`; a BIND carries `nodeId`; a milestone CREATE carries the `teamId` the preview row showed). The
 * web test `JiraImportModal.test.tsx` pins the same shapes from the other side. If either builder changes, change both.
 */
class JiraImportWebBodyTest {
    /** A literal split over lines for the line-length rule; the lines are joined back, so the JSON is exactly what was written. */
    private fun json(literal: String): String = literal.lines().joinToString("") { it.trim() }

    private val program = json("""{"jiraId":"100",
"expected":{"action":"CREATE","level":"PROGRAM"}}""")
    private val project = json("""{"jiraId":"200",
"expected":{"action":"CREATE","level":"PROJECT","parentJiraId":"100",
"parent":{"kind":"NEW_ROW"}}}""")

    private val stream = ImportTree(listOf(node(7u, "Platform program")), listOf(node(7u, "Existing project", parentId = 7u)), emptyList())
    private val streamWithMilestone = ImportTree(
        listOf(node(7u, "Platform program")),
        listOf(node(7u, "Existing project", parentId = 7u)),
        listOf(node(9u, "Item 300", parentId = 7u)),
    )
    private val unboundProgram = ImportTree(listOf(node(7u, "Item 100")), emptyList(), emptyList())

    private fun assertApplied(case: ImportCase, vararg items: String) {
        val body = """{"workStreamId":3,"ownerPersonId":8,"copyDates":true,"items":[${items.joinToString(",")}]}"""
        val request = DefaultJson.decodeFromString<JiraImportApplyRequest>(body)
        val applied = case.plan(request.items)
        assertTrue(applied.rows.none { it.item.reason == JiraImportReason.CHANGED }, "a web body must never read CHANGED")
        for (ticked in request.items) {
            val row = applied.row(ticked.jiraId)
            assertIs<ImportApply.Write>(row.apply, "row ${ticked.jiraId} should be written, was ${row.apply}")
        }
        assertEquals(request.items.size, applied.rows.count { it.apply is ImportApply.Write })
    }

    @Test
    fun `a program, a project and a milestone created under new rows, the milestone with the team Jira named`() {
        val case = ImportCase(
            listOf(
                issue("100", JIRA_PROGRAM), issue("200", JIRA_PROJECT, parent = "100"),
                issue("300", JIRA_EPIC, parent = "200", team = "Platform"),
            ),
        )
        val milestone = json("""{"jiraId":"300",
"expected":{"action":"CREATE","level":"MILESTONE","parentJiraId":"200",
"parent":{"kind":"NEW_ROW"},"teamId":10}}""")
        assertApplied(case, program, project, milestone)
    }

    @Test
    fun `a milestone with no Jira team carries the default team the preview showed`() {
        val case = ImportCase(
            listOf(issue("100", JIRA_PROGRAM), issue("200", JIRA_PROJECT, parent = "100"), issue("300", JIRA_EPIC, parent = "200")),
        )
        val milestone = json("""{"jiraId":"300",
"expected":{"action":"CREATE","level":"MILESTONE","parentJiraId":"200",
"parent":{"kind":"NEW_ROW"},"teamId":10}}""")
        assertApplied(case, program, project, milestone)
    }

    @Test
    fun `a milestone created under an existing node carries that node`() {
        val case = ImportCase(
            listOf(issue("200", JIRA_PROJECT), issue("300", JIRA_EPIC, parent = "200", team = "Platform")),
            tree = stream, holders = listOf(holder("200", JiraLevel.PROJECT, 7u, "Existing project")),
        )
        val milestone = json("""{"jiraId":"300",
"expected":{"action":"CREATE","level":"MILESTONE","parentJiraId":"200",
"parent":{"kind":"EXISTING","nodeId":7},"teamId":10}}""")
        assertApplied(case, milestone)
    }

    @Test
    fun `an orphan milestone under the default project carries the default landing`() {
        val case = ImportCase(
            listOf(issue("300", JIRA_EPIC, team = "Platform")), tree = stream, defaults = JiraImportDefaults(projectId = 7u, teamId = 10u),
        )
        val milestone = json("""{"jiraId":"300",
"expected":{"action":"CREATE","level":"MILESTONE",
"parent":{"kind":"DEFAULT","nodeId":7},"teamId":10}}""")
        assertApplied(case, milestone)
    }

    @Test
    fun `a BIND carries its target node, a milestone BIND no team`() {
        val program = ImportCase(listOf(issue("100", JIRA_PROGRAM)), tree = unboundProgram)
        assertApplied(program, json("""{"jiraId":"100",
"expected":{"action":"BIND","level":"PROGRAM","nodeId":7}}"""))
        val milestone = ImportCase(
            listOf(issue("200", JIRA_PROJECT), issue("300", JIRA_EPIC, parent = "200")),
            tree = streamWithMilestone,
            holders = listOf(holder("200", JiraLevel.PROJECT, 7u, "Existing project")),
        )
        assertApplied(milestone, json("""{"jiraId":"300",
"expected":{"action":"BIND","level":"MILESTONE","parentJiraId":"200","nodeId":9}}"""))
    }

    @Test
    fun `a body with the filter member decodes through the strict deserialization, and so does one without it`() {
        val item = """{"jiraId":"100","expected":{"action":"CREATE","level":"PROGRAM"}}"""
        val withFilter = DefaultJson.decodeFromString<JiraImportApplyRequest>(
            """{"workStreamId":3,"ownerPersonId":8,"copyDates":true,""" +
                """"filter":{"excludeDone":true,"updatedWithinDays":365},"items":[$item]}""",
        )
        assertEquals(JiraImportFilter(excludeDone = true, updatedWithinDays = 365), withFilter.filter)
        val onlyDone = DefaultJson.decodeFromString<JiraImportApplyRequest>(
            """{"workStreamId":3,"ownerPersonId":8,"filter":{"excludeDone":true},"items":[$item]}""",
        )
        assertEquals(JiraImportFilter(excludeDone = true, updatedWithinDays = null), onlyDone.filter)
        val without = DefaultJson.decodeFromString<JiraImportApplyRequest>("""{"workStreamId":3,"ownerPersonId":8,"items":[$item]}""")
        assertEquals(null, without.filter)
        assertFailsWith<SerializationException>("a member the server does not know stays a 400") {
            DefaultJson.decodeFromString<JiraImportApplyRequest>(
                """{"workStreamId":3,"ownerPersonId":8,"filter":{"excludeDone":true,"statusCategory":"done"},"items":[$item]}""",
            )
        }
    }

    @Test
    fun `echoing the preview's parent verbatim is refused by the strict deserialization - the trap the web client projects around`() {
        val echo = json("""{"jiraId":"200",
"expected":{"action":"CREATE","level":"PROJECT","parentJiraId":"100",
"parent":{"kind":"NEW_ROW","nodeId":null,"nodeName":"Item 100","rowJiraId":"100"}}}""")
        val body = """{"workStreamId":3,"ownerPersonId":8,"copyDates":true,"items":[$echo]}"""
        assertFailsWith<SerializationException> { DefaultJson.decodeFromString<JiraImportApplyRequest>(body) }
    }
}
