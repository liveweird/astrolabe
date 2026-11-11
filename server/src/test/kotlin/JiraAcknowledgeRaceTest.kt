package ch.nokillswit

import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeout
import java.sql.Connection
import org.junit.After
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The acknowledge's write transaction, with real non-admin owners (an ADMIN's guard returns early). The `JiraBindingGuardRaceTest`
 * barrier shape: a raw JDBC session holds the lock the request needs, the request is sent and passes its OUTER guard, [awaitLockWait]
 * says it reached its wait, the session changes the world and commits - and the held request must be judged against the world as it
 * then is: the guard again on the chain re-read, the fingerprint against deviations recomputed inside the write's own transaction.
 */
class JiraAcknowledgeRaceTest {
    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    private class Fixture(val w: PlanWorld, val connectionId: UInt) {
        val owner: PlanCaller get() = w.projectOwner
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        return Fixture(w, ledger.track(w.admin.client.dvConnection()))
    }

    private suspend fun Fixture.projectBinding() = deviatingBinding(connectionId, JiraLevel.PROJECT, w.projectId)

    /**
     * Holds [lockSql] (one int parameter) on a raw session, runs [request], waits for a session blocked in a statement containing
     * [waitsAt], [change]s the world and commits.
     */
    private suspend fun heldAt(
        lockSql: String,
        id: UInt,
        waitsAt: String,
        request: suspend () -> HttpResponse,
        change: (Connection) -> Unit,
    ): HttpResponse {
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

    private val bindingLock = "SELECT id FROM jira_bindings WHERE id = ? FOR NO KEY UPDATE"

    @Test
    fun `an owner who loses the node while the acknowledge waits for the row is refused 403 and nothing is stored`() = testApplication {
        val f = fixture("ackr1")
        val binding = f.projectBinding()
        val fingerprint = f.w.admin.client.ackItem(f.connectionId, binding).fingerprint
        withAuditCapture { audit ->
            val response = heldAt(
                bindingLock, binding, "FOR NO KEY UPDATE",
                { f.owner.client.ack(binding, fingerprint) },
            ) { it.exec("UPDATE projects SET owner_person_id = ? WHERE id = ?", f.w.stranger.personId!!.toInt(), f.w.projectId.toInt()) }
            assertEquals(HttpStatusCode.Forbidden, response.status, "the guard ran again on the chain re-read under the lock")
            assertNull(f.w.admin.client.ackItem(f.connectionId, binding).acknowledgement)
            assertTrue(audit.events.none { it.message == "jira.deviation_acknowledged" && it.hasKeyValue("bindingId", binding.toLong()) })
        }
    }

    @Test
    fun `an owner whose person is re-linked while the acknowledge waits at the guard's person lock is refused 403`() = testApplication {
        val f = fixture("ackr2")
        val binding = f.projectBinding()
        val fingerprint = f.w.admin.client.ackItem(f.connectionId, binding).fingerprint
        val response = heldAt(
            "SELECT id FROM people WHERE id = ? FOR NO KEY UPDATE", f.owner.personId!!, "FOR SHARE",
            { f.owner.client.ack(binding, fingerprint) },
        ) { it.exec("UPDATE people SET user_id = NULL WHERE id = ?", f.owner.personId!!.toInt()) }
        assertEquals(HttpStatusCode.Forbidden, response.status, "the person is resolved under a lock, fresh, inside the transaction")
        assertNull(f.w.admin.client.ackItem(f.connectionId, binding).acknowledgement)
    }

    @Test
    fun `a stream owner demoted by an ancestor change while a milestone acknowledge waits is refused 403`() = testApplication {
        val f = fixture("ackr3")
        val milestone = TestPlan.milestone(f.w.projectId, f.w.requireTeams().teamId)
        val binding = deviatingBinding(f.connectionId, JiraLevel.MILESTONE, milestone)
        val fingerprint = f.w.admin.client.ackItem(f.connectionId, binding).fingerprint
        val response = heldAt(
            bindingLock, binding, "FOR NO KEY UPDATE",
            { f.w.streamOwner.client.ack(binding, fingerprint) },
        ) { it.exec("UPDATE work_streams SET owner_person_id = ? WHERE id = ?", f.w.stranger.personId!!.toInt(), f.w.streamId.toInt()) }
        assertEquals(HttpStatusCode.Forbidden, response.status, "an ancestor's owner change is seen by the chain re-read")
        assertNull(f.w.admin.client.ackItem(f.connectionId, binding).acknowledgement)
    }

    @Test
    fun `the fingerprint is compared against deviations recomputed inside the write - a change committed while it waits is 409`() =
        testApplication {
            val f = fixture("ackr4")
            val binding = f.projectBinding()
            val seen = f.w.admin.client.ackItem(f.connectionId, binding)
            val response = heldAt(
                bindingLock, binding, "FOR NO KEY UPDATE",
                { f.owner.client.ack(binding, seen.fingerprint) },
            ) { it.exec("UPDATE jira_observations SET summary = 'renamed while the request waited' WHERE binding_id = ?", binding.toInt()) }
            assertEquals(HttpStatusCode.Conflict, response.status)
            assertEquals(STALE_DEVIATIONS_PROBLEM, response.jbProblem().type)
            assertNull(f.w.admin.client.ackItem(f.connectionId, binding).acknowledgement, "nothing was stored against the old reading")
            val now = f.w.admin.client.ackItem(f.connectionId, binding)
            assertFalse(now.fingerprint == seen.fingerprint, "the world did change")
        }

    @Test
    fun `a binding unbound while the acknowledge waits for its row is 404, not a write`() = testApplication {
        val f = fixture("ackr5")
        val binding = f.projectBinding()
        val fingerprint = f.w.admin.client.ackItem(f.connectionId, binding).fingerprint
        val response = heldAt(
            bindingLock, binding, "FOR NO KEY UPDATE",
            { f.owner.client.ack(binding, fingerprint) },
        ) { it.exec("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE id = ?", binding.toInt()) }
        assertEquals(HttpStatusCode.NotFound, response.status, "the row is re-read active under the lock")
        assertEquals(false, jbActive(binding))
        val sql = "SELECT count(*) FROM jira_deviation_acknowledgements WHERE binding_id = ?"
        val stored = jbScalar(sql, binding.toInt()) { it.getLong(1) }
        assertEquals(0L, stored)
    }

    @Test
    fun `an owner who loses the node while the withdrawal waits is refused 403 and the acknowledgement stays`() = testApplication {
        val f = fixture("ackr6")
        val binding = f.projectBinding()
        f.w.admin.client.ack(binding, f.w.admin.client.ackItem(f.connectionId, binding).fingerprint).acknowledgement()
        val response = heldAt(
            bindingLock, binding, "FOR NO KEY UPDATE",
            { f.owner.client.unack(binding) },
        ) { it.exec("UPDATE projects SET owner_person_id = ? WHERE id = ?", f.w.stranger.personId!!.toInt(), f.w.projectId.toInt()) }
        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertNotNull(f.w.admin.client.ackItem(f.connectionId, binding).acknowledgement, "still acknowledged")
    }

    private suspend fun Fixture.managedMilestoneBinding(): UInt = deviatingBinding(connectionId, JiraLevel.MILESTONE, managedMilestone())

    private suspend fun Fixture.managedMilestone(): UInt = TestPlan.milestone(w.projectId, w.requireTeams().teamId)

    private fun Fixture.setManager(teamId: UInt, personId: UInt?): (Connection) -> Unit = {
        it.exec("UPDATE teams SET manager_person_id = ? WHERE id = ?", personId!!.toInt(), teamId.toInt())
    }

    @Test
    fun `a team manager replaced while the milestone acknowledge waits for the row is refused 403, nothing stored`() =
        testApplication {
            val f = fixture("ackr8")
            val teams = f.w.requireTeams()
            val binding = f.managedMilestoneBinding()
            val fingerprint = f.w.admin.client.ackItem(f.connectionId, binding).fingerprint
            withAuditCapture { audit ->
                val response = heldAt(
                    bindingLock, binding, "FOR NO KEY UPDATE",
                    { teams.manager.client.ack(binding, fingerprint) },
                    f.setManager(teams.teamId, teams.otherManager.personId),
                )
                assertEquals(HttpStatusCode.Forbidden, response.status, "the manager guard ran again under the binding's row lock")
                assertNull(f.w.admin.client.ackItem(f.connectionId, binding).acknowledgement)
                val written = audit.events.filter { it.message == "jira.deviation_acknowledged" }
                assertTrue(written.none { it.hasKeyValue("bindingId", binding.toLong()) })
                val denied = assertNotNull(
                    audit.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("path", ackUrl(binding)) },
                    "a refusal under the lock is the central authz.denied too",
                )
                assertTrue(denied.hasKeyValue("method", "POST") && denied.hasKeyValue("byUserId", teams.manager.userId.toLong()))
            }
        }

