package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraLevel
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A created project's target window from Jira's start and due dates (1.14) through the routes, against the stub's `IMP` and `IMC`
 * projects (both dated 2045; the projects' windows are the Jira items' own). The window rides "Copy Jira's dates"; a program owner and
 * the stream's owner get it as the administrator does (whoever may create the project is above it in the chain, so the target-window
 * guard is met); copyDates off writes none; a bound project is never touched. The pure verdicts are `JiraImportTargetWindowKernelTest`.
 */
class JiraImportTargetWindowTest {
    private fun windowOf(projectId: UInt): String? = jbScalar(
        "SELECT target_start::text || '/' || target_end::text FROM projects WHERE id = ?", projectId.toInt(),
    ) { it.getString(1) }

    private fun created(result: ch.nokillswit.jira.JiraImportResult, key: String) = result.created.single { it.issueKey == key }

    @Test
    fun `the preview shows each new project's window, and the admin's apply writes exactly those, the program and milestones untouched`() =
        testApplication {
            val f = importFixture("jitw1")
            val admin = f.w.admin.client
            try {
                val scope = f.scope(JiraImportDefaults(projectId = f.w.projectId, teamId = f.defaultTeam))
                val preview = admin.preview(f.connectionId, scope).previewBody()
                val rows = preview.items.associateBy { it.issueKey }
                assertEquals("2045-01-02" to "2045-01-20", rows.getValue("IMP-2").let { it.startDate to it.endDate })
                assertEquals("2045-01-23" to "2045-02-03", rows.getValue("IMP-3").let { it.startDate to it.endDate })
                assertTrue(rows.getValue("IMP-2").infos.isEmpty() && !rows.getValue("IMP-2").scheduled)
                val result = admin.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
                assertEquals("2045-01-02/2045-01-20", windowOf(created(result, "IMP-2").id))
                assertEquals("2045-01-23/2045-02-03", windowOf(created(result, "IMP-3").id))
                assertEquals(
                    0,
                    jbScalar("SELECT count(*) FROM projects WHERE id = ? AND target_start IS NOT NULL", f.w.projectId.toInt()) {
                        it.getInt(1)
                    },
                    "the world's own project, only a default parent, is not given a window",
                )
            } finally {
                deleteImpProgram()
            }
        }

    @Test
    fun `copyDates off shows no window and writes none`() = testApplication {
        val f = importFixture("jitw2")
        val admin = f.w.admin.client
        try {
            val scope = f.scope(JiraImportDefaults(projectId = f.w.projectId, teamId = f.defaultTeam), copyDates = false)
            val preview = admin.preview(f.connectionId, scope).previewBody()
            val projects = preview.items.filter { it.level == JiraLevel.PROJECT && it.action == JiraImportAction.CREATE }
            assertEquals(2, projects.size)
            assertTrue(projects.all { it.startDate == null && it.endDate == null && it.infos.isEmpty() })
            val result = admin.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
            for (key in listOf("IMP-2", "IMP-3")) assertNull(windowOf(created(result, key).id), key)
        } finally {
            deleteImpProgram()
        }
    }

    /**
     * [pick] chooses the non-admin caller of a world; with [bindProgram] the IMP program is bound to the world's own, so the projects
     * land under it, else the import creates the program in the same batch (guarded through the stream) and they land under that.
     */
    private suspend fun ApplicationTestBuilder.ownerApplies(mark: String, bindProgram: Boolean = true, pick: (PlanWorld) -> PlanCaller) {
        val f = importFixture(mark)
        if (bindProgram) f.bindImpProgram()
        val caller = pick(f.w)
        val scope = f.scope()
        val preview = caller.client.preview(f.connectionId, scope).previewBody()
        val projects = preview.items.filter { it.level == JiraLevel.PROJECT && it.action == JiraImportAction.CREATE }
        assertTrue(projects.isNotEmpty() && projects.all { it.startDate != null }, "the preview shows the windows")
        try {
            val result = caller.client.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
            val ids = result.created.filter { it.kind == JiraLevel.PROJECT }
            assertEquals(projects.size, ids.size)
            assertTrue(ids.all { windowOf(it.id) != null }, "the apply writes them")
            if (!bindProgram) assertEquals(2, ids.size, "both projects, whose program was created in the same batch")
        } finally {
            if (!bindProgram) deleteImpProgram()
        }
    }

    @Test
    fun `the stream's owner gets both windows when the program is created in the same batch`() =
        testApplication { ownerApplies("jitw3c", bindProgram = false) { it.streamOwner } }

    @Test
    fun `a program owner who is no admin gets the windows`() = testApplication { ownerApplies("jitw3a") { it.programOwner } }

    @Test
    fun `the stream's owner who is no admin gets the windows`() = testApplication { ownerApplies("jitw3b") { it.streamOwner } }

    @Test
    fun `a rooted import gives its new projects their windows, a project it only binds keeps the window it has`() = testApplication {
        val f = importFixture("jitw4", keys = listOf("IMC"))
        val root = f.linkProgram()
        val owner = f.w.programOwner.client
        val scope = f.scope(root = root)
        // A plan project named like IMC-2 (unbound): the import binds it, and the window the plan gave it stays.
        val own = TestPlan.project(f.w.programId, f.w.projectOwner.personId!!, "IMC Initiative North")
        jbSql("UPDATE projects SET target_start = DATE '2030-01-01', target_end = DATE '2030-01-31' WHERE id = ?", own.toInt())
        val preview = owner.preview(f.connectionId, scope).previewBody()
        val byKey = preview.items.associateBy { it.issueKey }
        assertEquals(JiraImportAction.BIND, byKey.getValue("IMC-2").action)
        assertNull(byKey.getValue("IMC-2").startDate, "a BIND shows no window: nothing will be written")
        val result = owner.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
        assertEquals("2030-01-01/2030-01-31", windowOf(own), "never overwritten")
        assertEquals("2045-01-23/2045-02-03", windowOf(created(result, "IMC-3").id))
        assertEquals("2045-02-06/2045-02-17", windowOf(created(result, "IMC-4").id))
        assertEquals(own, result.bound.single { it.issueKey == "IMC-2" }.id)
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
