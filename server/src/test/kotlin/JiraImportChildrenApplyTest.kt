package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The rooted apply (1.14) against the stub's `IMC` project: the program's owner writes the root's descendants under the root's own node
 * in ONE plan write (no program is created), a re-import is all `ALREADY_BOUND`, an id outside the root's subtree is `CHANGED` with no
 * key, a root unlinked or an owner revoked while the request waits for the plan lock leaves nothing written, and a project root creates
 * its milestones unscheduled for a caller who manages no team. No global program name is created, so nothing is cleaned up.
 */
class JiraImportChildrenApplyTest {
    private fun count(sql: String, vararg params: Any) = jbScalar(sql, *params) { it.getInt(1) }

    @Test
    fun `the program's owner writes the projects and milestones under the root in one bump, and a re-import is all ALREADY_BOUND`() =
        testApplication {
            val f = importFixture("jca1", keys = listOf("IMC"))
            val root = f.linkProgram()
            val owner = f.w.programOwner.client
            val scope = f.scope(root = root)
            val ticks = owner.preview(f.connectionId, scope).previewBody().ticks() +
                createTick(imcId(12), JiraLevel.PROJECT, imcId(11)) // another program's project: outside the root's subtree
            val before = TestPlan.revision()
            withAuditCapture { audit ->
                val result = owner.applyImport(f.connectionId, scope, ticks).applyBody()
                assertEquals(before + 1, result.revision, "ONE bump")
                assertEquals(mapOf(JiraLevel.PROJECT to 3, JiraLevel.MILESTONE to 5), result.created.groupingBy { it.kind }.eachCount())
                val skipped = result.skipped.single()
                assertEquals(listOf(imcId(12), null, JiraImportReason.CHANGED), listOf(skipped.jiraId, skipped.issueKey, skipped.reason))
                assertTrue(result.created.none { it.kind == JiraLevel.PROGRAM }, "a rooted import never creates a program")
                val event = assertNotNull(audit.awaitEvent { it.message == "jira.import_applied" })
                assertTrue(event.hasKeyValue("rootLevel", "PROGRAM"))
                assertTrue(event.hasKeyValue("rootNodeId", f.w.programId.toLong()))
            }
            val projects = count("SELECT count(*) FROM projects WHERE program_id = ? AND NOT marked_as_deleted", f.w.programId.toInt())
            assertEquals(4, projects, "the world's project and the three new ones")
            val milestones = "SELECT count(*) FROM milestones m JOIN projects p ON p.id = m.project_id " +
                "WHERE p.program_id = ? AND NOT m.marked_as_deleted AND p.id <> ?"
            assertEquals(5, count(milestones, f.w.programId.toInt(), f.w.projectId.toInt()))
            assertEquals(9, activeBindingCount(f.connectionId), "the root's link and the eight new ones")
            val observations = "SELECT count(*) FROM jira_observations o JOIN jira_bindings b ON b.id = o.binding_id " +
                "WHERE b.connection_id = ?"
            assertEquals(9, count(observations, f.connectionId.toInt()), "a first observation each")
            val outside = "SELECT count(*) FROM jira_bindings WHERE connection_id = ? AND jira_issue_id = ?"
            assertEquals(0, count(outside, f.connectionId.toInt(), imcId(12)))

            val again = owner.preview(f.connectionId, scope).previewBody()
            val reasons = again.items.associate { it.key() to it.reason }
            val bound = (2..8).map { "IMC-$it" } + "IMC-10"
            assertTrue(bound.all { reasons[it] == JiraImportReason.ALREADY_BOUND }, reasons.toString())
            assertEquals(JiraImportReason.NO_PARENT, reasons["IMC-9"])
            assertTrue(again.items.none { it.action != JiraImportAction.SKIP })
            // A stale client ticks them as CREATEs: each is the kernel's ALREADY_BOUND skip.
            val linked = again.items.filter { it.reason == JiraImportReason.ALREADY_BOUND }
            val stale = linked.map { createTick(it.jiraId, it.level, it.parentJiraId) }
            val none = owner.applyImport(f.connectionId, scope, stale).applyBody()
            assertTrue(none.created.isEmpty() && none.bound.isEmpty())
            assertEquals(8, none.skipped.count { it.reason == JiraImportReason.ALREADY_BOUND })
            assertEquals(9, activeBindingCount(f.connectionId), "nothing written")
        }

