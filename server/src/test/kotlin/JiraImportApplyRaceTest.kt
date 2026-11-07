package ch.nokillswit

import ch.nokillswit.jira.BIND_LOCK_KEY
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeout
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The apply's lock behavior, pinned with the `requestHeldAtPlanLock` barrier: a raw session holds `plan_state`, the request is started
 * and waits at it, the session changes the world and commits, and the apply must see the world as it then is. IMP-1 is bound to the
 * world's program in each, so no global "IMP Program" is created.
 */
class JiraImportApplyRaceTest {
    @Test
    fun `an owner revoked while the apply waits for the plan lock is a 403 with nothing written and no bump`() = testApplication {
        val f = importFixture("jiar1")
        f.bindImpProgram()
        val owner = f.w.programOwner
        val scope = f.scope()
        val ticks = owner.client.preview(f.connectionId, scope).previewBody().ticks()
        val before = TestPlan.revision()
        val response = requestHeldAtPlanLock({ owner.client.applyImport(f.connectionId, scope, ticks) }) { raw ->
            // The program passes to someone else: its former owner owns nothing on the chain any more.
            raw.exec("UPDATE programs SET owner_person_id = ? WHERE id = ?", f.w.stranger.personId!!.toInt(), f.w.programId.toInt())
        }
        assertEquals(HttpStatusCode.Forbidden, response.status, response.bodyAsText())
        assertEquals(before, TestPlan.revision())
        assertEquals(1, activeBindingCount(f.connectionId), "only the world's program binding")
    }

    @Test
    fun `an apply that waits behind a plan write sees its rows, and both are correct`() = testApplication {
        val f = importFixture("jiar2")
        f.bindImpProgram()
        val admin = f.w.admin.client
        val scope = f.scope()
        val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
        val before = TestPlan.revision()
        val response = requestHeldAtPlanLock({ admin.applyImport(f.connectionId, scope, ticks) }) { raw ->
            // Another plan writer's commit: a project named like IMP-2, and its bump.
            val owner = f.w.projectOwner.personId!!.toInt()
            raw.exec(
                "INSERT INTO projects (program_id, name, owner_person_id, created_at, updated_at) " +
                    "VALUES (?, 'IMP Initiative Alpha', ?, 1, 1)",
                f.w.programId.toInt(), owner,
            )
            raw.exec("UPDATE plan_state SET revision = revision + 1 WHERE id = 1")
        }
        val result = response.applyBody()
        assertEquals(before + 2, result.revision, "the other writer's bump, then the import's own")
        val skipped = result.skipped.associate { it.jiraId to it.reason }
        assertEquals(JiraImportReason.CHANGED, skipped["95002"], "the expected CREATE is now a BIND onto the new project")
        // The epics under IMP-2 were previewed under a NEW project; they would now land under the existing one: not what the client saw.
        for (id in listOf("95004", "95005")) assertEquals(JiraImportReason.CHANGED, skipped[id], id)
        val alphas = "SELECT count(*) FROM projects WHERE program_id = ? AND LOWER(name) = 'imp initiative alpha' AND NOT marked_as_deleted"
        assertEquals(1, jbScalar(alphas, f.w.programId.toInt()) { it.getInt(1) })
        assertTrue(result.created.any { it.issueKey == "IMP-3" }, "the rest was written")
    }

    @Test
    fun `a connection deleted while the apply waits is a typed 404 and leaves no binding`() = testApplication {
        val f = importFixture("jiar3")
        f.bindImpProgram()
        val admin = f.w.admin.client
        val scope = f.scope()
        val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
        val before = TestPlan.revision()
        val response = requestHeldAtPlanLock({ admin.applyImport(f.connectionId, scope, ticks) }) { raw ->
            raw.exec("UPDATE jira_connections SET marked_as_deleted = TRUE WHERE id = ?", f.connectionId.toInt())
        }
        assertEquals(HttpStatusCode.NotFound, response.status, response.bodyAsText())
        assertEquals(before, TestPlan.revision())
        val created = "SELECT count(*) FROM jira_bindings WHERE connection_id = ? AND jira_issue_key <> 'IMP-1'"
        assertEquals(0, jbScalar(created, f.connectionId.toInt()) { it.getInt(1) })
    }

