package ch.nokillswit

import ch.nokillswit.teams.CapacityPeriodRequest
import ch.nokillswit.teams.CapacityPeriodValues
import ch.nokillswit.teams.CapacityPeriodResponse
import ch.nokillswit.teams.CapacityPeriodList
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.sql.Connection
import java.sql.SQLException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The lifecycle half of the capacity periods (V16), beside `TeamCapacityTest`'s API matrix: the guard re-run UNDER the team row lock
 * (a request held open while the manager is cleared or the team deleted), the team-delete cascade, the V16 CHECK backstops, and the rule
 * that capacity is team data — no write here moves the plan revision.
 */
class TeamCapacityLifecycleTest {
    private fun collection(teamId: UInt) = "/api/v1/teams/$teamId/capacity"

    private fun period(id: UInt) = "/api/v1/capacity-periods/$id"

    /**
     * Holds `SELECT … FOR NO KEY UPDATE` on one row ([lockSql]) of a raw session, starts [request] (it passes the route's outer guard,
     * then waits at the lock whose statement text contains [waitingFragment]), runs [mutate] on the raw session and commits — the
     * committed change is what the request's re-guard under the locks must see. The barrier ([awaitLockWait]) proves the request is
     * waiting at that statement before anything is mutated.
     */
    private suspend fun requestHeld(
        lockSql: String,
        waitingFragment: String,
        request: suspend () -> HttpResponse,
        mutate: (Connection) -> Unit,
    ): HttpResponse {
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.executeQuery(lockSql).close() }
            try {
                return coroutineScope {
                    val pending = async { request() }
                    awaitLockWait(waitingFragment)
                    mutate(raw)
                    raw.commit()
                    pending.await()
                }
            } finally {
                raw.rollback()
            }
        }
    }

    /** The team row held: the request waits at the service's first lock, `lockActiveForWrite` (`FOR NO KEY UPDATE`). */
    private suspend fun requestHeldAtTeamLock(teamId: UInt, request: suspend () -> HttpResponse, mutate: (Connection) -> Unit) =
        requestHeld("SELECT id FROM teams WHERE id = $teamId FOR NO KEY UPDATE", "FOR NO KEY UPDATE", request, mutate)

    /**
     * The manager's PERSON row held: the request takes the team lock (free), then waits at `lockedIsActiveManager`'s
     * `FOR SHARE OF teams, people` — so the person-row half of the re-guard is what is pinned.
     */
    private suspend fun requestHeldAtPersonLock(personId: UInt, request: suspend () -> HttpResponse, mutate: (Connection) -> Unit) =
        requestHeld("SELECT id FROM people WHERE id = $personId FOR NO KEY UPDATE", "FOR SHARE", request, mutate)

    private fun activePeriods(teamId: UInt): Int =
        TestPlan.scalar("SELECT count(*) FROM team_capacity_periods WHERE team_id = $teamId AND NOT marked_as_deleted") { it.getInt(1) }

    @Test
    fun `a manager cleared from the team while a write was held is refused - 403, nothing written, whichever write`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("caph1", teams = true)
        val t = w.requireTeams()
        val existing = TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.0, wipLimit = 3)
        val client = t.manager.client
        val clear = { c: Connection -> c.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", t.teamId.toInt()) }
        val newPeriod = CapacityPeriodRequest("2027-03-01", 5.0)
        val created = requestHeldAtTeamLock(t.teamId, { client.postJson(collection(t.teamId), newPeriod) }, clear)
        assertEquals(HttpStatusCode.Forbidden, created.status)
        // The manager is gone for good: re-seat it for each of the next two held requests.
        val manager = t.manager.personId!!.toInt()
        val reseat = { c: Connection -> c.exec("UPDATE teams SET manager_person_id = ? WHERE id = ?", manager, t.teamId.toInt()) }
        PostgresTestSupport.connect().use { reseat(it) }
        val replacement = CapacityPeriodRequest("2027-02-02", 1.0)
        val replaced = requestHeldAtTeamLock(t.teamId, { client.putJson(period(existing), replacement) }, clear)
        assertEquals(HttpStatusCode.Forbidden, replaced.status)
        PostgresTestSupport.connect().use { reseat(it) }
        val deleted = requestHeldAtTeamLock(t.teamId, { client.delete(period(existing)) }, clear)
        assertEquals(HttpStatusCode.Forbidden, deleted.status)
        val read = w.admin.client.get(period(existing)).body<CapacityPeriodResponse>()
        assertEquals(listOf("2027-02-01", 10.0, 3), listOf(read.effectiveFrom, read.mdPerWeek, read.wipLimit), "nothing changed")
        assertEquals(1, activePeriods(t.teamId))
    }

    @Test
    fun `a manager's person unlinked from the login while a write waited at the person lock is refused - 403, nothing written`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("caph3", teams = true)
            val t = w.requireTeams()
            val existing = TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.0, wipLimit = 3)
            val person = t.manager.personId!!
            val unlink = { c: Connection -> c.exec("UPDATE people SET user_id = NULL WHERE id = ?", person.toInt()) }
            val client = t.manager.client
            val newPeriod = CapacityPeriodRequest("2027-03-01", 5.0)
            val created = requestHeldAtPersonLock(person, { client.postJson(collection(t.teamId), newPeriod) }, unlink)
            assertEquals(HttpStatusCode.Forbidden, created.status, "POST")
            // The login is unlinked for good, so the other two writes are held and refused the same way from a fresh link each time.
            val relink = { c: Connection -> c.exec("UPDATE people SET user_id = ? WHERE id = ?", t.manager.userId.toInt(), person.toInt()) }
            PostgresTestSupport.connect().use { relink(it) }
            val replacement = CapacityPeriodRequest("2027-02-02", 1.0)
            val replaced = requestHeldAtPersonLock(person, { client.putJson(period(existing), replacement) }, unlink)
            assertEquals(HttpStatusCode.Forbidden, replaced.status, "PUT")
            PostgresTestSupport.connect().use { relink(it) }
            val deleted = requestHeldAtPersonLock(person, { client.delete(period(existing)) }, unlink)
            assertEquals(HttpStatusCode.Forbidden, deleted.status, "DELETE")
            val read = w.admin.client.get(period(existing)).body<CapacityPeriodResponse>()
            assertEquals(listOf("2027-02-01", 10.0, 3), listOf(read.effectiveFrom, read.mdPerWeek, read.wipLimit), "nothing changed")
            assertEquals(1, activePeriods(t.teamId))
        }

    @Test
    fun `a team deleted while a write was held is 404 - nothing is written, whichever write`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("caph2", teams = true)
        val t = w.requireTeams()
        val existing = TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.0)
        val client = t.manager.client
        val deleteTeam = { c: Connection -> c.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", t.teamId.toInt()) }
        val newPeriod = CapacityPeriodRequest("2027-03-01", 5.0)
        val created = requestHeldAtTeamLock(t.teamId, { client.postJson(collection(t.teamId), newPeriod) }, deleteTeam)
        assertEquals(HttpStatusCode.NotFound, created.status, "POST")
        PostgresTestSupport.connect().use { it.exec("UPDATE teams SET marked_as_deleted = FALSE WHERE id = ?", t.teamId.toInt()) }
        val replacement = CapacityPeriodRequest("2027-02-02", 1.0)
        val replaced = requestHeldAtTeamLock(t.teamId, { client.putJson(period(existing), replacement) }, deleteTeam)
        assertEquals(HttpStatusCode.NotFound, replaced.status, "PUT")
        PostgresTestSupport.connect().use { it.exec("UPDATE teams SET marked_as_deleted = FALSE WHERE id = ?", t.teamId.toInt()) }
        val deleted = requestHeldAtTeamLock(t.teamId, { client.delete(period(existing)) }, deleteTeam)
        assertEquals(HttpStatusCode.NotFound, deleted.status, "DELETE")
        PostgresTestSupport.connect().use { it.exec("UPDATE teams SET marked_as_deleted = FALSE WHERE id = ?", t.teamId.toInt()) }
        assertEquals(1, activePeriods(t.teamId), "only the fixture period exists, untouched")
        val read = w.admin.client.get(period(existing)).body<CapacityPeriodResponse>()
        assertEquals(listOf("2027-02-01", 10.0), listOf(read.effectiveFrom, read.mdPerWeek))
    }

    @Test
    fun `the service re-validates typed values - a direct caller gets a 400, never a CHECK violation`() {
        val service = capacityService(sharedDatabaseForTests())
        kotlinx.coroutines.runBlocking {
            val teamId = TestTeams.seed(planName("capsvc"))
            val id = TestPlan.capacityPeriod(teamId, "2027-02-01", 10.0)
            fun values(md: String, wip: Int?, date: String = "2027-03-01") =
                CapacityPeriodValues(java.time.LocalDate.parse(date), java.math.BigDecimal(md), wip)
            val invalid = listOf(
                values("-1", null) to "mdPerWeek", values("1000000", null) to "mdPerWeek", values("1.005", null) to "mdPerWeek",
                values("5", 0) to "wipLimit", values("5", 100) to "wipLimit", values("5", -1) to "wipLimit",
            )
            for ((bad, field) in invalid) {
                val onCreate = assertFailsWith<io.ktor.server.plugins.BadRequestException> { service.create(teamId, bad) { } }
                assertTrue(onCreate.message.orEmpty().startsWith(field), "create: ${onCreate.message}")
                val onUpdate = assertFailsWith<io.ktor.server.plugins.BadRequestException> { service.update(id, bad) { } }
                assertTrue(onUpdate.message.orEmpty().startsWith(field), "update: ${onUpdate.message}")
            }
            assertEquals(1, activePeriods(teamId), "nothing was written")
            service.create(teamId, values("999999.99", 99)) { }
            service.update(id, values("0", 1, "2027-04-01")) { }
            assertEquals(2, activePeriods(teamId), "the boundary values are accepted")
            assertEquals(0.0, service.read(id)?.mdPerWeek)
        }
    }

    @Test
    fun `a team delete soft-deletes its active periods in the same transaction and audits their count`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capcas", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.0)
        TestPlan.capacityPeriod(t.teamId, "2027-03-01", 12.0, wipLimit = 2)
        val removed = TestPlan.capacityPeriod(t.teamId, "2027-04-01", 14.0)
        assertEquals(HttpStatusCode.NoContent, t.manager.client.delete(period(removed)).status)
        TestPlan.capacityPeriod(t.otherTeamId, "2027-02-01", 1.0)
        withAuditCapture { capture ->
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/${t.teamId}").status)
            val event = capture.awaitEvent { it.message == "team.deleted" && it.hasKeyValue("teamId", t.teamId.toLong()) }
            assertNotNull(event)
            assertTrue(event.hasKeyValue("capacityPeriodCount", 2), "the already-deleted period does not count")
        }
        assertEquals(0, activePeriods(t.teamId))
        val all = TestPlan.scalar("SELECT count(*) FROM team_capacity_periods WHERE team_id = ${t.teamId}") { it.getInt(1) }
        assertEquals(3, all, "soft, not hard")
        assertEquals(1, activePeriods(t.otherTeamId), "another team's periods stay")
    }

    @Test
    fun `a refused team delete leaves its periods alone and audits no cascade`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capcas2", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.0)
        TestPlan.milestone(w.projectId, t.teamId)
        withAuditCapture { capture ->
            assertEquals(HttpStatusCode.Conflict, w.admin.client.delete("/api/v1/teams/${t.teamId}").status)
            assertEquals(null, capture.events.firstOrNull { it.message == "team.deleted" && it.hasKeyValue("teamId", t.teamId.toLong()) })
        }
        assertEquals(1, activePeriods(t.teamId))
        assertEquals(1, w.admin.client.get(collection(t.teamId)).body<CapacityPeriodList>().items.size)
    }

    @Test
    fun `the V16 CHECK constraints and the partial index back the validator up at the database`() {
        val teamId = kotlinx.coroutines.runBlocking { TestTeams.seed(planName("capchk")) }
        fun insert(date: String, md: Double, wip: Int?) = PostgresTestSupport.connect().use { c ->
            c.prepareStatement(
                "INSERT INTO team_capacity_periods (team_id, effective_from, md_per_week, wip_limit, created_at, updated_at) " +
                    "VALUES (?, ?::date, ?, ?, 0, 0)",
            ).use { st ->
                st.setInt(1, teamId.toInt())
                st.setString(2, date)
                st.setDouble(3, md)
                if (wip == null) st.setNull(4, java.sql.Types.INTEGER) else st.setInt(4, wip)
                st.executeUpdate()
            }
        }
        assertEquals(1, insert("2027-02-01", 5.0, null))
        assertEquals(1, insert("2027-02-02", 0.0, 1))
        assertEquals(1, insert("2027-02-03", 5.0, 99))
        fun refused(constraint: String, date: String, md: Double, wip: Int?) {
            val message = assertFailsWith<SQLException> { insert(date, md, wip) }.message.orEmpty()
            assertTrue(message.contains(constraint), "$constraint expected in: $message")
        }
        refused("ck_team_capacity_periods_wip", "2027-02-04", 5.0, 0)
        refused("ck_team_capacity_periods_wip", "2027-02-05", 5.0, 100)
        refused("ck_team_capacity_periods_md", "2027-02-06", -1.0, null)
        refused("uq_team_capacity_periods_team_from_active", "2027-02-01", 7.0, null)
        PostgresTestSupport.connect().use { c ->
            c.createStatement().use {
                it.executeUpdate(
                    "UPDATE team_capacity_periods SET marked_as_deleted = TRUE WHERE team_id = $teamId AND effective_from = '2027-02-01'",
                )
            }
        }
        assertEquals(1, insert("2027-02-01", 7.0, null), "a soft-deleted period frees its date")
    }
}
