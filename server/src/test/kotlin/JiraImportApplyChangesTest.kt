package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportApplyItem
import ch.nokillswit.jira.JiraImportExpected
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * What an apply makes of a client's ticks once the rows are recomputed under the lock: an expectation that no longer holds is `CHANGED`,
 * a child of a row left out is `PARENT_SKIPPED`, an item the site no longer holds is `CHANGED` without a key, and a holder whose node is
 * gone is released and audited. IMP-1 is bound to the world's own program in each, so no global "IMP Program" is created.
 */
class JiraImportApplyChangesTest {
    @Test
    fun `a changed expectation, a vanished item and a parent the client left out are skipped, and the revision still moves once`() =
        testApplication {
            val f = importFixture("jiac1")
            val admin = f.w.admin.client
            f.bindImpProgram()
            val scope = f.scope()
            val preview = admin.preview(f.connectionId, scope).previewBody()
            val tampered = preview.ticks("IMP-2").map {
                // IMP-3 expects a BIND to a node: the recomputed row is a CREATE.
                val bind = JiraImportExpected(JiraImportAction.BIND, JiraLevel.PROJECT, "95001", 1u)
                if (it.jiraId == "95003") JiraImportApplyItem(it.jiraId, bind) else it
            } + createTick("99999", JiraLevel.MILESTONE)
            val before = TestPlan.revision()
            val nodes = jbScalar("SELECT (SELECT count(*) FROM projects) + (SELECT count(*) FROM milestones)") { it.getInt(1) }

            val result = admin.applyImport(f.connectionId, scope, tampered).applyBody()
            assertEquals(before + 1, result.revision)
            assertTrue(result.created.isEmpty() && result.bound.isEmpty())
            val skipped = result.skipped.associateBy { it.jiraId }
            assertEquals(JiraImportReason.CHANGED, skipped.getValue("95003").reason)
            assertEquals(JiraImportReason.CHANGED, skipped.getValue("99999").reason)
            assertEquals(null, skipped.getValue("99999").issueKey, "the re-browse no longer finds it")
            // IMP-6/7/9 sit under the changed IMP-3, IMP-4/5 under IMP-2, which the client left out.
            for (id in listOf("95004", "95005", "95006", "95007", "95009")) {
                assertEquals(JiraImportReason.PARENT_SKIPPED, skipped.getValue(id).reason, id)
            }
            assertEquals(nodes, jbScalar("SELECT (SELECT count(*) FROM projects) + (SELECT count(*) FROM milestones)") { it.getInt(1) })
            assertEquals(1, activeBindingCount(f.connectionId), "only the world's program stays bound")
        }

    @Test
    fun `a holder whose node is gone is released and audited, and its issue is bound to the new node`() = testApplication {
        val f = importFixture("jiac2")
        val admin = f.w.admin.client
        f.bindImpProgram()
        val dead = TestPlan.project(f.w.programId, f.w.projectOwner.personId!!, planName("dead"))
        val old = admin.jbBind(f.connectionId, JiraLevel.PROJECT, dead, "IMP-3").jbBinding()
        jbSql("UPDATE projects SET marked_as_deleted = TRUE WHERE id = ?", dead.toInt())
        val scope = f.scope()
        val preview = admin.preview(f.connectionId, scope).previewBody()
        assertEquals(JiraImportAction.CREATE, f.rowsOf(preview).getValue("IMP-3").action, "a dead holder never blocks")

        withAuditCapture { audit ->
            val result = admin.applyImport(f.connectionId, scope, preview.ticks()).applyBody()
            val fresh = result.created.first { it.issueKey == "IMP-3" }
            assertFalse(jbActive(old.id), "the dead node's binding was released")
            assertEquals(1, jbActiveOnSite(f.site, "95003"))
            assertTrue(jbActive(fresh.bindingId))
            val released = assertNotNull(audit.awaitEvent { it.message == "jira.binding_released" })
            val fields = listOf(
                "bindingId" to old.id.toLong(), "connectionId" to f.connectionId.toLong(), "nodeId" to dead.toLong(),
                "reason" to "NODE_GONE",
            )
            fields.forEach { (key, value) -> assertTrue(released.hasKeyValue(key, value), key) }
            assertTrue(released.hasKeyValue("level", "PROJECT") && released.hasKeyValue("issueKey", "IMP-3"))
            assertEquals(1, audit.events.count { it.message == "jira.binding_released" })
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
