package ch.nokillswit

import ch.nokillswit.flow.CapacityAcknowledgeServiceKey
import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import ch.nokillswit.teams.CapacityPeriodRequest
import ch.nokillswit.teams.CapacityWriteTrail
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

    // 1.13.2: a capacity write takes the team's binding row BEFORE the team row and prunes inside its own transaction.

    private val periodSql = "SELECT md_per_week::text FROM team_capacity_periods WHERE id = ?"

    /** Whether another session can NOT take the binding row right now (a `NOWAIT` that fails with `55P03`: somebody holds it). */
    private fun bindingIsLocked(id: UInt): Boolean = PostgresTestSupport.connect().use { c ->
        c.autoCommit = false
        try {
            c.prepareStatement("SELECT id FROM flow_team_bindings WHERE id = ? FOR NO KEY UPDATE NOWAIT").use { st ->
                st.setInt(1, id.toInt())
                st.executeQuery().close()
            }
            false
        } catch (e: java.sql.SQLException) {
            e.sqlState == LOCK_NOT_AVAILABLE
        } finally {
            c.rollback()
        }
    }

    /** Takes the team row `FOR UPDATE NOWAIT` on [raw]: throws when somebody else (a write, a link's `FOR SHARE`) holds it. */
    private fun requireTeamRowFree(raw: Connection, teamId: UInt) {
        raw.prepareStatement("SELECT id FROM teams WHERE id = ? FOR UPDATE NOWAIT").use { st ->
            st.setInt(1, teamId.toInt())
            st.executeQuery().close()
        }
    }

    @Test
    fun `a capacity write queues at a held binding row before it writes or locks the team, then prunes in the same transaction`() =
        testApplication {
            val world = dayTwo("capackr14")
            with(world) {
                val admin = w.admin.client
                admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
                val s3 = capAckPeriod(teamId, 3)
                val response = heldAt(bindingLock, bindingId, "FOR NO KEY UPDATE", { manager.client.capAckEdit(s3, 24.0) }) { raw ->
                    val stored = jbScalar(periodSql, s3.id.toInt()) { it.getString(1) }
                    assertEquals("22.00", stored, "nothing is written while the binding row is held")
                    assertNotNull(capAckRow(bindingId, 3), "and nothing is pruned")
                    requireTeamRowFree(raw, teamId) // the write holds no team lock yet: binding first, team second
                }.single()
                assertEquals(HttpStatusCode.NoContent, response.status)
                assertEquals("24.00", jbScalar(periodSql, s3.id.toInt()) { it.getString(1) })
                assertNull(capAckRow(bindingId, 3), "the prune committed with the write, before the answer")
            }
        }

    @Test
    fun `two capacity writes of one team meeting at its binding row leave an in-line-and-back acknowledgement pruned`() = testApplication {
        val world = dayTwo("capackr17")
        with(world) {
            val admin = w.admin.client
            admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
            val s3 = capAckPeriod(teamId, 3)
            PostgresTestSupport.connect().use { raw ->
                raw.autoCommit = false
                raw.prepareStatement(bindingLock).use { st ->
                    st.setInt(1, bindingId.toInt())
                    st.executeQuery().close()
                }
                try {
                    val (inLine, back) = coroutineScope {
                        // The first write brings sprint 3 in line (22 -> 24), the second puts it back (24 -> 22). Before 1.13.2 both
                        // committed and BOTH prunes then read the final, deviating state: the acknowledgement stood.
                        val inLine = async { manager.client.capAckEdit(s3, 24.0) }
                        awaitLockWait("FOR NO KEY UPDATE", 1)
                        val back = async { admin.capAckEdit(s3, 22.0) }
                        awaitLockWait("FOR NO KEY UPDATE", 2)
                        assertFalse(inLine.isCompleted || back.isCompleted, "both writes are held at the binding row")
                        raw.commit()
                        inLine.await() to back.await()
                    }
                    assertEquals(HttpStatusCode.NoContent, inLine.status)
                    assertEquals(HttpStatusCode.NoContent, back.status)
                } finally {
                    raw.rollback()
                }
            }
            assertEquals("22.00", jbScalar(periodSql, s3.id.toInt()) { it.getString(1) }, "the second write ran last: the figure is back")
            assertNull(capAckRow(bindingId, 3), "the first write's prune saw the in-line state, whatever the second did next")
            assertNull(admin.rowOf(3).acknowledgement, "the same difference is OPEN again")
        }
    }

    @Test
    fun `a capacity write that waits for the team row has the binding row - an acknowledge queues behind it, nothing deadlocks`() =
        testApplication {
            val world = dayTwo("capackr15")
            with(world) {
                val admin = w.admin.client
                val fingerprint = admin.rowOf(3).fingerprint
                val s3 = capAckPeriod(teamId, 3)
                val (write, acknowledge) = PostgresTestSupport.connect().use { raw ->
                    raw.autoCommit = false
                    raw.prepareStatement("SELECT id FROM teams WHERE id = ? FOR UPDATE").use { st ->
                        st.setInt(1, teamId.toInt())
                        st.executeQuery().close()
                    }
                    try {
                        coroutineScope {
                            val write = async { manager.client.capAckEdit(s3, 24.0) }
                            awaitLockWait("FROM teams")
                            assertTrue(bindingIsLocked(bindingId), "the write took the binding row first and now waits for the team row")
                            val acknowledge = async { admin.capAck(bindingId, 3, fingerprint) }
                            awaitLockWait("FROM flow_team_bindings")
                            assertFalse(write.isCompleted || acknowledge.isCompleted, "write on the team, acknowledge on the write")
                            raw.commit()
                            write.await() to acknowledge.await()
                        }
                    } finally {
                        raw.rollback()
                    }
                }
                assertEquals(HttpStatusCode.NoContent, write.status)
                assertEquals(HttpStatusCode.Conflict, acknowledge.status, "recomputed AFTER the write: sprint 3 is in line, no row")
                assertEquals(STALE_DEVIATIONS_PROBLEM, acknowledge.jbProblem().type)
                assertEquals(0, capAckStored(bindingId))
            }
        }

    @Test
    fun `an acknowledge queued ahead of a capacity write stamps first and the write then prunes it - both succeed`() = testApplication {
        val world = dayTwo("capackr18")
        with(world) {
            val admin = w.admin.client
            val fingerprint = admin.rowOf(3).fingerprint
            val s3 = capAckPeriod(teamId, 3)
            PostgresTestSupport.connect().use { raw ->
                raw.autoCommit = false
                raw.prepareStatement(bindingLock).use { st ->
                    st.setInt(1, bindingId.toInt())
                    st.executeQuery().close()
                }
                try {
                    val (acknowledge, write) = coroutineScope {
                        val acknowledge = async { admin.capAck(bindingId, 3, fingerprint) }
                        awaitLockWait("FOR NO KEY UPDATE", 1)
                        val write = async { manager.client.capAckEdit(s3, 24.0) }
                        awaitLockWait("FOR NO KEY UPDATE", 2)
                        raw.commit()
                        acknowledge.await() to write.await()
                    }
                    assertEquals(HttpStatusCode.OK, acknowledge.status)
                    assertEquals(HttpStatusCode.NoContent, write.status)
                } finally {
                    raw.rollback()
                }
            }
            assertNull(capAckRow(bindingId, 3), "the acknowledgement was stamped, then the write brought the sprint in line and ended it")
        }
    }

    @Test
    fun `a bound team's capacity write queues behind its binding row even with no stored rows - another team's write does not`() =
        testApplication {
            val world = dayTwo("capackr16")
            with(world) {
                assertEquals(0, capAckStored(bindingId) + capAckStored(billingBindingId))
                val s3 = capAckPeriod(teamId, 3)
                val edit = heldAt(bindingLock, bindingId, "FOR NO KEY UPDATE", { manager.client.capAckEdit(s3, 24.0) }).single()
                assertEquals(HttpStatusCode.NoContent, edit.status, "an acknowledge in flight could store a row: the write waits for it")

                PostgresTestSupport.connect().use { raw ->
                    raw.autoCommit = false
                    raw.prepareStatement(bindingLock).use { st ->
                        st.setInt(1, bindingId.toInt())
                        st.executeQuery().close()
                    }
                    try {
                        val other = w.requireTeams().otherTeamId
                        val body = CapacityPeriodRequest("2049-05-03", 5.0)
                        val created = withTimeout(30_000) { w.admin.client.postJson("/api/v1/teams/$other/capacity", body) }
                        assertEquals(HttpStatusCode.Created, created.status, "another team's binding is not the held one")
                    } finally {
                        raw.rollback()
                    }
                }
            }
        }

    @Test
    fun `the capacity write's prune touches only the bindings its lock step locked - none passed, nothing pruned`() = testApplication {
        val world = dayTwo("capackr20")
        with(world) {
            val admin = w.admin.client
            admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
            // The write the prune follows, done by hand: sprint 3 is in line now, so its row is prunable.
            jbSql("UPDATE team_capacity_periods SET md_per_week = 24 WHERE team_id = ? AND flow_sprint_id = 3", teamId.toInt())
            val service = application.attributes[CapacityAcknowledgeServiceKey]
            val none = CapacityWriteTrail()
            service.pruneInCapacityWrite(teamId, emptyList(), none)
            none.told(manager.userId)
            assertNotNull(capAckRow(bindingId, 3), "a binding this write never locked (linked since) is not pruned")
            val other = CapacityWriteTrail()
            service.pruneInCapacityWrite(teamId, listOf(billingBindingId), other)
            assertNotNull(capAckRow(bindingId, 3), "nor is another team's binding id taken for this team's")
            service.pruneInCapacityWrite(teamId, listOf(bindingId), CapacityWriteTrail())
            assertNull(capAckRow(bindingId, 3), "the locked binding is pruned")
        }
    }

    @Test
    fun `a link of an already-linked team queues at its binding row without holding the team row, then is refused 409`() = testApplication {
        val world = dayTwo("capackr19")
        with(world) {
            val bind = suspend { w.admin.client.fbBind(mirror.connectionId, 1, teamId) }
            val link = heldAt(bindingLock, bindingId, "FOR NO KEY UPDATE", bind) { raw ->
                // A link that held the team FOR SHARE while it waited would close a cycle with a capacity write (binding, then team).
                requireTeamRowFree(raw, teamId)
            }.single()
            assertEquals(HttpStatusCode.Conflict, link.status)
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

/** SQLSTATE of a `NOWAIT` that found the row locked. */
private const val LOCK_NOT_AVAILABLE = "55P03"