    @Test
    fun `a root unlinked before the apply is the 409, and nothing is written`() = testApplication {
        val f = importFixture("jca2", keys = listOf("IMC"))
        val root = f.linkProgram()
        val admin = f.w.admin.client
        val scope = f.scope(root = root)
        val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
        jbSql("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE connection_id = ?", f.connectionId.toInt())
        val before = TestPlan.revision()
        val response = admin.applyImport(f.connectionId, scope, ticks)
        assertEquals(HttpStatusCode.Conflict, response.status, response.bodyAsText())
        assertEquals("urn:astrolabe:problem:jira-root-unusable", response.jbProblem().type)
        assertEquals(before, TestPlan.revision())
    }

    @Test
    fun `a root unlinked while the apply waits for the plan lock is the 409 from under the lock, with nothing written and no bump`() =
        testApplication {
            val f = importFixture("jca3", keys = listOf("IMC"))
            val root = f.linkProgram()
            val admin = f.w.admin.client
            val scope = f.scope(root = root)
            val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
            val before = TestPlan.revision()
            val response = requestHeldAtPlanLock({ admin.applyImport(f.connectionId, scope, ticks) }) { raw ->
                raw.exec("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE connection_id = ?", f.connectionId.toInt())
            }
            assertEquals(HttpStatusCode.Conflict, response.status, response.bodyAsText())
            assertEquals("urn:astrolabe:problem:jira-root-unusable", response.jbProblem().type)
            assertEquals(before, TestPlan.revision(), "no bump")
            val links = count("SELECT count(*) FROM jira_bindings WHERE connection_id = ?", f.connectionId.toInt())
            assertEquals(1, links, "only the root's old link")
            assertEquals(1, count("SELECT count(*) FROM projects WHERE program_id = ? AND NOT marked_as_deleted", f.w.programId.toInt()))
        }

    @Test
    fun `an owner revoked while the rooted apply waits for the plan lock is a 403 with nothing written and no bump`() = testApplication {
        val f = importFixture("jca4", keys = listOf("IMC"))
        val root = f.linkProgram()
        val owner = f.w.programOwner
        val scope = f.scope(root = root)
        val ticks = owner.client.preview(f.connectionId, scope).previewBody().ticks()
        val before = TestPlan.revision()
        val response = requestHeldAtPlanLock({ owner.client.applyImport(f.connectionId, scope, ticks) }) { raw ->
            raw.exec("UPDATE programs SET owner_person_id = ? WHERE id = ?", f.w.stranger.personId!!.toInt(), f.w.programId.toInt())
        }
        assertEquals(HttpStatusCode.Forbidden, response.status, response.bodyAsText())
        assertEquals(before, TestPlan.revision())
        assertEquals(1, activeBindingCount(f.connectionId), "only the root's link")
    }

    @Test
    fun `a project root creates its milestones unscheduled where the caller manages no team, under the project`() = testApplication {
        val f = importFixture("jca5", keys = listOf("IMC"))
        val root = f.linkProject()
        val owner = f.w.projectOwner.client
        val scope = f.scope(root = root)
        val preview = owner.preview(f.connectionId, scope).previewBody()
        assertEquals(listOf("IMC-5", "IMC-6", "IMC-10"), preview.items.map { it.key() })
        val result = owner.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
        assertEquals(3, result.created.size)
        assertTrue(result.created.all { it.kind == JiraLevel.MILESTONE && !it.scheduled })
        val dated = "SELECT count(*) FROM milestones WHERE project_id = ? AND NOT marked_as_deleted AND start_date IS NOT NULL"
        assertEquals(0, count(dated, f.w.projectId.toInt()))
        val under = "SELECT count(*) FROM milestones WHERE project_id = ? AND NOT marked_as_deleted"
        assertEquals(3, count(under, f.w.projectId.toInt()))
        assertNull(result.skipped.firstOrNull())
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
