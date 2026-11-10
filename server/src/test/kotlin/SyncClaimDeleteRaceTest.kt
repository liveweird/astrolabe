package ch.nokillswit

import ch.nokillswit.flow.FlowConnectionService
import ch.nokillswit.flow.UNKNOWN_FLOW_CONNECTION
import ch.nokillswit.sync.ClaimedRun
import ch.nokillswit.sync.Connector
import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.SyncCounts
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncTrigger
import io.ktor.server.plugins.BadRequestException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.delay
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A claim racing the connection's delete never leaves a `sync_runs` row behind (1.3 backlog item). The claim takes the connection's
 * row `FOR SHARE` first ([Connector.lockActiveInTransaction]) and the delete takes it `FOR NO KEY UPDATE`, so the two serialize; each
 * order is driven deterministically with a raw JDBC transaction standing in for the half that is "in flight". The Flow connection
 * service is the real one (`SyncClaimDeletedConnectionTest` runs the real Jira and Flow observers); `sync_runs` has no foreign key, so
 * without the lock the late INSERT would commit and nothing would prune it.
 */
class SyncClaimDeleteRaceTest {
    private companion object {
        const val PREFIX = "sync-race"
        const val BUDGET_MS = 30_000L
        const val POLL_MS = 20L
    }

    private val database = sharedDatabaseForTests()
    private val registry: FlowConnectionService = newFlowConnectionService()
    private val runs = SyncRunService(database, maxRunMinutes = 10)

    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
    }

    /** The Flow observer's own claim hook, over the real connection service. */
    private val connector = object : Connector {
        override val kind = SyncKind.FLOW

        override suspend fun requireRunnable(connectionId: UInt) = Unit

        override suspend fun lockActiveInTransaction(connectionId: UInt) {
            if (!registry.lockActiveInTransaction(connectionId)) throw BadRequestException(UNKNOWN_FLOW_CONNECTION)
        }

        override suspend fun connections() = emptyList<ConnectorConnection>()

        override suspend fun run(run: ClaimedRun) = SyncResult.succeeded(SyncCounts())
    }

    private suspend fun newConnection(): UInt = registry.create(flowRequest(name = flowUnique(PREFIX)))

    /** Whether another backend is blocked on a row lock over `flow_connections` right now (the claim's or the delete's first statement). */
    private fun lockWaiterPresent(): Boolean = jbScalar(
        "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid() " +
            "AND query ILIKE '%flow_connections%'",
    ) { it.getInt(1) } > 0

    /** Polls (bounded) until the other transaction is provably waiting on our lock: no fixed pause, so no timing guess. */
    private suspend fun awaitLockWaiter() = withTimeout(BUDGET_MS) {
        while (!lockWaiterPresent()) delay(POLL_MS)
    }

    private fun runCount(id: UInt): Int =
        jbScalar("SELECT count(*) FROM sync_runs WHERE kind = 'FLOW' AND connection_id = ?", id.toInt()) { it.getInt(1) }

    @Test
    fun `a claim for a connection deleted since the runnable check is refused and writes nothing`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = newConnection()
        // The ordinary claim still lands on a live connection (and the lock does not block a second claim after the first finishes).
        val first = runs.claim(connector, id, SyncTrigger.MANUAL, null)
        assertTrue(runs.finish(first.id, SyncResult.succeeded(SyncCounts())))
        assertEquals(1, runCount(id))

        assertEquals(1, registry.delete(id).affected)
        assertEquals(0, runCount(id), "the delete removed the connection's runs")

        // The race outcome: the connector's check passed before the delete, the claim comes after it.
        assertFailsWith<BadRequestException> { runs.claim(connector, id, SyncTrigger.SCHEDULED, null) }
        assertEquals(0, runCount(id), "no orphan row for a deleted connection")
        assertFailsWith<BadRequestException> { runs.claim(connector, 2_000_000_000u, SyncTrigger.MANUAL, null) }
        assertEquals(0, runCount(2_000_000_000u), "nor for an id that never existed")
    }

    @Test
    fun `a claim that meets a delete in flight waits for it and is then refused`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = newConnection()
        PostgresTestSupport.connect().use { deleter ->
            deleter.autoCommit = false
            // The delete's first statements, as JiraConnectionService.delete / FlowConnectionService.delete run them.
            deleter.prepareStatement("SELECT id FROM flow_connections WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, id.toInt())
                st.executeQuery().use { assertTrue(it.next()) }
            }
            val claim = async(Dispatchers.IO) { runCatching { runs.claim(connector, id, SyncTrigger.MANUAL, null) } }
            awaitLockWaiter()
            assertFalse(claim.isCompleted, "the claim waits on the delete's row lock")
            deleter.prepareStatement("UPDATE flow_connections SET marked_as_deleted = true, api_token = NULL WHERE id = ?").use { st ->
                st.setInt(1, id.toInt())
                assertEquals(1, st.executeUpdate())
            }
            deleter.prepareStatement("DELETE FROM sync_runs WHERE kind = 'FLOW' AND connection_id = ?").use { st ->
                st.setInt(1, id.toInt())
                st.executeUpdate()
            }
            deleter.commit()
            val outcome = withTimeout(BUDGET_MS) { claim.await() }
            assertTrue(outcome.exceptionOrNull() is BadRequestException, "the claim saw the committed delete: $outcome")
        }
        assertEquals(0, runCount(id), "the waiting claim wrote nothing")
    }

    @Test
    fun `a delete that meets a claim in flight waits for it and then removes the claimed row`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = newConnection()
        PostgresTestSupport.connect().use { claimer ->
            claimer.autoCommit = false
            // The claim's statements: the share lock first, then the unfinished row.
            claimer.prepareStatement("SELECT id FROM flow_connections WHERE id = ? AND NOT marked_as_deleted FOR SHARE").use { st ->
                st.setInt(1, id.toInt())
                st.executeQuery().use { assertTrue(it.next()) }
            }
            claimer.prepareStatement(
                "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at) VALUES ('FLOW', ?, 'MANUAL', ?)",
            ).use { st ->
                st.setInt(1, id.toInt())
                st.setLong(2, System.currentTimeMillis())
                assertEquals(1, st.executeUpdate())
            }
            val delete = async(Dispatchers.IO) { registry.delete(id) }
            awaitLockWaiter()
            assertFalse(delete.isCompleted, "the delete waits on the claim's share lock")
            claimer.commit()
            assertEquals(1, withTimeout(BUDGET_MS) { delete.await() }.affected)
        }
        assertEquals(0, runCount(id), "the delete, which came second, removed the row the claim committed")
    }
}
