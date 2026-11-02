package ch.nokillswit

import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.planning.MovementKind
import ch.nokillswit.planning.ProjectView
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/project/{id}?baseline=N` (v0.9 C7): the project's own movement, one entry per live milestone the baseline also froze,
 * the removed ones, the 400 rules, and that the overlay only ADDS keys. 2027-02-01 is a Monday.
 */
class ProjectViewBaselineTest {
    private fun path(projectId: UInt) = "/api/v1/views/project/$projectId"

    @Test
    fun `the baseline block carries the project's movement, an entry per frozen live milestone and the removed ones`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvb", teams = true)
        val t = w.requireTeams()
        val p = w.projectId
        val moved = TestPlan.milestone(p, t.teamId, "Moved", 4.0)
        val steady = TestPlan.milestone(p, t.teamId, "Steady", 2.0)
        val tray = TestPlan.milestone(p, t.teamId, "Tray", 1.0)
        val vanished = TestPlan.milestone(p, t.teamId, "Vanished", 3.5)
        val changedTeam = TestPlan.milestone(p, t.teamId, "Changes team", 1.0)
        TestPlan.schedule(moved, "2027-02-01", "2027-02-05")
        TestPlan.schedule(steady, "2027-02-08", "2027-02-12")
        TestPlan.schedule(vanished, "2027-02-15", "2027-02-17")
        TestPlan.schedule(changedTeam, "2027-02-22", "2027-02-26")
        val id = TestPlan.baseline(planName("pvb"))
        try {
            TestPlan.schedule(moved, "2027-02-08", "2027-02-12")
            TestPlan.schedule(tray, "2027-03-01", "2027-03-02")
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$vanished").status)
            assertEquals(
                HttpStatusCode.NoContent,
                w.admin.client.putJson("/api/v1/milestones/$changedTeam", MilestoneUpdateRequest("Changes team", null, t.otherTeamId, 1.0))
                    .status,
            )
            val fresh = TestPlan.milestone(p, t.teamId, "Fresh", 1.0)
            TestPlan.schedule(fresh, "2027-02-01", "2027-02-01")

            val view = w.stranger.client.get("${path(p)}?baseline=$id").body<ProjectView>()
            val baseline = assertNotNull(view.baseline)
            assertEquals(id, baseline.id)
            assertEquals(TestPlan.scalar("SELECT name FROM baselines WHERE id = $id") { it.getString(1) }, baseline.name)
            assertEquals(TestPlan.scalar("SELECT plan_revision FROM baselines WHERE id = $id") { it.getLong(1) }, baseline.planRevision)

            // The project's span then 02-01..02-26 and now 02-01..03-02: the end moves by two working days (02-26 Fri -> 03-02 Tue).
            val project = assertNotNull(baseline.project)
            assertEquals("2027-02-01", project.span?.start)
            assertEquals("2027-02-26", project.span?.end)
            assertEquals(MovementKind.MOVED, project.movement.kind)
            assertEquals(0, project.movement.startDays)
            assertEquals(2, project.movement.endDays)

            val entries = baseline.milestones.associateBy { it.milestoneId }
            assertEquals(setOf(moved, steady, tray, changedTeam), entries.keys, "frozen live milestones; the fresh one has no entry")
            assertEquals(MovementKind.MOVED, entries.getValue(moved).movement.kind)
            assertEquals(5, entries.getValue(moved).movement.startDays)
            assertEquals("2027-02-01", entries.getValue(moved).start)
            assertEquals(4.0, entries.getValue(moved).estimateMd)
            assertEquals(MovementKind.UNCHANGED, entries.getValue(steady).movement.kind)
            assertEquals(MovementKind.SCHEDULED, entries.getValue(tray).movement.kind)
            assertNull(entries.getValue(tray).start, "the tray milestone was unscheduled then")
            assertEquals(t.teamId, entries.getValue(changedTeam).teamIdThen)
            assertEquals(MovementKind.UNCHANGED, entries.getValue(changedTeam).movement.kind)

            val removed = baseline.removed.single()
            assertEquals(vanished, removed.milestoneId)
            assertEquals("Vanished", removed.name)
            assertEquals(p, removed.projectId)
            assertEquals(t.teamId, removed.teamId)
            assertTrue(removed.teamName.isNotBlank())
            assertEquals(3.5, removed.estimateMd)
            assertEquals("2027-02-15" to "2027-02-17", removed.start to removed.end)
            assertNull(removed.now)

            w.stranger.client.assertOverlayIsAdditive(path(p), id)
        } finally {
            TestPlan.deleteBaseline(id)
        }
    }

    @Test
    fun `a project newer than the baseline has no project block and no entries`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvbn", teams = true)
        val id = TestPlan.baseline(planName("pvbn"))
        try {
            val newer = TestPlan.project(w.programId, w.projectOwner.personId!!, planName("pj-newer"))
            TestPlan.schedule(TestPlan.milestone(newer, w.requireTeams().teamId), "2027-02-01", "2027-02-05")
            val baseline = assertNotNull(w.stranger.client.get("${path(newer)}?baseline=$id").body<ProjectView>().baseline)
            assertNull(baseline.project)
            assertEquals(emptyList(), baseline.milestones)
            assertEquals(emptyList(), baseline.removed)
        } finally {
            TestPlan.deleteBaseline(id)
        }
    }

    @Test
    fun `the parameter is refused with 400 - malformed, repeated, unknown, deleted - and a gone project is 404 first`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvbr")
        w.stranger.client.assertBaselineParameterRejected(path(w.projectId))
        val gone = TestPlan.project(w.programId, w.projectOwner.personId!!)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/$gone").status)
        assertEquals(HttpStatusCode.NotFound, w.stranger.client.get("${path(gone)}?baseline=999999").status, "the view's own rule first")
        assertEquals(HttpStatusCode.NotFound, w.stranger.client.get("${path(999_999u)}?baseline=999999").status)
        // Without the parameter nothing else is asked.
        assertEquals(HttpStatusCode.OK, w.stranger.client.get(path(w.projectId)).status)
        assertEquals(HttpStatusCode.OK, w.stranger.client.get("${path(w.projectId)}?baseline=").status, "a blank value is no parameter")
    }
}
