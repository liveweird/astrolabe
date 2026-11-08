package ch.nokillswit

import ch.nokillswit.flow.FLOW_BIND_LOCK_KEY
import io.ktor.client.request.delete
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import java.sql.Connection
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The second run of the guard and the row locks of the team bindings, with a real non-admin manager (an ADMIN's guard returns early). The
 * `JiraBindingGuardRaceTest` barrier shape: a raw JDBC session holds the lock a competing writer would hold, the request is sent and passes
 * its outer checks, [awaitLockWait] says it reached its wait, the session changes the world and commits - and the held request must be
 * judged against the world as it then is. Case (d) holds the global bind lock itself, so two links queue on it deterministically.
 */
class FlowBindingGuardRaceTest {
    private companion object {
        const val PREFIX = "flowrace"
    }

    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
    }

    private suspend fun mirror(vararg names: Pair<Int, String>) =
        ScriptedFlowMirror(PREFIX).connect().refresh(*names.map { (id, name) -> flowTeamJson(id, name) }.toTypedArray())

    /**
     * Holds [lockSql] (a `SELECT ... FOR ...` with one int parameter) on a raw session, runs [request], waits until some session is blocked
     * in a statement containing [waitsAt], then [change]s the world and commits.
     */
    private suspend fun <T> heldAt(lockSql: String, id: UInt, waitsAt: String, request: suspend () -> T, change: (Connection) -> Unit): T {
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

    @Test
    fun `a manager whose login link is cleared while the link waits at the guard's person lock is refused 403 and nothing is written`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("fbgr1", teams = true)
            val teams = w.requireTeams()
            val m = mirror(1 to planName("fb-a"))
            withAuditCapture { audit ->
                val response = heldAt(
                    "SELECT id FROM people WHERE id = ? FOR NO KEY UPDATE", teams.manager.personId!!, "people",
                    { teams.manager.client.fbBind(m.connectionId, 1, teams.teamId) },
                ) { it.exec("UPDATE people SET user_id = NULL WHERE id = ?", teams.manager.personId.toInt()) }
                assertEquals(HttpStatusCode.Forbidden, response.status, "the manager is resolved under a lock, fresh, in the transaction")
                assertEquals(0, fbActiveCount(m.connectionId), "nothing was written")
                assertTrue(audit.events.none { it.message == "flow.team_bound" })
            }
        }

    @Test
    fun `a team deleted between the route's check and the transaction is a 404`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbgr2", teams = true)
        val teams = w.requireTeams()
        val m = mirror(1 to planName("fb-a"))
        val response = heldAt(
            "SELECT id FROM teams WHERE id = ? FOR NO KEY UPDATE", teams.teamId, "teams",
            { w.admin.client.fbBind(m.connectionId, 1, teams.teamId) },
        ) { it.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", teams.teamId.toInt()) }
        assertEquals(HttpStatusCode.NotFound, response.status, "the team row is locked and re-read active")
        assertEquals(0, fbActiveCount(m.connectionId))
    }

    @Test
    fun `a connection deleted while the link waits on its row is a 400 and nothing is written`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbgr3", teams = true)
        val teams = w.requireTeams()
        val m = mirror(1 to planName("fb-a"))
        val response = heldAt(
            "SELECT id FROM flow_connections WHERE id = ? FOR NO KEY UPDATE", m.connectionId, "flow_connections",
            { w.admin.client.fbBind(m.connectionId, 1, teams.teamId) },
        ) { it.exec("UPDATE flow_connections SET marked_as_deleted = TRUE, api_token = NULL WHERE id = ?", m.connectionId.toInt()) }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals(0, fbActiveCount(m.connectionId))
    }

    /** Holds the global bind lock on a raw session, sends [requests], waits until ALL of them queue on it, then releases it. */
    private suspend fun queuedOnBindLock(requests: List<suspend () -> HttpResponse>): List<HttpResponse> {
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.execute("SELECT pg_advisory_xact_lock($FLOW_BIND_LOCK_KEY)") }
            try {
                return coroutineScope {
                    val pending = requests.map { request -> async { request() } }
                    awaitLockWait("pg_advisory_xact_lock", waiters = requests.size)
                    assertTrue(pending.none { it.isCompleted }, "every link is held at the bind lock")
                    raw.commit()
                    pending.awaitAll()
                }
            } finally {
                raw.rollback()
            }
        }
    }

    @Test
    fun `two links that queue on the bind lock - the loser gets the Kotlin 409 text, not a constraint's`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbgr4", teams = true)
        val teams = w.requireTeams()
        val m = mirror(1 to planName("fb-a"), 2 to planName("fb-b"))
        val admin = w.admin.client

        // One Flow team, two teams.
        val sameFlowTeam = queuedOnBindLock(
            listOf({ admin.fbBind(m.connectionId, 1, teams.teamId) }, { admin.fbBind(m.connectionId, 1, teams.otherTeamId) }),
        )
        assertEquals(listOf(HttpStatusCode.Created, HttpStatusCode.Conflict), sameFlowTeam.map { it.status }.sortedBy { it.value })
        val flowProblem = sameFlowTeam.single { it.status == HttpStatusCode.Conflict }.fbProblem()
        assertEquals("urn:astrolabe:problem:already-bound", flowProblem.type)
        val flowDetail = flowProblem.detail.orEmpty()
        assertTrue(flowDetail.startsWith("Flow team ") && " is already linked to team " in flowDetail, flowDetail)
        assertEquals(1, fbActiveCount(m.connectionId))

        // One team, two Flow teams (the first pair's winner is unlinked first so the team is free again).
        val active = "SELECT id FROM flow_team_bindings WHERE connection_id = ? AND NOT marked_as_deleted"
        val first = jbScalar(active, m.connectionId.toInt()) { it.getInt(1) }
        assertEquals(HttpStatusCode.NoContent, admin.delete("$FB_BINDINGS/$first").status)
        val sameTeam = queuedOnBindLock(
            listOf({ admin.fbBind(m.connectionId, 1, teams.teamId) }, { admin.fbBind(m.connectionId, 2, teams.teamId) }),
        )
        assertEquals(listOf(HttpStatusCode.Created, HttpStatusCode.Conflict), sameTeam.map { it.status }.sortedBy { it.value })
        val teamDetail = sameTeam.single { it.status == HttpStatusCode.Conflict }.fbProblem().detail.orEmpty()
        assertTrue(teamDetail.startsWith("Team ") && " is already linked to Flow team " in teamDetail, teamDetail)
        assertEquals(1, fbActiveCount(m.connectionId))
    }

    @Test
    fun `an unlink that waits for the binding row while another unlink commits is a 404`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbgr5", teams = true)
        val teams = w.requireTeams()
        val m = mirror(1 to planName("fb-a"))
        val binding = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        withAuditCapture { audit ->
            val response = heldAt(
                "SELECT id FROM flow_team_bindings WHERE id = ? FOR NO KEY UPDATE", binding.id, "flow_team_bindings",
                { teams.manager.client.delete("$FB_BINDINGS/${binding.id}") },
            ) { it.exec("UPDATE flow_team_bindings SET marked_as_deleted = TRUE WHERE id = ?", binding.id.toInt()) }
            assertEquals(HttpStatusCode.NotFound, response.status, "the row is re-read active under the lock")
            assertTrue(audit.events.none { it.message == "flow.team_unbound" && it.hasKeyValue("bindingId", binding.id.toLong()) })
        }
    }
}