    @Test
    fun `a team manager replaced while the withdrawal waits at the team lock is refused 403 and the acknowledgement stays`() =
        testApplication {
            val f = fixture("ackr9")
            val teams = f.w.requireTeams()
            val binding = f.managedMilestoneBinding()
            f.w.admin.client.ack(binding, f.w.admin.client.ackItem(f.connectionId, binding).fingerprint).acknowledgement()
            val response = heldAt(
                "SELECT id FROM teams WHERE id = ? FOR NO KEY UPDATE", teams.teamId, "FOR SHARE",
                { teams.manager.client.unack(binding) },
                f.setManager(teams.teamId, teams.otherManager.personId),
            )
            assertEquals(HttpStatusCode.Forbidden, response.status, "the team and its manager are read FOR SHARE, fresh")
            assertNotNull(f.w.admin.client.ackItem(f.connectionId, binding).acknowledgement, "still acknowledged")
        }

    @Test
    fun `a milestone moved to another team while the acknowledge waits is judged on the team it has now`() = testApplication {
        val f = fixture("ackr10")
        val teams = f.w.requireTeams()
        val milestone = f.managedMilestone()
        val binding = deviatingBinding(f.connectionId, JiraLevel.MILESTONE, milestone)
        val fingerprint = f.w.admin.client.ackItem(f.connectionId, binding).fingerprint
        val response = heldAt(
            bindingLock, binding, "FOR NO KEY UPDATE",
            { teams.manager.client.ack(binding, fingerprint) },
        ) { it.exec("UPDATE milestones SET team_id = ? WHERE id = ?", teams.otherTeamId.toInt(), milestone.toInt()) }
        assertEquals(HttpStatusCode.Forbidden, response.status, "the old team's manager no longer manages the milestone's team")
        assertNull(f.w.admin.client.ackItem(f.connectionId, binding).acknowledgement)
        assertEquals(HttpStatusCode.OK, teams.otherManager.client.ack(binding, fingerprint).status, "the new team's manager is")
    }

