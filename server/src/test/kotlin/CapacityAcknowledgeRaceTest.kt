package ch.nokillswit

import ch.nokillswit.flow.CapacityAcknowledgeServiceKey
import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeout
import org.junit.After
import java.sql.Connection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The capacity acknowledge's write transaction, with the team's real manager (an ADMIN's guard returns early). The
 * `JiraAcknowledgeRaceTest` barrier shape: a raw JDBC session holds the lock the request needs, the request is sent and passes its OUTER
 * guard, [awaitLockWait] says it reached its wait, the session changes the world and commits - and the held request must be judged against
 * the world as it then is: the binding and its team re-read ACTIVE, the guard again, the row recomputed inside the write's transaction.
 */
class CapacityAcknowledgeRaceTest {
    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @After
    fun cleanUp() {
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(CAPACK_PREFIX)
    }

    private suspend fun ApplicationTestBuilder.dayTwo(label: String): CapAckWorld = capAckWorld(label, mirrors).also { it.refresh() }

    /**
     * Holds [lockSql] (one int parameter [id]) on a raw session, runs every request in [requests], waits for [waiters] sessions
     * blocked in a statement containing [waitsAt], [change]s the world and commits.
     */
    private suspend fun <T> heldAt(
        lockSql: String,
        id: UInt,
        waitsAt: String,
        vararg requests: suspend () -> T,
        waiters: Int = 1,
        change: (Connection) -> Unit = {},
    ): List<T> {
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.prepareStatement(lockSql).use { st ->
                st.setInt(1, id.toInt())
                st.executeQuery().close()
            }
            try {
                return coroutineScope {
                    val pending = requests.map { request -> async { request() } }
                    awaitLockWait(waitsAt, waiters)
                    assertFalse(pending.any { it.isCompleted }, "the requests are held at the lock")
                    change(raw)
                    raw.commit()
                    pending.map { it.await() }
                }
            } finally {
                raw.rollback()
            }
        }
    }

    private val bindingLock = "SELECT id FROM flow_team_bindings WHERE id = ? FOR NO KEY UPDATE"

    @Test
    fun `a manager cleared while the acknowledge waits for the binding row is refused 403 and nothing is stored`() = testApplication {
        val world = dayTwo("capackr1")
        with(world) {
            val fingerprint = w.admin.client.rowOf(2).fingerprint
            val successor = w.requireTeams().otherManager.personId!!.toInt()
            withAuditCapture { audit ->
                val response = heldAt(
                    bindingLock, bindingId, "FOR NO KEY UPDATE", { manager.client.capAck(bindingId, 2, fingerprint) },
                ) { it.exec("UPDATE teams SET manager_person_id = ? WHERE id = ?", successor, teamId.toInt()) }
                    .single()
                assertEquals(HttpStatusCode.Forbidden, response.status, "the guard ran again under the lock")
                assertEquals(0, capAckStored(bindingId))
                assertTrue(audit.events.none { it.message.startsWith("flow.capacity_deviation") })
            }
        }
    }

    @Test
    fun `a manager whose person is re-linked while the acknowledge waits at the guard's person lock is refused 403`() = testApplication {
        val world = dayTwo("capackr2")
        with(world) {
            val fingerprint = w.admin.client.rowOf(2).fingerprint
            val person = manager.personId!!
            val response = heldAt(
                "SELECT id FROM people WHERE id = ? FOR NO KEY UPDATE", person, "FOR SHARE",
                { manager.client.capAck(bindingId, 2, fingerprint) },
            ) { it.exec("UPDATE people SET user_id = NULL WHERE id = ?", person.toInt()) }.single()
            assertEquals(HttpStatusCode.Forbidden, response.status, "the manager is resolved under a lock, fresh, inside the transaction")
            assertEquals(0, capAckStored(bindingId))
        }
    }

    @Test
    fun `a figure changed while the acknowledge waits is a 409 - recomputed inside the write, nothing stored`() = testApplication {
        val world = dayTwo("capackr3")
        with(world) {
            val seen = w.admin.client.rowOf(2)
            val response = heldAt(
                bindingLock, bindingId, "FOR NO KEY UPDATE", { manager.client.capAck(bindingId, 2, seen.fingerprint) },
            ) { it.exec("UPDATE team_capacity_periods SET md_per_week = 17 WHERE team_id = ? AND flow_sprint_id = 2", teamId.toInt()) }
                .single()
            assertEquals(HttpStatusCode.Conflict, response.status)
            assertEquals(STALE_DEVIATIONS_PROBLEM, response.jbProblem().type)
            assertEquals(0, capAckStored(bindingId), "nothing was stored against the old reading")
            assertNotEquals(seen.fingerprint, w.admin.client.rowOf(2).fingerprint, "the world did change")
        }
    }

    @Test
    fun `a binding unlinked, or its team deleted, while the acknowledge waits for its row is 404, not a write`() = testApplication {
        val world = dayTwo("capackr4")
        with(world) {
            val fingerprint = w.admin.client.rowOf(2).fingerprint
            val unlinked = heldAt(
                bindingLock, bindingId, "FOR NO KEY UPDATE", { manager.client.capAck(bindingId, 2, fingerprint) },
            ) { it.exec("UPDATE flow_team_bindings SET marked_as_deleted = TRUE WHERE id = ?", bindingId.toInt()) }.single()
            assertEquals(HttpStatusCode.NotFound, unlinked.status, "the row is re-read active under the lock")

            val billing = w.admin.client.rowOf(null, billingBindingId).fingerprint
            val otherManager = w.requireTeams().otherManager
            val deleted = heldAt(
                bindingLock, billingBindingId, "FOR NO KEY UPDATE", { otherManager.client.capAck(billingBindingId, null, billing) },
            ) { it.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", w.requireTeams().otherTeamId.toInt()) }.single()
            assertEquals(HttpStatusCode.NotFound, deleted.status, "a dead team is a missing binding")
            assertEquals(0, capAckStored(bindingId) + capAckStored(billingBindingId))
        }
    }

    @Test
    fun `a manager cleared while the withdrawal waits is refused 403 and the acknowledgement stays`() = testApplication {
        val world = dayTwo("capackr5")
        with(world) {
            w.admin.client.capAck(bindingId, 2, w.admin.client.rowOf(2).fingerprint).capAcknowledgement()
            val successor = w.requireTeams().otherManager.personId!!.toInt()
            val response = heldAt(
                bindingLock, bindingId, "FOR NO KEY UPDATE", { manager.client.capUnack(bindingId, "?sprintId=2") },
            ) { it.exec("UPDATE teams SET manager_person_id = ? WHERE id = ?", successor, teamId.toInt()) }
                .single()
            assertEquals(HttpStatusCode.Forbidden, response.status)
            assertEquals(1, capAckStored(bindingId), "still acknowledged")
        }
    }

    @Test
    fun `two acknowledges of one row at once are serialised by the binding row - both succeed, one row, the second restamps`() =
        testApplication {
            val world = dayTwo("capackr6")
            with(world) {
                val fingerprint = w.admin.client.rowOf(2).fingerprint
                val responses = heldAt(
                    bindingLock, bindingId, "FOR NO KEY UPDATE",
                    { manager.client.capAck(bindingId, 2, fingerprint) },
                    { w.admin.client.capAck(bindingId, 2, fingerprint) },
                    waiters = 2,
                )
                assertEquals(listOf(HttpStatusCode.OK, HttpStatusCode.OK), responses.map { it.status })
                assertEquals(1, capAckStored(bindingId), "the unique key held: the second UPDATEd the first's row")
            }
        }

    @Test
    fun `an acknowledge-all and a single acknowledge of one binding at once are serialised - both succeed, one row per sprint`() =
        testApplication {
            val world = dayTwo("capackr11")
            with(world) {
                val warning = w.admin.client.rowOf(2).fingerprint
                val info = w.admin.client.rowOf(3).fingerprint
                val responses = heldAt(
                    bindingLock, bindingId, "FOR NO KEY UPDATE",
                    { manager.client.capAckAll(bindingId, 2L to warning, 3L to info) },
                    { w.admin.client.capAck(bindingId, 2, warning) },
                    waiters = 2,
                )
                assertEquals(listOf(HttpStatusCode.OK, HttpStatusCode.OK), responses.map { it.status })
                assertEquals(2, capAckStored(bindingId), "the unique key held: whichever came second UPDATEd or replaced the first's row")
            }
        }

    @Test
    fun `a manager cleared while the acknowledge-all waits is refused 403, and a figure changed meanwhile is a 409 - nothing stored`() =
        testApplication {
            val world = dayTwo("capackr12")
            with(world) {
                val warning = w.admin.client.rowOf(2).fingerprint
                val info = w.admin.client.rowOf(3).fingerprint
                val successor = w.requireTeams().otherManager.personId!!.toInt()
                val refused = heldAt(
                    bindingLock, bindingId, "FOR NO KEY UPDATE", { manager.client.capAckAll(bindingId, 2L to warning, 3L to info) },
                ) { it.exec("UPDATE teams SET manager_person_id = ? WHERE id = ?", successor, teamId.toInt()) }.single()
                assertEquals(HttpStatusCode.Forbidden, refused.status, "the guard ran again under the lock")
                assertEquals(0, capAckStored(bindingId))

                val stale = heldAt(
                    bindingLock, bindingId, "FOR NO KEY UPDATE", { w.admin.client.capAckAll(bindingId, 2L to warning, 3L to info) },
                ) { it.exec("UPDATE team_capacity_periods SET md_per_week = 17 WHERE team_id = ? AND flow_sprint_id = 2", teamId.toInt()) }
                    .single()
                assertEquals(HttpStatusCode.Conflict, stale.status, "recomputed inside the write")
                assertEquals(STALE_DEVIATIONS_PROBLEM, stale.jbProblem().type)
                assertEquals(0, capAckStored(bindingId), "all or nothing: sprint 3's fingerprint was still right, and was not stored")
            }
        }

    @Test
    fun `an unacknowledge-all waits for the binding row - a manager cleared meanwhile is 403, a row withdrawn meanwhile is 409`() =
        testApplication {
            val world = dayTwo("capackr13")
            with(world) {
                val warning = w.admin.client.rowOf(2).fingerprint
                val info = w.admin.client.rowOf(3).fingerprint
                assertEquals(HttpStatusCode.OK, w.admin.client.capAckAll(bindingId, 2L to warning, 3L to info).status)
                val successor = w.requireTeams().otherManager.personId!!.toInt()
                val refused = heldAt(
                    bindingLock, bindingId, "FOR NO KEY UPDATE", { manager.client.capUnackAll(bindingId, 2, 3) },
                ) { it.exec("UPDATE teams SET manager_person_id = ? WHERE id = ?", successor, teamId.toInt()) }.single()
                assertEquals(HttpStatusCode.Forbidden, refused.status, "the guard ran again under the lock")
                assertEquals(2, capAckStored(bindingId))

                val stale = heldAt(
                    bindingLock, bindingId, "FOR NO KEY UPDATE", { w.admin.client.capUnackAll(bindingId, 2, 3) },
                ) { it.exec("DELETE FROM flow_capacity_acknowledgements WHERE binding_id = ? AND sprint_id = 3", bindingId.toInt()) }
                    .single()
                assertEquals(HttpStatusCode.Conflict, stale.status, "the stored rows were read under the lock")
                assertEquals(STALE_DEVIATIONS_PROBLEM, stale.jbProblem().type)
                assertEquals(1, capAckStored(bindingId), "all or nothing: sprint 2's row was still stored, and was not deleted")

                // The binding unlinked, or its team deleted, while the request waits: 404 under the lock, no row deleted.
                // (The step above moved team 1 to the other manager, so the first request is the admin's: it must pass the outer guard.)
                val billing = w.admin.client.rowOf(null, billingBindingId).fingerprint
                val otherManager = w.requireTeams().otherManager
                assertEquals(HttpStatusCode.OK, otherManager.client.capAck(billingBindingId, null, billing).status)
                val unlinked = heldAt(
                    bindingLock, bindingId, "FOR NO KEY UPDATE", { w.admin.client.capUnackAll(bindingId, 2) },
                ) { it.exec("UPDATE flow_team_bindings SET marked_as_deleted = TRUE WHERE id = ?", bindingId.toInt()) }.single()
                assertEquals(HttpStatusCode.NotFound, unlinked.status, "the row is re-read active under the lock")
                assertEquals(1, capAckStored(bindingId), "nothing was deleted")
                val deleted = heldAt(
                    bindingLock, billingBindingId, "FOR NO KEY UPDATE", { otherManager.client.capUnackAll(billingBindingId, null) },
                ) { it.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", w.requireTeams().otherTeamId.toInt()) }.single()
                assertEquals(HttpStatusCode.NotFound, deleted.status, "a dead team is a missing binding")
                assertEquals(1, capAckStored(billingBindingId), "nothing was deleted")
            }
        }

    @Test
    fun `a run waits for a binding row another session holds, then completes and prunes`() =
        testApplication {
            val world = dayTwo("capackr8")
            with(world) {
                val admin = w.admin.client
                admin.capAck(bindingId, 2, admin.rowOf(2).fingerprint).capAcknowledgement()
                admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
                // Sprint 2 leaves the document; the run (the connection row taken, then the binding rows) stops at the held binding row.
                heldAt(bindingLock, bindingId, "FOR NO KEY UPDATE", { refreshOnly(1, 3) })
                assertNull(capAckRow(bindingId, 2), "the run resumed after the release and pruned the row that left the list")
                assertNotNull(capAckRow(bindingId, 3))
            }
        }

    @Test
    fun `an acknowledge that waits behind a run's prune recomputes on the new mirror - 409, nothing stored`() = testApplication {
        val world = dayTwo("capackr9")
        with(world) {
            val admin = w.admin.client
            val s2 = admin.rowOf(2)
            admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
            PostgresTestSupport.connect().use { raw ->
                raw.autoCommit = false
                // The stored row is held, so the run stops at its DELETE with the binding row ALREADY locked.
                raw.prepareStatement("SELECT id FROM flow_capacity_acknowledgements WHERE binding_id = ? FOR UPDATE").use { st ->
                    st.setInt(1, bindingId.toInt())
                    st.executeQuery().close()
                }
                try {
                    val acknowledge = coroutineScope {
                        val run = async { refresh(dayTwo = false) } // every sprint in line: sprint 3's row is pruned, sprint 2 is no row
                        awaitLockWait("DELETE FROM flow_capacity_acknowledgements")
                        val acknowledge = async { manager.client.capAck(bindingId, 2, s2.fingerprint) }
                        awaitLockWait("FOR NO KEY UPDATE")
                        assertFalse(acknowledge.isCompleted, "the acknowledge is queued behind the run's binding row")
                        raw.commit()
                        run.await()
                        acknowledge.await()
                    }
                    assertEquals(HttpStatusCode.Conflict, acknowledge.status, "judged against the mirror the run committed")
                    assertEquals(STALE_DEVIATIONS_PROBLEM, acknowledge.jbProblem().type)
                    assertEquals(0, capAckStored(bindingId), "the pruned row is gone and nothing was stored for sprint 2")
                } finally {
                    raw.rollback()
                }
            }
        }
    }

    @Test
    fun `a run on a connection without stored acknowledgements takes no binding lock - it completes while every binding row is held`() =
        testApplication {
            val world = dayTwo("capackr10")
            with(world) {
                assertEquals(0, capAckStored(bindingId) + capAckStored(billingBindingId))
                PostgresTestSupport.connect().use { raw ->
                    raw.autoCommit = false
                    raw.prepareStatement("SELECT id FROM flow_team_bindings WHERE connection_id = ? FOR NO KEY UPDATE").use { st ->
                        st.setInt(1, mirror.connectionId.toInt())
                        st.executeQuery().close()
                    }
                    try {
                        withTimeout(30_000) { refresh(dayTwo = false) }
                    } finally {
                        raw.rollback()
                    }
                }
            }
        }

    // 1.14: the prune after a capacity write (a transaction of its own, after the write's commit).

    @Test
    fun `the prune after a capacity write waits for a held binding row, then completes - the write was already committed`() =
        testApplication {
            val world = dayTwo("capackr14")
            with(world) {
                val admin = w.admin.client
                admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
                val s3 = capAckPeriod(teamId, 3)
                val response = heldAt(bindingLock, bindingId, "FOR NO KEY UPDATE", { manager.client.capAckEdit(s3, 24.0) }) {
                    val sql = "SELECT md_per_week::text FROM team_capacity_periods WHERE id = ?"
                    val stored = jbScalar(sql, s3.id.toInt()) { it.getString(1) }
                    assertEquals("24.00", stored, "the write committed before the prune asked for the binding row")
                    assertNotNull(capAckRow(bindingId, 3), "the prune has not run yet")
                }.single()
                assertEquals(HttpStatusCode.NoContent, response.status)
                assertNull(capAckRow(bindingId, 3), "the prune resumed after the release and cleared the row, before the answer")
            }
        }

    @Test
    fun `the prune after a capacity write takes no team lock - it completes while another session holds the team row`() = testApplication {
        val world = dayTwo("capackr15")
        with(world) {
            val admin = w.admin.client
            admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
            // The write the prune follows, done by hand (the routes call the prune AFTER the write's commit, so no team lock is held).
            jbSql("UPDATE team_capacity_periods SET md_per_week = 24 WHERE team_id = ? AND flow_sprint_id = 3", teamId.toInt())
            val service = application.attributes[CapacityAcknowledgeServiceKey]
            PostgresTestSupport.connect().use { raw ->
                raw.autoCommit = false
                // FOR UPDATE: it conflicts with every lock the guard's team read (FOR SHARE) or a write (FOR NO KEY UPDATE) could take.
                raw.prepareStatement("SELECT id FROM teams WHERE id = ? FOR UPDATE").use { st ->
                    st.setInt(1, teamId.toInt())
                    st.executeQuery().close()
                }
                try {
                    val pruned = withTimeout(30_000) { service.pruneAfterCapacityWrite(teamId) }
                    assertEquals(listOf(3L), pruned?.sprintIds)
                } finally {
                    raw.rollback()
                }
            }
            assertNull(capAckRow(bindingId, 3))
        }
    }

    @Test
    fun `a team without stored rows takes no binding lock - its capacity write answers while every binding is held`() = testApplication {
        val world = dayTwo("capackr16")
        with(world) {
            assertEquals(0, capAckStored(bindingId) + capAckStored(billingBindingId))
            val s3 = capAckPeriod(teamId, 3)
            PostgresTestSupport.connect().use { raw ->
                raw.autoCommit = false
                raw.prepareStatement("SELECT id FROM flow_team_bindings WHERE connection_id = ? FOR NO KEY UPDATE").use { st ->
                    st.setInt(1, mirror.connectionId.toInt())
                    st.executeQuery().close()
                }
                try {
                    assertEquals(HttpStatusCode.NoContent, withTimeout(30_000) { manager.client.capAckEdit(s3, 24.0) }.status)
                } finally {
                    raw.rollback()
                }
            }
        }
    }

    @Test
    fun `an acknowledgement takes no plan lock - it completes while another session holds plan_state`() = testApplication {
        val world = dayTwo("capackr7")
        with(world) {
            val fingerprint = w.admin.client.rowOf(2).fingerprint
            PostgresTestSupport.connect().use { raw ->
                raw.autoCommit = false
                raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
                try {
                    val response = withTimeout(30_000) { manager.client.capAck(bindingId, 2, fingerprint) }
                    assertEquals(HttpStatusCode.OK, response.status, "not blocked behind the plan lock")
                    assertEquals(HttpStatusCode.NoContent, withTimeout(30_000) { manager.client.capUnack(bindingId, "?sprintId=2") }.status)
                } finally {
                    raw.rollback()
                }
            }
        }
    }
}
