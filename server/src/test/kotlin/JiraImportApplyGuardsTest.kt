package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportOverrides
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Where a created row lands, who may re-import, and the per-row team override - the parts of the apply that depend on the CLIENT's
 * expectation or the caller's standing rather than on a lock.
 */
class JiraImportApplyGuardsTest {
    @Test
    fun `a row whose parent was bound elsewhere since the preview is CHANGED, never created under the default parent`() = testApplication {
        val f = importFixture("jiag1")
        val admin = f.w.admin.client
        f.bindImpProgram()
        val scope = f.scope(JiraImportDefaults(projectId = f.w.projectId, teamId = f.defaultTeam))
        val preview = admin.preview(f.connectionId, scope).previewBody()
        assertEquals(JiraImportAction.CREATE, f.rowsOf(preview).getValue("IMP-4").action)
        // IMP-2 (the epic's Jira parent) is bound to a project of ANOTHER stream meanwhile: the epic would fall to the default project.
        val elsewhere = TestPlan.project(
            TestPlan.program(TestPlan.workStream(f.w.streamOwner.personId!!), f.w.streamOwner.personId!!), f.w.projectOwner.personId!!,
        )
        admin.jbBind(f.connectionId, JiraLevel.PROJECT, elsewhere, "IMP-2").jbBinding()

        val result = admin.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
        val skipped = result.skipped.associate { it.issueKey to it.reason }
        assertEquals(JiraImportReason.ALREADY_BOUND, skipped["IMP-2"])
        for (key in listOf("IMP-4", "IMP-5")) assertEquals(JiraImportReason.CHANGED, skipped[key], key)
        val inDefault = "SELECT count(*) FROM milestones WHERE project_id = ? AND NOT marked_as_deleted"
        assertEquals(1, jbScalar(inDefault, f.w.projectId.toInt()) { it.getInt(1) }, "only IMP-8, whose landing did not change")
        assertTrue(result.created.any { it.issueKey == "IMP-8" } && result.created.any { it.issueKey == "IMP-6" })
    }

    @Test
    fun `an overrides teamId puts that milestone on that team, and a changed expected team is CHANGED`() = testApplication {
        val f = importFixture("jiag2")
        val admin = f.w.admin.client
        f.bindImpProgram()
        val other = TestTeams.seed(planName("jiag2-team"))
        val scope = f.scope()
        val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
            .map { if (it.jiraId == "95004") it.copy(overrides = JiraImportOverrides(other)) else it }
        // IMP-5 expected another team than the one the preview resolved (the Jira Team field moved since): not silently re-teamed.
        val changed = ticks.map { if (it.jiraId == "95005") it.copy(expected = it.expected.copy(teamId = other)) else it }
        val result = admin.applyImport(f.connectionId, scope, changed).applyBody()
        assertEquals(JiraImportReason.CHANGED, result.skipped.single { it.issueKey == "IMP-5" }.reason)
        val teamOf = "SELECT team_id FROM milestones WHERE id = ?"
        val one = result.created.first { it.issueKey == "IMP-4" }.id
        val two = result.created.first { it.issueKey == "IMP-7" }.id
        assertEquals(other.toInt(), jbScalar(teamOf, one.toInt()) { it.getInt(1) })
        assertEquals(f.defaultTeam.toInt(), jbScalar(teamOf, two.toInt()) { it.getInt(1) }, "the others keep the default team")
    }

    @Test
    fun `an owner of a node of the tree may re-import, and a stranger who owns nothing in it stays refused`() =
        testApplication {
            val f = importFixture("jiag3")
            val admin = f.w.admin.client
            try {
                val scope = f.scope(JiraImportDefaults(projectId = f.w.projectId, teamId = f.defaultTeam))
                val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
                assertEquals(9, admin.applyImport(f.connectionId, scope, ticks).applyBody().created.size)

                // The project owner owns the default project (a node of the tree) and no target: a re-import used to be a 403 for them.
                // (No default is named: the ownership is proven by the tree alone.)
                val owner = f.w.projectOwner.client
                val plain = f.scope()
                val shown = owner.preview(f.connectionId, plain).previewBody()
                assertEquals(9, shown.items.count { it.reason == JiraImportReason.ALREADY_BOUND })
                val rows = f.rowsOf(shown)
                // ALREADY_BOUND rows keep their text for any caller who proved ownership (bound summaries are public anyway).
                assertEquals("IMP Program", rows.getValue("IMP-1").summary)
                assertTrue(rows.getValue("IMP-8").summary.isNotBlank())
                val again = owner.applyImport(f.connectionId, plain, ticks).applyBody()
                assertTrue(again.created.isEmpty() && again.skipped.all { it.reason == JiraImportReason.ALREADY_BOUND })

                // Someone who owns something, but nothing of this tree, stays refused - for the preview and the apply.
                val stranger = f.w.stranger
                TestPlan.workStream(stranger.personId!!)
                assertEquals(HttpStatusCode.Forbidden, stranger.client.preview(f.connectionId, plain).status)
                assertEquals(HttpStatusCode.Forbidden, stranger.client.applyImport(f.connectionId, plain, ticks).status)
            } finally {
                deleteImpProgram()
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