    @Test
    fun `an acknowledgement takes no plan lock - it completes while another session holds plan_state`() = testApplication {
        val f = fixture("ackr7")
        val binding = f.projectBinding()
        val fingerprint = f.w.admin.client.ackItem(f.connectionId, binding).fingerprint
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
            try {
                val response = withTimeout(30_000) { f.owner.client.ack(binding, fingerprint) }
                assertEquals(HttpStatusCode.OK, response.status, "not blocked behind the plan lock")
                assertEquals(HttpStatusCode.NoContent, withTimeout(30_000) { f.owner.client.unack(binding) }.status)
            } finally {
                raw.rollback()
            }
        }
    }

    @Test
    fun `a line withdrawal waiting for the row lock is decided against the rows as they are then - 404 when another session removed it`() =
        testApplication {
            val f = fixture("ackr11")
            val binding = f.projectBinding()
            f.w.admin.client.ack(binding, f.w.admin.client.ackItem(f.connectionId, binding).fingerprint).acknowledgement()
            val kind = f.w.admin.client.ackItem(f.connectionId, binding).deviations.first().kind
            val response = heldAt(
                bindingLock, binding, "FOR NO KEY UPDATE",
                { f.owner.client.unack(binding, kind) },
            ) { it.exec("DELETE FROM jira_deviation_acknowledgements WHERE binding_id = ?", binding.toInt()) }
            assertEquals(HttpStatusCode.NotFound, response.status, "nothing stored any more, seen under the lock")
            assertTrue(storedAcks(binding).isEmpty())
        }

    @Test
    fun `a line acknowledge waiting for the row lock rewrites the row another session stored meanwhile - one row, no unique violation`() =
        testApplication {
            val f = fixture("ackr12")
            val binding = f.projectBinding()
            val item = f.w.admin.client.ackItem(f.connectionId, binding)
            val kind = item.deviations.first().kind
            val insert = "INSERT INTO jira_deviation_acknowledgements (binding_id, kind, fingerprint, ack_at, ack_by_user_id) " +
                "VALUES (?, '${kind.name}', repeat('a', 64), 5, ?)"
            val response = heldAt(
                bindingLock, binding, "FOR NO KEY UPDATE",
                { f.owner.client.ack(binding, item.fingerprint, kind) },
            ) { it.exec(insert, binding.toInt(), f.w.admin.userId.toInt()) }
            assertEquals(HttpStatusCode.OK, response.status, "delete-then-insert under the lock: the backstop index is never hit")
            val stored = storedAcks(binding).getValue(kind.name)
            assertEquals(f.owner.userId.toLong(), stored.byUserId, "the waiting write is the last word")
            assertEquals(1, storedAcks(binding).size)
        }
}
