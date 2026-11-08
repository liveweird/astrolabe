package ch.nokillswit

import ch.nokillswit.flow.FlowMirrorSprint
import ch.nokillswit.flow.FlowMirrorStore
import ch.nokillswit.flow.fittedTo
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.math.BigDecimal
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Flow mirror (V24 `flow_teams`/`flow_sprints`/`flow_members`) at its seam: a run's document replaces the previous one wholesale in
 * ONE transaction (a failure leaves the old document), rows are fitted to their columns, a connection deleted meanwhile is skipped, and
 * the reads give the import and the roster what they need without ever naming an account in a count.
 */
class FlowMirrorStoreTest {
    private companion object {
        const val PREFIX = "flow-mirror"
    }

    private val connections = newFlowConnectionService()
    private val store = newFlowMirrorStore()

    private suspend fun connection() = connections.create(flowRequest(name = flowUnique(PREFIX)))

    private fun count(table: String, connection: UInt) =
        jbScalar("SELECT count(*) FROM $table WHERE connection_id = ?", connection.toInt()) { it.getInt(1) }

    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
    }

    @Test
    fun `replace writes the document, stamps teams_at and the reads give it back in order`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = connection()
        val sprints = listOf(
            flowSprint(31, start = 3_000, end = 4_000, md = "20.50", name = "Later"),
            flowSprint(30, start = 1_000, end = 2_000, md = "40.00", name = "Earlier"),
            flowSprint(32, start = null, end = null, md = null, name = "Undated"),
        )
        val members = listOf(flowMember("b", from = 5), flowMember("a", from = 9, to = 20), flowMember("a", from = 2, name = null))
        assertTrue(store.replace(id, listOf(flowTeam(2, "Zeta"), flowTeam(1, "Alpha", sprints, members)), at = 777L))

        assertEquals(777L, assertNotNull(connections.read(id)).teamsAt)
        val teams = store.teamsOf(id)
        assertEquals(listOf("Alpha", "Zeta"), teams.map { it.name }, "by name")
        val alpha = teams.first()
        assertEquals(listOf(1, 3, 3), listOf(alpha.flowTeamId, alpha.sprintCount, alpha.memberCount))
        assertEquals(777L, alpha.observedAt)
        assertEquals(BigDecimal("30.00"), alpha.defaultCapacityMd, "two decimals")
        assertEquals(listOf(0, 0), teams.last().let { listOf(it.sprintCount, it.memberCount) })

        val read = store.sprintsOf(id, 1)
        assertEquals(listOf(30L, 31L, 32L), read.map { it.sprintId }, "by start, undated last")
        assertEquals(
            FlowMirrorSprint(30, 1, "Earlier", "CLOSED", 1_000, 2_000, 2_000, true, BigDecimal("40.00"), "CALENDAR"),
            read.first(),
        )
        assertNull(read.last().capacityMd)
        assertNull(read.last().startAt)
        assertEquals(listOf(2L, 5L, 9L), store.membersOf(id, 1).map { it.validFrom }, "by start")
        assertNull(store.membersOf(id, 1).first().displayName)
        assertEquals(emptyList(), store.sprintsOf(id, 99), "an unknown team has no sprints")
        assertEquals(emptyList(), store.membersOf(id + 1_000_000u, 1))
    }

    @Test
    fun `a second replace swaps the whole document - nothing of the first survives`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = connection()
        store.replace(id, listOf(flowTeam(1, sprints = listOf(flowSprint(1), flowSprint(2)), members = listOf(flowMember("a")))), at = 1L)
        assertTrue(store.replace(id, listOf(flowTeam(3, "Third", sprints = listOf(flowSprint(9)))), at = 2L))
        assertEquals(listOf(3), store.teamsOf(id).map { it.flowTeamId })
        assertEquals(listOf(9L), store.sprintsOf(id, 3).map { it.sprintId })
        assertEquals(0, count("flow_members", id))
        assertEquals(1, count("flow_sprints", id))
        assertEquals(2L, assertNotNull(connections.read(id)).teamsAt)
        assertTrue(store.replace(id, emptyList(), at = 3L), "an empty document is a document")
        assertEquals(emptyList(), store.teamsOf(id))
        assertEquals(3L, assertNotNull(connections.read(id)).teamsAt)
    }

    @Test
    fun `a replace is atomic - a failure while writing leaves the previous document and its stamp`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = connection()
        assertTrue(store.replace(id, listOf(flowTeam(1, "Old", sprints = listOf(flowSprint(1)))), at = 10L))
        // A trigger makes the SPRINT insert of the new document fail after its teams were already inserted and the old rows deleted.
        jbSql(
            "CREATE OR REPLACE FUNCTION flow_mirror_test_fail() RETURNS trigger AS " +
                "\$\$ BEGIN RAISE EXCEPTION 'boom'; END \$\$ LANGUAGE plpgsql",
        )
        jbSql(
            "CREATE TRIGGER flow_mirror_test_fail BEFORE INSERT ON flow_sprints FOR EACH ROW " +
                "WHEN (NEW.connection_id = $id) EXECUTE FUNCTION flow_mirror_test_fail()",
        )
        try {
            val failure = runCatching { store.replace(id, listOf(flowTeam(2, "New", sprints = listOf(flowSprint(2)))), at = 20L) }
            assertTrue(failure.isFailure, "the write failed")
        } finally {
            jbSql("DROP TRIGGER flow_mirror_test_fail ON flow_sprints")
            jbSql("DROP FUNCTION flow_mirror_test_fail()")
        }
        assertEquals(listOf("Old"), store.teamsOf(id).map { it.name }, "the old teams are back: the delete rolled back with the insert")
        assertEquals(listOf(1L), store.sprintsOf(id, 1).map { it.sprintId })
        assertEquals(10L, assertNotNull(connections.read(id)).teamsAt, "and the stamp did not move")
    }

    @Test
    fun `a replace for a deleted or unknown connection writes nothing`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = connection()
        assertTrue(store.replace(id, listOf(flowTeam(1)), at = 1L))
        connections.delete(id)
        assertFalse(store.replace(id, listOf(flowTeam(2, sprints = listOf(flowSprint(5)))), at = 2L), "the run finds its connection gone")
        assertEquals(0, count("flow_teams", id))
        assertEquals(0, count("flow_sprints", id))
        assertFalse(store.replace(id + 1_000_000u, listOf(flowTeam(1)), at = 3L), "an unknown connection likewise")
        assertEquals(emptyList(), store.teamsOf(id))
    }

    @Test
    fun `a replace that waits behind the delete's row lock finds the connection gone and writes nothing`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = connection()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // The lock FlowConnectionService.delete holds: the replace's FOR SHARE must wait behind it.
            raw.prepareStatement("SELECT id FROM flow_connections WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, id.toInt())
                st.executeQuery().close()
            }
            coroutineScope {
                val writing = async { store.replace(id, listOf(flowTeam(1, sprints = listOf(flowSprint(1)))), at = 1L) }
                awaitLockWait("flow_connections")
                raw.prepareStatement("UPDATE flow_connections SET marked_as_deleted = TRUE, api_token = NULL WHERE id = ?").use {
                    it.setInt(1, id.toInt())
                    it.executeUpdate()
                }
                raw.commit()
                assertFalse(writing.await(), "the delete won: nothing was written")
            }
        }
        assertEquals(0, count("flow_teams", id))
        assertEquals(0, count("flow_sprints", id))
    }

    @Test
    fun `rows are fitted to their columns - text is cut, control characters become spaces, odd figures drop, duplicates collapse`() =
        runBlocking {
            PostgresTestSupport.ensureMigrated()
            val id = connection()
            val odd = flowSprint(1, name = "x".repeat(300)).copy(
                state = "A_VERY_LONG_STATE", capacitySource = "S".repeat(40), capacityMd = BigDecimal("1000000000"),
            )
            val team = flowTeam(
                1,
                name = "Tab\there " + "n".repeat(200),
                sprints = listOf(odd, flowSprint(1, name = "duplicate id"), flowSprint(2, md = "-5"), flowSprint(3, md = "12.345")),
                members = listOf(
                    flowMember("m".repeat(200), name = "Bell\u0007 " + "d".repeat(300)),
                    flowMember("dup", from = 4, name = "first"),
                    flowMember("dup", from = 4, name = "second"),
                ),
            ).copy(defaultCapacityMd = BigDecimal("12345678.9"))
            assertTrue(store.replace(id, listOf(team, flowTeam(1, "same id twice")), at = 1L))

            val row = store.teamsOf(id).single()
            assertEquals(100, row.name.length)
            assertTrue(row.name.startsWith("Tab here "), "a control character became a space")
            assertNull(row.defaultCapacityMd, "a default beyond NUMERIC(8,2) is not stored")
            val sprints = store.sprintsOf(id, 1).associateBy { it.sprintId }
            assertEquals(3, sprints.size, "the repeated sprint id collapsed to the first")
            assertEquals(255, sprints.getValue(1).name.length)
            val cut = sprints.getValue(1)
            assertEquals(listOf("A_VERY_LON", 20, null), listOf(cut.state, cut.capacitySource?.length, cut.capacityMd))
            assertNull(sprints.getValue(2).capacityMd, "a negative figure is no capacity")
            assertEquals(BigDecimal("12.35"), sprints.getValue(3).capacityMd, "half up to two decimals")
            val members = store.membersOf(id, 1)
            assertEquals(2, members.size, "the repeated interval collapsed to the first")
            val names = members.mapNotNull { it.displayName }
            assertTrue("first" in names && "second" !in names)
            assertEquals("Bell  " + "d".repeat(249), names.single { it.startsWith("Bell") }, "control character -> space, cut to 255")
            assertEquals(128, members.first { it.accountId.startsWith("m") }.accountId.length)
        }

    @Test
    fun `a cut never leaves half a surrogate pair`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val smile = "😀"
        assertEquals("a".repeat(99), ("a".repeat(99) + smile).fittedTo(100), "the pair straddling the cut is dropped whole")
        assertEquals("a".repeat(98) + smile, ("a".repeat(98) + smile).fittedTo(100), "a pair that fits is kept")
        val id = connection()
        assertTrue(store.replace(id, listOf(flowTeam(1, name = "n".repeat(99) + smile)), at = 1L), "an unpaired half would fail the insert")
        assertEquals("n".repeat(99), store.teamsOf(id).single().name)
    }

    @Test
    fun `deleteForConnectionInTransaction removes the three tables and counts the rows`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = connection()
        val kept = connection()
        val document = listOf(flowTeam(1, sprints = listOf(flowSprint(1)), members = listOf(flowMember("a"), flowMember("b"))))
        store.replace(id, document, at = 1L)
        store.replace(kept, document, at = 1L)
        val removed = suspendTransaction(sharedDatabaseForTests()) { FlowMirrorStore.deleteForConnectionInTransaction(id) }
        assertEquals(4, removed, "1 team + 1 sprint + 2 members")
        assertEquals(0, count("flow_members", id))
        assertEquals(2, count("flow_members", kept), "another connection's mirror is untouched")
    }
}
