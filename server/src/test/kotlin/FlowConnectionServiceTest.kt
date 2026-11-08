package ch.nokillswit

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.flow.FLOW_CONNECTION_SORT_FIELDS
import ch.nokillswit.flow.FlowConnectionService
import ch.nokillswit.flow.FlowRunnableState
import ch.nokillswit.infra.crypto.DEV_DATA_ENCRYPTION_KEY
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.SortField
import ch.nokillswit.sync.SyncRunService
import io.ktor.server.plugins.BadRequestException
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Flow connection registry (V24) at the service seam: the token is an `enc:v1:` envelope at rest and write-only above it, only the
 * two named readers decrypt it (an unreadable envelope reads as null, never an exception), the origin is the identity, a PUT that
 * changes what a test judged clears the test, the scheduler's rows say when a connection is ready, and a delete takes the token, the
 * bindings, the runs and the mirror with it in one transaction.
 */
class FlowConnectionServiceTest {
    private companion object {
        const val PREFIX = "flow-svc"
    }

    private val service = newFlowConnectionService()
    private val store = newFlowMirrorStore()

    private fun name() = flowUnique(PREFIX)

    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
    }

    @Test
    fun `the token is stored as an envelope, never returned, and read back only by the two named readers`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val token = flowToken('k')
        val id = service.create(flowRequest(name = name(), token = token))

        val stored = assertNotNull(flowStoredToken(id))
        assertTrue(stored.startsWith(FieldCipher.PREFIX), "the stored value is an envelope")
        assertFalse(token in stored, "and not the token")
        assertEquals(token, flowTestCipher.decrypt(stored))

        val response = assertNotNull(service.read(id))
        assertTrue(response.hasApiToken)
        assertFalse(token in response.toString(), "the response carries hasApiToken, not the token")
        assertEquals(token, assertNotNull(service.readForTest(id)).apiToken)
        assertEquals(token, assertNotNull(service.readForRun(id)).apiToken)
        assertFalse(token in service.readForRun(id).toString(), "the decrypted target prints masked")
        assertEquals("Flow service token", service.encryptedRowLabel)
    }

    @Test
    fun `an envelope that cannot be decrypted reads as a null token, not an exception`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = service.create(flowRequest(name = name()))
        val otherKey = FlowConnectionService(
            sharedDatabaseForTests(), FieldCipher(strongEncryptionKey()), SyncRunService(sharedDatabaseForTests(), 10),
        ) { true }
        assertNull(assertNotNull(otherKey.readForRun(id)).apiToken, "a wrong key (GCM tag mismatch) is an unreadable token")
        assertNull(assertNotNull(otherKey.readForTest(id)).apiToken)
        jbSql("UPDATE flow_connections SET api_token = 'enc:v1:AAAA' WHERE id = ?", id.toInt())
        assertNull(assertNotNull(service.readForRun(id)).apiToken, "a corrupt envelope likewise")
        assertTrue(assertNotNull(service.read(id)).hasApiToken, "the registry still lists the row as having a token")
    }

    @Test
    fun `create and update validate the origin, the zone and the token grammar`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        assertFailsWith<BadRequestException> { service.create(flowRequest(token = null)) }
        assertFailsWith<BadRequestException> { service.create(flowRequest(token = "flow_int_short")) }
        assertFailsWith<BadRequestException> { service.create(flowRequest(token = "jira_" + "a".repeat(44))) }
        assertFailsWith<BadRequestException> { service.create(flowRequest(timeZone = "Mars/Olympus")) }
        assertFailsWith<BadRequestException> { service.create(flowRequest(timeZone = "+02:00")) }
        assertFailsWith<BadRequestException> { service.create(flowRequest(pollIntervalMinutes = 4)) }
        assertFailsWith<BadRequestException> { service.create(flowRequest(name = " ")) }
        val refused = assertFailsWith<BadRequestException> {
            service.create(flowRequest().copy(baseUrl = "http://elsewhere.test:8080"))
        }
        assertFalse("elsewhere" in refused.message.orEmpty(), "the rejected origin is not echoed")
        val id = service.create(flowRequest(name = name(), timeZone = "UTC", pollIntervalMinutes = null))
        assertEquals(null, assertNotNull(service.read(id)).pollIntervalMinutes, "an explicit null is manual only")
        assertFailsWith<BadRequestException> { service.update(id, flowRequest(token = "nope")) }
        Unit // a JUnit 4 test method returns void
    }

    @Test
    fun `an update keeps the token when none is sent, rotates it when one is, and clears the test when the token or the zone changes`() =
        runBlocking {
            PostgresTestSupport.ensureMigrated()
            val first = flowToken('a')
            val id = service.create(flowRequest(name = name(), token = first))
            val envelope = flowStoredToken(id)
            suspend fun tested(ok: Boolean = true) {
                val target = assertNotNull(service.readForTest(id))
                assertTrue(service.recordTest(id, target.expectedUpdatedAt, ok, at = 1234L))
            }

            tested()
            val renamed = flowUnique(PREFIX)
            val keep = service.update(id, flowRequest(name = renamed, token = null, enabled = false, pollIntervalMinutes = 15))
            assertEquals(1, keep.affected)
            assertFalse(keep.tokenRotated)
            assertEquals(envelope, flowStoredToken(id), "no token sent: the envelope is untouched")
            val kept = assertNotNull(service.read(id))
            assertEquals(listOf(renamed, false, 15), listOf(kept.name, kept.enabled, kept.pollIntervalMinutes))
            assertEquals(true, kept.lastTestOk, "a rename, enabled and interval do not change what a test judged")
            assertEquals(1234L, kept.lastTestedAt)

            val zone = service.update(id, flowRequest(name = renamed, token = null, timeZone = "UTC", enabled = false))
            assertEquals(1, zone.affected)
            val afterZone = assertNotNull(service.read(id))
            assertEquals(listOf(null, null), listOf(afterZone.lastTestOk, afterZone.lastTestedAt), "a new zone clears the test")
            assertEquals(60, afterZone.pollIntervalMinutes, "a PUT is a full replace: the member's default is back")

            tested()
            val rotated = service.update(id, flowRequest(name = renamed, token = flowToken('b'), timeZone = "UTC"))
            assertTrue(rotated.tokenRotated)
            assertNotEquals(envelope, flowStoredToken(id))
            assertEquals(flowToken('b'), assertNotNull(service.readForRun(id)).apiToken)
            assertNull(assertNotNull(service.read(id)).lastTestOk, "a new token clears the test")

            assertEquals(0, service.update(id + 1_000_000u, flowRequest()).affected, "an unknown id is 0 rows (404)")
        }

    @Test
    fun `the origin is the connection's identity - a PUT with another one is a conflict`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val other = "http://other-flow.test:8080"
        val allowsBoth = newFlowConnectionService(extraOrigins = setOf(other))
        val id = allowsBoth.create(flowRequest(name = name()))
        assertFailsWith<ConflictException> { allowsBoth.update(id, flowRequest().copy(baseUrl = other)) }
        assertEquals(FLOW_TEST_ORIGIN, assertNotNull(service.read(id)).baseUrl)
    }

    @Test
    fun `an origin delisted since cannot stop an admin from disabling or renaming the connection, and still cannot be changed`() =
        runBlocking {
            PostgresTestSupport.ensureMigrated()
            val id = service.create(flowRequest(name = name()))
            val database = sharedDatabaseForTests()
            val delisted = FlowConnectionService(database, flowTestCipher, SyncRunService(database, maxRunMinutes = 10)) { false }
            val renamed = name()
            assertEquals(1, delisted.update(id, flowRequest(name = renamed, token = null, enabled = false)).affected)
            assertEquals(listOf(renamed, false), assertNotNull(service.read(id)).let { listOf(it.name, it.enabled) })
            assertFailsWith<ConflictException> { delisted.update(id, flowRequest().copy(baseUrl = "http://other.test:8080")) }
            assertFailsWith<BadRequestException> { delisted.create(flowRequest(name = name())) }
            Unit
        }

    @Test
    fun `bindingsOf lists the active bindings of active teams only`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = service.create(flowRequest(name = name()))
        val alive = TestTeams.seed(flowUnique(PREFIX))
        val dead = TestTeams.seed(flowUnique(PREFIX))
        val unlinked = TestTeams.seed(flowUnique(PREFIX))
        val user = TestUsers.seed(uniqueEmail("flowbind"), "flow-bind-pass-1")
        fun bind(team: UInt, flowTeam: Int, deleted: Boolean = false) = jbSql(
            "INSERT INTO flow_team_bindings (connection_id, team_id, flow_team_id, flow_team_name, created_by_user_id, created_at, " +
                "updated_at, marked_as_deleted) VALUES (?, ?, ?, 'FT', ?, 1, 1, ?)",
            id.toInt(), team.toInt(), flowTeam, user.toInt(), deleted,
        )
        bind(alive, 1)
        bind(dead, 2)
        bind(unlinked, 3, deleted = true)
        jbSql("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", dead.toInt())
        val rows = newFlowBindingService().bindingsOf(id)
        assertEquals(listOf(alive, 1), rows.map { it.teamId to it.flowTeamId }.single().toList())
        assertEquals("FT", rows.single().flowTeamName)
    }

    @Test
    fun `a test result is recorded only for the row it judged`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = service.create(flowRequest(name = name()))
        val target = assertNotNull(service.readForTest(id))
        assertEquals(listOf(FLOW_TEST_ORIGIN, "Europe/Warsaw", true), listOf(target.baseUrl, target.timeZone, target.enabled))
        Thread.sleep(2) // updated_at is epoch millis: the edit below must land on a later one
        service.update(id, flowRequest(name = assertNotNull(service.read(id)).name, token = flowToken('c')))
        assertFalse(service.recordTest(id, target.expectedUpdatedAt, ok = true, at = 5L), "the token was rotated meanwhile")
        assertNull(assertNotNull(service.read(id)).lastTestOk)
        val fresh = assertNotNull(service.readForTest(id))
        assertTrue(service.recordTest(id, fresh.expectedUpdatedAt, ok = false, at = 6L))
        assertEquals(false, assertNotNull(service.read(id)).lastTestOk)
        assertEquals(fresh.expectedUpdatedAt, assertNotNull(service.read(id)).updatedAt, "recording a test does not touch updated_at")
        service.delete(id)
        assertFalse(service.recordTest(id, fresh.expectedUpdatedAt, ok = true, at = 7L), "a deleted connection records nothing")
    }

    @Test
    fun `the scheduler's rows say ready only after a passing test and change when the row or the test does`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = service.create(flowRequest(name = name(), pollIntervalMinutes = 30))
        suspend fun row() = service.pollRows().single { it.id == id }

        val untested = row()
        assertEquals(listOf(30, true, false), listOf(untested.pollIntervalMinutes, untested.enabled, untested.ready))
        val target = assertNotNull(service.readForTest(id))
        service.recordTest(id, target.expectedUpdatedAt, ok = false, at = target.expectedUpdatedAt + 50)
        assertFalse(row().ready, "a failing test is not ready")
        service.recordTest(id, target.expectedUpdatedAt, ok = true, at = target.expectedUpdatedAt + 100)
        val ready = row()
        assertTrue(ready.ready)
        assertEquals(target.expectedUpdatedAt + 100, ready.changedAt, "a fresh passing test makes it due: changedAt follows the test")
        service.delete(id)
        assertTrue(service.pollRows().none { it.id == id }, "a deleted connection is not polled")
        assertEquals(0, service.pollRows(queryTimeoutSeconds = 5).count { it.id == id }, "the budgeted read works too")
    }

    @Test
    fun `runnableState tells a run whether its connection is still there`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val id = service.create(flowRequest(name = name()))
        assertEquals(FlowRunnableState.RUNNABLE, service.runnableState(id))
        assertTrue(service.isRunnable(id))
        jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", id.toInt())
        assertEquals(FlowRunnableState.DISABLED, service.runnableState(id))
        assertFalse(service.isRunnable(id))
        service.delete(id)
        assertEquals(FlowRunnableState.GONE, service.runnableState(id))
        assertEquals(FlowRunnableState.GONE, service.runnableState(id + 1_000_000u))
    }

    @Test
    fun `list is paged and sorted by the whitelist and a deleted connection is not listed`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val a = service.create(flowRequest(name = "$PREFIX-list-b-${flowUnique("x")}"))
        val b = service.create(flowRequest(name = "$PREFIX-list-a-${flowUnique("x")}"))
        val gone = service.create(flowRequest(name = name()))
        service.delete(gone)
        assertEquals(setOf("id", "name", "createdAt"), FLOW_CONNECTION_SORT_FIELDS)
        val byName = service.list(PageRequest(1, 100, listOf(SortField("name", descending = false))))
        val ids = byName.items.map { it.id }
        assertTrue(ids.indexOf(b) in 0 until ids.indexOf(a), "ordered by name")
        assertFalse(gone in ids)
        assertTrue(byName.total >= 2 && byName.items.size <= byName.total, "total counts the rows before the page")
        assertEquals(1, service.list(PageRequest(1, 1, listOf(SortField("id", descending = true)))).items.size)
    }

    @Test
    fun `delete soft-deletes, destroys the token, and takes the bindings, the runs and the mirror with it`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val connectionName = name()
        val id = service.create(flowRequest(name = connectionName))
        val other = service.create(flowRequest(name = name()))
        val mirrored = flowTeam(1, sprints = listOf(flowSprint(10), flowSprint(11)), members = listOf(flowMember("a")))
        store.replace(id, listOf(mirrored), at = 5L)
        store.replace(other, listOf(flowTeam(1, sprints = listOf(flowSprint(10)))), at = 5L)
        val team = TestTeams.seed(flowUnique(PREFIX))
        val user = TestUsers.seed(uniqueEmail("flowdel"), "flow-del-pass-1")
        jbSql(
            "INSERT INTO flow_team_bindings (connection_id, team_id, flow_team_id, flow_team_name, created_by_user_id, created_at, " +
                "updated_at) VALUES (?, ?, 1, 'FT', ?, 1, 1)",
            id.toInt(), team.toInt(), user.toInt(),
        )
        // A finished FLOW run of the connection, one unfinished, and a JIRA run that happens to carry the same connection id.
        val finished = "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome) " +
            "VALUES (?, ?, 'MANUAL', 1, 2, 'FAILED')"
        jbSql(finished, "FLOW", id.toInt())
        jbSql(finished, "JIRA", id.toInt())
        jbSql("INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at) VALUES ('FLOW', ?, 'SCHEDULED', 3)", id.toInt())
        fun count(sql: String, connection: UInt) = jbScalar(sql, connection.toInt()) { it.getInt(1) }

        try {
            val outcome = service.delete(id)
            val host = FLOW_TEST_ORIGIN.substringAfter("://")
            assertEquals(listOf(1, connectionName, host), listOf(outcome.affected, outcome.name, outcome.host))
            assertEquals(
                listOf(1, 2, 4),
                listOf(outcome.bindingsUnbound, outcome.runsDeleted, outcome.mirrorDeleted),
                "1 binding, 2 FLOW runs, 1 team + 2 sprints + 1 member",
            )

            assertNull(service.read(id))
            assertNull(service.readForRun(id))
            assertNull(flowStoredToken(id), "the credential is destroyed")
            assertEquals(1, count("SELECT count(*) FROM flow_connections WHERE marked_as_deleted AND id = ?", id))
            assertEquals(1, count("SELECT count(*) FROM flow_team_bindings WHERE marked_as_deleted AND connection_id = ?", id))
            for (table in listOf("flow_teams", "flow_sprints", "flow_members")) {
                assertEquals(0, count("SELECT count(*) FROM $table WHERE connection_id = ?", id), table)
            }
            assertEquals(0, count("SELECT count(*) FROM sync_runs WHERE kind = 'FLOW' AND connection_id = ?", id))
            val jiraRuns = count("SELECT count(*) FROM sync_runs WHERE kind = 'JIRA' AND connection_id = ?", id)
            assertEquals(1, jiraRuns, "another kind's runs stay")
            assertEquals(1, store.sprintsOf(other, 1).size, "another connection's mirror is untouched")
            assertEquals(1, store.teamsOf(other).size)

            assertEquals(0, service.delete(id).affected, "a second delete finds nothing (404)")
            assertNotNull(service.read(service.create(flowRequest(name = connectionName))), "the name is free again")
            Unit // a JUnit 4 test method returns void
        } finally {
            jbSql("DELETE FROM sync_runs WHERE kind = 'JIRA' AND connection_id = ?", id.toInt())
        }
    }

    @Test
    fun `the boot backfill and a rotation re-wrap Flow tokens, and the previous key can then go`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val token = flowToken('r')
        val id = service.create(flowRequest(name = name(), token = token))
        val newKey = strongEncryptionKey()
        val database = sharedDatabaseForTests()
        val runs = SyncRunService(database, 10)
        val rotating = FlowConnectionService(database, FieldCipher(newKey, DEV_DATA_ENCRYPTION_KEY), runs) { true }
        val restoring = FlowConnectionService(database, FieldCipher(DEV_DATA_ENCRYPTION_KEY, newKey), runs) { true }
        try {
            assertEquals(0, service.encryptLegacyRows(reencryptAll = false), "nothing is plaintext: the plain backfill touches no row")
            assertTrue(rotating.encryptLegacyRows(reencryptAll = true) >= 1)
            assertEquals(token, FieldCipher(newKey).decrypt(assertNotNull(flowStoredToken(id))), "readable under the current key alone")
        } finally {
            // Hand every row back to the suite's key: the table is shared and the next rotation test must still read it.
            restoring.encryptLegacyRows(reencryptAll = true)
        }
        assertEquals(token, assertNotNull(service.readForRun(id)).apiToken)
    }
}
