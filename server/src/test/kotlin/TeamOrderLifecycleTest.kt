package ch.nokillswit

import ch.nokillswit.planning.MilestoneUpdateRequest
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.sql.SQLException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The lifecycle half of the team milestone order (V17), beside `TeamOrderTest`'s API matrix: the positions staying dense when a
 * milestone leaves its team (a team change, a delete, its project's delete), the DEFERRABLE position constraint, two PUTs racing for the
 * same revision and the guard re-run under the plan lock.
 */
class TeamOrderLifecycleTest {
    private val ok = HttpStatusCode.OK

    private fun dense(ids: List<UInt>): List<Pair<Int, UInt>> = ids.mapIndexed { index, id -> index + 1 to id }

    private suspend fun HttpClient.changeTeam(milestoneId: UInt, teamId: UInt): HttpResponse {
        val current = get("/api/v1/milestones/$milestoneId").body<ch.nokillswit.planning.MilestoneResponse>()
        val body = MilestoneUpdateRequest(current.name, current.description, teamId, current.estimateMd)
        return putJson("/api/v1/milestones/$milestoneId", body)
    }

    @Test
    fun `a team change and a delete take the milestone out of the order and keep the positions dense - first, middle and last`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tolife", teams = true)
            val t = w.requireTeams()
            val ms = List(5) { TestPlan.milestone(w.projectId, t.teamId) }
            val (m1, m2, m3) = ms
            val (m4, m5) = ms.drop(3)
            val unlisted = TestPlan.milestone(w.projectId, t.teamId)
            TestPlan.teamOrder(t.teamId, listOf(m1, m2, m3, m4, m5))
            val stamped = TestPlan.teamOrderRevision(t.teamId)
            val admin = w.admin.client

            // A team change out of the middle: the others close up, and the new team has nothing listed.
            val before = TestPlan.revision()
            assertEquals(HttpStatusCode.NoContent, admin.changeTeam(m3, t.otherTeamId).status)
            assertEquals(dense(listOf(m1, m2, m4, m5)), TestPlan.teamOrderRows(t.teamId))
            assertEquals(emptyList(), TestPlan.teamOrderRows(t.otherTeamId))
            assertEquals(before + 1, TestPlan.revision(), "the team change is ONE plan write")
            // A delete of the first, then of the last.
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/$m1").status)
            assertEquals(dense(listOf(m2, m4, m5)), TestPlan.teamOrderRows(t.teamId))
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/$m5").status)
            assertEquals(dense(listOf(m2, m4)), TestPlan.teamOrderRows(t.teamId))
            val gone = TestPlan.scalar("SELECT count(*) FROM team_milestone_orders WHERE milestone_id IN ($m1, $m3, $m5)") { it.getInt(1) }
            assertEquals(0, gone)
            // An unlisted milestone's change and delete leave the order alone; a removal never bumps the order revision.
            assertEquals(HttpStatusCode.NoContent, admin.changeTeam(unlisted, t.otherTeamId).status)
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/$unlisted").status)
            assertEquals(dense(listOf(m2, m4)), TestPlan.teamOrderRows(t.teamId))
            assertEquals(stamped, TestPlan.teamOrderRevision(t.teamId))
            // The changed milestone can be listed by its new team.
            assertEquals(ok, t.otherManager.client.putTeamOrder(t.otherTeamId, TestPlan.revision(), listOf(m3)).status)
            assertEquals(dense(listOf(m3)), TestPlan.teamOrderRows(t.otherTeamId))
        }

    @Test
    fun `a project delete takes all its milestones out of every team's order - one compaction per team`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("toproj", teams = true)
        val t = w.requireTeams()
        val second = secondProject(w)
        val doomed = w.projectId
        val kept = second.projectId
        // Interleaved on the team: doomed, kept, doomed, kept, doomed, kept; the other team: doomed, kept.
        val d = List(3) { TestPlan.milestone(doomed, t.teamId) }
        val k = List(3) { TestPlan.milestone(kept, t.teamId) }
        val otherDoomed = TestPlan.milestone(doomed, t.otherTeamId)
        val otherKept = TestPlan.milestone(kept, t.otherTeamId)
        TestPlan.teamOrder(t.teamId, listOf(d[0], k[0], d[1], k[1], d[2], k[2]))
        TestPlan.teamOrder(t.otherTeamId, listOf(otherDoomed, otherKept))
        val before = TestPlan.revision()

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/$doomed").status)
        assertEquals(dense(k), TestPlan.teamOrderRows(t.teamId))
        assertEquals(dense(listOf(otherKept)), TestPlan.teamOrderRows(t.otherTeamId))
        assertEquals(before + 1, TestPlan.revision(), "the delete and its compactions are ONE plan write")
        // The survivors can be reordered at the stored revision: the compaction did not stale them.
        val revision = TestPlan.teamOrderRevision(t.teamId)!!
        assertEquals(ok, t.manager.client.putTeamOrder(t.teamId, revision, listOf(k[2], k[0], k[1])).status)
    }

    @Test
    fun `the position constraint is deferrable - a swap passes, a duplicate fails only at commit, the CHECK at once`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tosql", teams = true)
        val t = w.requireTeams()
        val (a, b, c) = List(3) { TestPlan.milestone(w.projectId, t.teamId) }
        TestPlan.teamOrder(t.teamId, listOf(a, b, c))
        val deferrable = TestPlan.scalar(
            "SELECT condeferrable AND condeferred FROM pg_constraint WHERE conname = 'uq_team_milestone_orders_position'",
        ) { it.getBoolean(1) }
        assertTrue(deferrable, "DEFERRABLE INITIALLY DEFERRED")
        PostgresTestSupport.connect().use { c1 ->
            c1.autoCommit = false
            val swap = "UPDATE team_milestone_orders SET position = CASE milestone_id WHEN $a THEN 2 WHEN $b THEN 1 END " +
                "WHERE milestone_id IN ($a, $b)"
            c1.createStatement().use { it.executeUpdate(swap) }
            c1.commit()
            c1.createStatement().use { it.executeUpdate("UPDATE team_milestone_orders SET position = 1 WHERE milestone_id = $c") }
            assertEquals("23505", assertFailsWith<SQLException> { c1.commit() }.sqlState)
            c1.rollback()
            val check = assertFailsWith<SQLException> {
                c1.createStatement().use { it.executeUpdate("UPDATE team_milestone_orders SET position = 0 WHERE milestone_id = $c") }
            }
            assertEquals("23514", check.sqlState)
            c1.rollback()
        }
        assertEquals(dense(listOf(b, a, c)), TestPlan.teamOrderRows(t.teamId))
    }

    @Test
    fun `two PUTs racing with the same expectedRevision - exactly one wins and the other is the stale 409`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("torace", teams = true)
        val t = w.requireTeams()
        val (a, b, c) = List(3) { TestPlan.milestone(w.projectId, t.teamId) }
        TestPlan.teamOrder(t.teamId, listOf(a, b, c))
        val revision = TestPlan.teamOrderRevision(t.teamId)!!
        val plan = TestPlan.revision()
        val orders = listOf(listOf(c, b, a), listOf(b, c, a))
        val statuses = PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
            try {
                coroutineScope {
                    val calls = orders.map { ids -> async { t.manager.client.putTeamOrder(t.teamId, revision, ids) } }
                    awaitLockWait("plan_state", waiters = 2)
                    raw.rollback()
                    calls.map { it.await().status }
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(listOf(ok, HttpStatusCode.Conflict), statuses.sortedBy { it.value })
        assertEquals(plan + 1, TestPlan.revision(), "only the winner bumped")
        assertEquals(orders[statuses.indexOf(ok)], TestPlan.teamOrderIds(t.teamId), "the order is the winner's list, whole")
    }

    @Test
    fun `a team deleted while ADMIN's PUT waits at the plan lock is 404 - no state row, no bump, no audit`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("toadmin")
        val teamId = TestTeams.seed(planName("toadmin-team"), null)
        val revision = TestPlan.revision()
        withAuditCapture { capture ->
            val response = requestHeldAtPlanLock(
                { w.admin.client.putTeamOrder(teamId, revision, emptyList()) },
                { it.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", teamId.toInt()) },
            )
            assertEquals(HttpStatusCode.NotFound, response.status, "the outer check passed; the locked re-read under the plan lock did not")
            assertTrue(capture.events.none { it.message == "team.milestone_order_changed" && it.hasKeyValue("teamId", teamId.toLong()) })
        }
        assertEquals(null, TestPlan.teamOrderRevision(teamId), "no state row for a team that went away")
        assertEquals(revision, TestPlan.revision())
    }

    @Test
    fun `a manager cleared while the PUT waits at the plan lock is refused - 403, nothing written, no bump`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("toheld", teams = true)
        val t = w.requireTeams()
        val (a, b) = List(2) { TestPlan.milestone(w.projectId, t.teamId) }
        TestPlan.teamOrder(t.teamId, listOf(a, b))
        val revision = TestPlan.revision()
        withAuditCapture { capture ->
            val response = requestHeldAtPlanLock(
                { t.manager.client.putTeamOrder(t.teamId, revision, listOf(b, a)) },
                { it.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", t.teamId.toInt()) },
            )
            assertEquals(HttpStatusCode.Forbidden, response.status, "the outer guard passed; the re-check under the lock did not")
            val denied = capture.awaitEvent {
                it.message == "authz.denied" && it.hasKeyValue("path", "/api/v1/teams/${t.teamId}/milestone-order")
            }
            assertNotNull(denied, "the re-guard refusal is audited centrally")
            assertTrue(denied.hasKeyValue("byUserId", t.manager.userId.toLong()))
            val manager = t.manager.userId.toLong()
            assertTrue(capture.events.none { it.message == "team.milestone_order_changed" && it.hasKeyValue("byUserId", manager) })
        }
        assertEquals(revision, TestPlan.revision())
        assertEquals(listOf(a, b), TestPlan.teamOrderIds(t.teamId))
    }
}
