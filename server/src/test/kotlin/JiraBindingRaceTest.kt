package ch.nokillswit

import ch.nokillswit.jira.BIND_LOCK_KEY
import ch.nokillswit.jira.JiraLevel
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * The bind's lock order, pinned with the `PlanStateTest` barrier: a raw JDBC session holds the lock a competing writer would hold, the
 * request is started, [awaitLockWait] says it reached its wait, the raw session changes the world and commits - and the bind must see
 * the world as it then is.
 */
class JiraBindingRaceTest {
    private suspend fun ApplicationTestBuilder.start() {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt, val site: String) {
        suspend fun milestone() = TestPlan.milestone(w.projectId, w.requireTeams().teamId)
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        start()
        val w = planWorld(prefix, teams = true)
        val request = jbRequest()
        return Fixture(w, w.admin.client.jbConnection(request).id, request.siteUrl)
    }

    @Test
    fun `a bind waits for a writer holding its node row, then completes - or is a 404 if that writer deleted the node`() = testApplication {
        val f = fixture("jbrace1")
        val admin = f.w.admin.client
        val held = f.milestone()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // What a plan write holds while it updates the node (an owner change, a rename, a soft delete).
            raw.prepareStatement("SELECT id FROM milestones WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, held.toInt())
                st.executeQuery().close()
            }
            try {
                coroutineScope {
                    val binding = async { admin.jbBind(f.connectionId, JiraLevel.MILESTONE, held, "E2E-5") }
                    awaitLockWait("FOR SHARE")
                    assertFalse(binding.isCompleted, "the bind is delayed by the node's writer")
                    raw.commit()
                    binding.await().jbBinding()
                }
            } finally {
                raw.rollback()
            }
        }
        val doomed = f.milestone()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.prepareStatement("SELECT id FROM milestones WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, doomed.toInt())
                st.executeQuery().close()
            }
            try {
                coroutineScope {
                    val binding = async { admin.jbBind(f.connectionId, JiraLevel.MILESTONE, doomed, "E2E-7") }
                    awaitLockWait("FOR SHARE")
                    raw.prepareStatement("UPDATE milestones SET marked_as_deleted = TRUE WHERE id = ?").use { st ->
                        st.setInt(1, doomed.toInt())
                        st.executeUpdate()
                    }
                    raw.commit()
                    assertEquals(HttpStatusCode.NotFound, binding.await().status, "the delete won: the node is gone")
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(0, jbScalar("SELECT count(*) FROM jira_bindings WHERE milestone_id = ?", doomed.toInt()) { it.getInt(1) })
        val observed = "SELECT count(*) FROM jira_observations o JOIN jira_bindings b ON b.id = o.binding_id WHERE b.milestone_id = ?"
        assertEquals(0, jbScalar(observed, doomed.toInt()) { it.getInt(1) })
    }

    @Test
    fun `a connection deleted while a bind waits for its row refuses the bind`() = testApplication {
        val f = fixture("jbrace2")
        val node = f.milestone()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.prepareStatement("SELECT id FROM jira_connections WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, f.connectionId.toInt())
                st.executeQuery().close()
            }
            try {
                coroutineScope {
                    val binding = async { f.w.admin.client.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5") }
                    awaitLockWait("FOR SHARE")
                    raw.prepareStatement("UPDATE jira_connections SET marked_as_deleted = TRUE WHERE id = ?").use { st ->
                        st.setInt(1, f.connectionId.toInt())
                        st.executeUpdate()
                    }
                    raw.commit()
                    assertEquals(HttpStatusCode.BadRequest, binding.await().status, "no binding is left on a deleted connection")
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(0, jbScalar("SELECT count(*) FROM jira_bindings WHERE connection_id = ?", f.connectionId.toInt()) { it.getInt(1) })
    }

    @Test
    fun `two binds of one issue through two connections of a site race - exactly one wins, the other is the 409`() = testApplication {
        val f = fixture("jbrace3")
        val admin = f.w.admin.client
        val other = admin.jbConnection(jbRequest(f.site))
        val one = f.milestone()
        val two = f.milestone()
        PostgresTestSupport.connect().use { raw ->
            // The bind lock held by a session: both requests pass every pre-check and queue on it, so the checks inside run strictly one
            // after the other - the case that, without the lock, would let both pass D1's check and both insert.
            raw.autoCommit = true
            raw.prepareStatement("SELECT pg_advisory_lock(?)").use { st ->
                st.setLong(1, BIND_LOCK_KEY)
                st.executeQuery().close()
            }
            try {
                coroutineScope {
                    val first = async { admin.jbBind(f.connectionId, JiraLevel.MILESTONE, one, "E2E-5") }
                    val second = async { admin.jbBind(other.id, JiraLevel.MILESTONE, two, "E2E-5") }
                    awaitLockWait("pg_advisory_xact_lock", waiters = 2)
                    raw.prepareStatement("SELECT pg_advisory_unlock(?)").use { st ->
                        st.setLong(1, BIND_LOCK_KEY)
                        st.executeQuery().close()
                    }
                    val statuses = listOf(first.await().status, second.await().status).sortedBy { it.value }
                    assertEquals(listOf(HttpStatusCode.Created, HttpStatusCode.Conflict), statuses)
                }
            } finally {
                raw.prepareStatement("SELECT pg_advisory_unlock_all()").use { it.executeQuery().close() }
            }
        }
        assertEquals(1, jbActiveOnSite(f.site, "90005"), "the item is linked exactly once")
        val rows = jbScalar("SELECT count(*) FROM jira_bindings WHERE milestone_id IN (?, ?)", one.toInt(), two.toInt()) { it.getInt(1) }
        assertEquals(1, rows)
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
