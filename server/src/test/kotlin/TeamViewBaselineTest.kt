package ch.nokillswit

import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.planning.MovementKind
import ch.nokillswit.planning.TeamView
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * `GET /views/team/{id}?baseline=N` (v0.9 C7): one entry per live milestone of the team the baseline also froze (whatever team it sat
 * on then), the team's removed rows (gone, or moved to another team), the 400 rules, and that the overlay only ADDS keys.
 * 2027-02-01 is a Monday.
 */
class TeamViewBaselineTest {
    private fun path(teamId: UInt) = "/api/v1/views/team/$teamId"

    @Test
    fun `the baseline block lists the team's frozen live milestones with the team then, and the removed rows with where they went`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tvb", teams = true)
            val t = w.requireTeams()
            val a = TestPlan.milestone(w.projectId, t.teamId, "A moved", 4.0)
            val b = TestPlan.milestone(w.projectId, t.teamId, "B steady", 2.0)
            val joins = TestPlan.milestone(w.projectId, t.otherTeamId, "C joins", 1.0)
            val leaves = TestPlan.milestone(w.projectId, t.teamId, "D leaves", 1.5)
            val deleted = TestPlan.milestone(w.projectId, t.teamId, "E deleted", 6.0)
            val outsider = TestPlan.milestone(w.projectId, t.otherTeamId, "Z other team", 1.0)
            TestPlan.schedule(a, "2027-02-01", "2027-02-05")
            TestPlan.schedule(b, "2027-02-08", "2027-02-09")
            TestPlan.schedule(joins, "2027-02-15", "2027-02-16")
            TestPlan.schedule(leaves, "2027-02-17", "2027-02-18")
            TestPlan.schedule(deleted, "2027-02-10", "2027-02-12")
            TestPlan.schedule(outsider, "2027-02-22", "2027-02-23")
            val id = TestPlan.baseline(planName("tvb"))
            try {
                TestPlan.schedule(a, "2027-02-08", "2027-02-12")
                for ((milestone, name, team) in listOf(Triple(joins, "C joins", t.teamId), Triple(leaves, "D leaves", t.otherTeamId))) {
                    val request = MilestoneUpdateRequest(name, null, team, 1.0)
                    assertEquals(HttpStatusCode.NoContent, w.admin.client.putJson("/api/v1/milestones/$milestone", request).status)
                }
                assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$deleted").status)
                val fresh = TestPlan.milestone(w.projectId, t.teamId, "F fresh", 1.0)
                TestPlan.schedule(fresh, "2027-02-01", "2027-02-01")

                val view = w.stranger.client.get("${path(t.teamId)}?baseline=$id").body<TeamView>()
                val baseline = assertNotNull(view.baseline)
                assertEquals(id, baseline.id)
                val entries = baseline.milestones.associateBy { it.milestoneId }
                assertEquals(setOf(a, b, joins), entries.keys, "the team's live milestones that were frozen; the fresh one has no entry")
                assertEquals(MovementKind.MOVED, entries.getValue(a).movement.kind)
                assertEquals(5, entries.getValue(a).movement.endDays)
                assertEquals(t.teamId, entries.getValue(a).teamIdThen)
                assertEquals(MovementKind.UNCHANGED, entries.getValue(b).movement.kind)
                assertEquals(t.otherTeamId, entries.getValue(joins).teamIdThen, "it sat on the other team then: 'from {team}'")
                assertEquals("2027-02-15", entries.getValue(joins).start)

                assertEquals(listOf(deleted, leaves), baseline.removed.map { it.milestoneId }, "by start: E 02-10, D 02-17")
                val gone = baseline.removed.first()
                assertNull(gone.now, "deleted: no destination")
                assertEquals(t.teamId, gone.teamId)
                assertEquals(6.0, gone.estimateMd)
                assertEquals(w.projectId, gone.projectId)
                val moved = baseline.removed.last()
                assertEquals(t.otherTeamId, assertNotNull(moved.now).teamId)
                assertEquals(
                    TestPlan.scalar("SELECT name FROM teams WHERE id = ${t.otherTeamId}") { it.getString(1) },
                    moved.now?.teamName,
                )
                assertEquals(setOf(deleted, leaves), baseline.removed.map { it.milestoneId }.toSet())
                assertEquals(false, baseline.removed.any { it.milestoneId == outsider }, "another team's milestone is not this team's row")

                w.stranger.client.assertOverlayIsAdditive(path(t.teamId), id)
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    @Test
    fun `the parameter is refused with 400 - malformed, repeated, unknown, deleted - and a gone team is 404 first`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tvbr", teams = true)
        w.stranger.client.assertBaselineParameterRejected(path(w.requireTeams().teamId))
        val gone = TestTeams.seed(planName("tvbr-gone"), null)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$gone").status)
        assertEquals(HttpStatusCode.NotFound, w.stranger.client.get("${path(gone)}?baseline=999999").status, "the view's own rule first")
        assertEquals(HttpStatusCode.OK, w.stranger.client.get(path(w.requireTeams().teamId)).status)
    }
}