    @Test
    fun `an import and a bind of one issue both finish with no cycle, and the import queued first wins`() = testApplication {
        val f = importFixture("jiar4")
        f.bindImpProgram()
        val admin = f.w.admin.client
        val scope = f.scope()
        val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
        val milestone = TestPlan.milestone(f.w.projectId, f.defaultTeam)
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.execute("SELECT pg_advisory_xact_lock($BIND_LOCK_KEY)") }
            try {
                withTimeout(60_000) {
                    coroutineScope {
                        // The import takes the plan lock, then waits for the bind lock; the bind waits for the bind lock only.
                        val import = async { admin.applyImport(f.connectionId, scope, ticks) }
                        awaitLockWait("pg_advisory_xact_lock")
                        val bind = async { admin.jbBind(f.connectionId, JiraLevel.MILESTONE, milestone, "IMP-4") }
                        awaitLockWait("pg_advisory_xact_lock", waiters = 2)
                        raw.commit()
                        val result = import.await().applyBody()
                        val bound = bind.await()
                        // The import queued for the bind lock first (advisory locks are granted in arrival order): it wins.
                        assertTrue(result.created.any { it.issueKey == "IMP-4" })
                        assertEquals(HttpStatusCode.Conflict, bound.status, "the import holds IMP-4")
                    }
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(1, jbActiveOnSite(f.site, "95004"), "one active binding of IMP-4")
    }

    @Test
    fun `an import waiting for the plan lock holds no bind lock, so a bind of another issue completes meanwhile`() = testApplication {
        val f = importFixture("jiar5")
        f.bindImpProgram()
        val admin = f.w.admin.client
        val scope = f.scope()
        val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
        val milestone = TestPlan.milestone(f.w.projectId, f.defaultTeam)
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
            try {
                coroutineScope {
                    val import = async { admin.applyImport(f.connectionId, scope, ticks) }
                    awaitLockWait("plan_state")
                    // Plan lock FIRST, bind lock second: the import waits here with nothing else held. Taken the other way round it would
                    // sit on the bind lock and this bind would queue behind it until the plan lock came free.
                    val bound = withTimeout(15_000) { admin.jbBind(f.connectionId, JiraLevel.MILESTONE, milestone, "IMP-5") }
                    assertEquals(HttpStatusCode.Created, bound.status, bound.bodyAsText())
                    assertFalse(import.isCompleted, "the import still waits for the plan lock")
                    raw.commit()
                    val result = import.await().applyBody()
                    assertEquals(JiraImportReason.ALREADY_BOUND, result.skipped.single { it.issueKey == "IMP-5" }.reason)
                }
            } finally {
                raw.rollback()
            }
        }
    }

    @Test
    fun `the dead holders to release are locked in id order before the first bind`() = testApplication {
        val f = importFixture("jiar6")
        f.bindImpProgram()
        val admin = f.w.admin.client
        val owner = f.w.projectOwner.personId!!
        // IMP-3's holder is bound FIRST (the lower binding id) but IMP-2's row is processed first: only a lock taken up front, in id order,
        // makes the lower id locked while the apply waits for the higher one.
        val deadA = TestPlan.project(f.w.programId, owner, planName("dead-a"))
        val deadB = TestPlan.project(f.w.programId, owner, planName("dead-b"))
        val low = admin.jbBind(f.connectionId, JiraLevel.PROJECT, deadA, "IMP-3").jbBinding()
        val high = admin.jbBind(f.connectionId, JiraLevel.PROJECT, deadB, "IMP-2").jbBinding()
        jbSql("UPDATE projects SET marked_as_deleted = TRUE WHERE id IN (?, ?)", low.node.id.toInt(), high.node.id.toInt())
        val scope = f.scope()
        val ticks = admin.preview(f.connectionId, scope).previewBody().ticks()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.prepareStatement("SELECT id FROM jira_bindings WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, high.id.toInt())
                st.executeQuery().close()
            }
            try {
                withTimeout(60_000) {
                    coroutineScope {
                        val import = async { admin.applyImport(f.connectionId, scope, ticks) }
                        awaitLockWait("FOR NO KEY UPDATE")
                        PostgresTestSupport.connect().use { probe ->
                            val failure = runCatching {
                                probe.prepareStatement("SELECT id FROM jira_bindings WHERE id = ? FOR UPDATE NOWAIT").use { st ->
                                    st.setInt(1, low.id.toInt())
                                    st.executeQuery().close()
                                }
                            }.exceptionOrNull()
                            val locked = failure is java.sql.SQLException && failure.sqlState == "55P03"
                            assertTrue(locked, "the lower id is already locked: $failure")
                        }
                        raw.commit()
                        val result = import.await().applyBody()
                        assertTrue(result.created.any { it.issueKey == "IMP-2" } && result.created.any { it.issueKey == "IMP-3" })
                    }
                }
            } finally {
                raw.rollback()
            }
        }
        assertFalse(jbActive(low.id) || jbActive(high.id), "both dead holders were released")
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
