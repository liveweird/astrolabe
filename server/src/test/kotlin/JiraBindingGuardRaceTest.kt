package ch.nokillswit

import ch.nokillswit.jira.JiraLevel
import io.ktor.client.request.delete
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import org.junit.BeforeClass
import java.sql.Connection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The guard's SECOND run and the row locks, with a real non-admin owner (an ADMIN's guard returns early, so `JiraBindingRaceTest`'s
 * ADMIN callers could not catch a missing guard). The `PlanStateTest` barrier shape: a raw JDBC session holds the lock a competing
 * writer would hold, the request is sent and passes its outer guard, [awaitLockWait] says it reached its wait, the session changes the
 * world and commits - and the held request must be judged against the world as it then is.
 */
class JiraBindingGuardRaceTest {
    private suspend fun ApplicationTestBuilder.start() {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt, val request: ch.nokillswit.jira.JiraConnectionRequest) {
        suspend fun milestone() = TestPlan.milestone(w.projectId, w.requireTeams().teamId)
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        start()
        val w = planWorld(prefix, teams = true)
        val request = jbRequest()
        return Fixture(w, w.admin.client.jbConnection(request).id, request)
    }

    /**
 * Holds [lockSql] (a `SELECT ... FOR ...` with one int parameter) on a raw session, runs [request], waits until some session is blocked
 * in a statement containing [waitsAt], then [change]s the world and commits.
 */
    private suspend fun <T> heldAt(
        lockSql: String,
        id: UInt,
        waitsAt: String,
        request: suspend () -> T,
        change: (Connection) -> Unit,
    ): T {
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.prepareStatement(lockSql).use { st ->
                st.setInt(1, id.toInt())
                st.executeQuery().close()
            }
            try {
                return coroutineScope {
                    val pending = async { request() }
                    awaitLockWait(waitsAt)
                    assertFalse(pending.isCompleted, "the request is held at the lock")
                    change(raw)
                    raw.commit()
                    pending.await()
                }
            } finally {
                raw.rollback()
            }
        }
    }

    private fun bindingRows(projectId: UInt) =
        jbScalar("SELECT count(*) FROM jira_bindings WHERE project_id = ?", projectId.toInt()) { it.getInt(1) }

    // --- the bind ---------------------------------------------------------------------------------------------------------------------

    @Test
    fun `an owner who loses the node while the bind waits for its row is refused 403 - the guard runs again on the re-read chain`() =
        testApplication {
            val f = fixture("jbgr1")
            val w = f.w
            withAuditCapture { audit ->
                val response = heldAt(
                    "SELECT id FROM projects WHERE id = ? FOR NO KEY UPDATE", w.projectId,
                    "FOR SHARE",
                    { w.projectOwner.client.jbBind(f.connectionId, JiraLevel.PROJECT, w.projectId, "E2E-2") },
                ) { it.exec("UPDATE projects SET owner_person_id = ? WHERE id = ?", w.stranger.personId!!.toInt(), w.projectId.toInt()) }
                assertEquals(HttpStatusCode.Forbidden, response.status)
                assertEquals(0, bindingRows(w.projectId), "nothing was bound")
                assertTrue(audit.events.none { it.message == "jira.binding_created" && it.hasKeyValue("nodeId", w.projectId.toLong()) })
            }
        }

    @Test
    fun `an owner whose person is re-linked while the bind waits at the guard's person lock is refused 403`() = testApplication {
        val f = fixture("jbgr2")
        val w = f.w
        val response = heldAt(
            "SELECT id FROM people WHERE id = ? FOR NO KEY UPDATE", w.projectOwner.personId!!,
            "FOR SHARE",
            { w.projectOwner.client.jbBind(f.connectionId, JiraLevel.PROJECT, w.projectId, "E2E-2") },
        ) { it.exec("UPDATE people SET user_id = NULL WHERE id = ?", w.projectOwner.personId.toInt()) }
        assertEquals(HttpStatusCode.Forbidden, response.status, "the person is resolved under a lock, fresh, inside the transaction")
        assertEquals(0, bindingRows(w.projectId))
    }

    @Test
    fun `a stream owner demoted by an ancestor change while a milestone bind waits is refused 403`() = testApplication {
        val f = fixture("jbgr3")
        val w = f.w
        val milestone = f.milestone()
        val response = heldAt(
            "SELECT id FROM milestones WHERE id = ? FOR NO KEY UPDATE", milestone,
            "FOR SHARE",
            { w.streamOwner.client.jbBind(f.connectionId, JiraLevel.MILESTONE, milestone, "E2E-4") },
        ) { it.exec("UPDATE work_streams SET owner_person_id = ? WHERE id = ?", w.stranger.personId!!.toInt(), w.streamId.toInt()) }
        assertEquals(HttpStatusCode.Forbidden, response.status, "an ancestor's owner change is seen by the chain re-read")
        assertEquals(0, jbScalar("SELECT count(*) FROM jira_bindings WHERE milestone_id = ?", milestone.toInt()) { it.getInt(1) })
    }

    // --- the unbind --------------------------------------------------------------------------------------------------------------------

    @Test
    fun `an owner who loses the node while the unbind waits for the binding row is refused 403 and the binding stays`() = testApplication {
        val f = fixture("jbgr4")
        val w = f.w
        val binding = w.admin.client.jbBind(f.connectionId, JiraLevel.PROJECT, w.projectId, "E2E-2").jbBinding()
        val response = heldAt(
            "SELECT id FROM jira_bindings WHERE id = ? FOR NO KEY UPDATE", binding.id,
            "FOR NO KEY UPDATE",
            { w.projectOwner.client.delete("$JB_BINDINGS/${binding.id}") },
        ) { it.exec("UPDATE projects SET owner_person_id = ? WHERE id = ?", w.stranger.personId!!.toInt(), w.projectId.toInt()) }
        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertTrue(jbActive(binding.id), "the guard ran against the chain re-read in the transaction")
    }

    @Test
    fun `an owner whose person is re-linked while the unbind waits at the guard's person lock is refused 403`() = testApplication {
        val f = fixture("jbgr5")
        val w = f.w
        val binding = w.admin.client.jbBind(f.connectionId, JiraLevel.PROJECT, w.projectId, "E2E-2").jbBinding()
        val response = heldAt(
            "SELECT id FROM people WHERE id = ? FOR NO KEY UPDATE", w.projectOwner.personId!!,
            "FOR SHARE",
            { w.projectOwner.client.delete("$JB_BINDINGS/${binding.id}") },
        ) { it.exec("UPDATE people SET user_id = NULL WHERE id = ?", w.projectOwner.personId.toInt()) }
        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertTrue(jbActive(binding.id))
    }

    @Test
    fun `an unbind that waits for the binding row while another unbind commits is a 404 and audits nothing`() = testApplication {
        val f = fixture("jbgr6")
        val w = f.w
        val binding = w.admin.client.jbBind(f.connectionId, JiraLevel.PROJECT, w.projectId, "E2E-2").jbBinding()
        withAuditCapture { audit ->
            val response = heldAt(
                "SELECT id FROM jira_bindings WHERE id = ? FOR NO KEY UPDATE", binding.id,
                "FOR NO KEY UPDATE",
                { w.projectOwner.client.delete("$JB_BINDINGS/${binding.id}") },
            ) { it.exec("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE id = ?", binding.id.toInt()) }
            assertEquals(HttpStatusCode.NotFound, response.status, "the row is re-read active under the lock")
            assertTrue(audit.events.none { it.message == "jira.binding_deleted" && it.hasKeyValue("bindingId", binding.id.toLong()) })
        }
    }

    // --- the scope under the lock --------------------------------------------------------------------------------------------------

    @Test
    fun `a projectKeys change committed while the bind waits for the connection row refuses the out-of-scope binding`() = testApplication {
        val f = fixture("jbgr7")
        val node = f.milestone()
        val response = heldAt(
            "SELECT id FROM jira_connections WHERE id = ? FOR NO KEY UPDATE", f.connectionId,
            "FOR SHARE",
            { f.w.admin.client.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5") },
        ) { it.exec("UPDATE jira_connections SET project_keys = '[\"CE\"]'::jsonb WHERE id = ?", f.connectionId.toInt()) }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue("outside the connection's project keys" in response.jbProblem().detail.orEmpty())
        assertEquals(0, jbScalar("SELECT count(*) FROM jira_bindings WHERE milestone_id = ?", node.toInt()) { it.getInt(1) })
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
