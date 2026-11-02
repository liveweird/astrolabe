package ch.nokillswit

import ch.nokillswit.planning.MovementKind
import ch.nokillswit.planning.RankingResponse
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.RoadmapView
import ch.nokillswit.planning.TargetWindowRequest
import io.ktor.client.HttpClient
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
 * `GET /views/roadmap?baseline=N` (v0.9 C7): each project the baseline also froze carries what it had (derived span, rank position,
 * target window) and its movement, a project newer than the baseline carries nothing, the removed projects are listed once, the 400
 * rules, and the overlay only ADDS keys. The ranking is SHARED state: ours is replaced wholesale first. 2027-02-01 is a Monday.
 */
class RoadmapViewBaselineTest {
    private val path = "/api/v1/views/roadmap"

    private suspend fun HttpClient.rank(ids: List<UInt>): Long =
        putJson("/api/v1/roadmap/ranking", RankingUpdateRequest(TestPlan.revision(), ids)).body<RankingResponse>().revision

    @Test
    fun `a project row carries its span, rank and window then and its movement - new projects none, removed ones are listed`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("rvb", teams = true)
            val team = w.requireTeams().teamId
            val owner = w.projectOwner.personId!!
            val steady = TestPlan.project(w.programId, owner, planName("pj-steady"), "2027-02-01", "2027-02-28")
            val moving = TestPlan.project(w.programId, owner, planName("pj-moving"))
            val doomed = TestPlan.project(w.programId, owner, planName("pj-doomed"))
            TestPlan.schedule(TestPlan.milestone(steady, team), "2027-02-01", "2027-02-05")
            val movingMs = TestPlan.milestone(moving, team)
            TestPlan.schedule(movingMs, "2027-02-08", "2027-02-12")
            TestPlan.schedule(TestPlan.milestone(doomed, team), "2027-02-15", "2027-02-19")
            w.admin.client.rank(listOf(steady, moving, doomed))
            val id = TestPlan.baseline(planName("rvb"))
            try {
                TestPlan.schedule(movingMs, "2027-02-15", "2027-02-19")
                val newer = TestPlan.project(w.programId, owner, planName("pj-newer"))
                TestPlan.schedule(TestPlan.milestone(newer, team), "2027-02-01", "2027-02-05")
                assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$doomed").status)
                w.admin.client.rank(listOf(moving, steady, newer))
                assertEquals(
                    HttpStatusCode.NoContent,
                    w.admin.client.putJson("/api/v1/projects/$steady/target-window", TargetWindowRequest("2027-02-01", "2027-03-31"))
                        .status,
                )

                val view = w.stranger.client.get("$path?baseline=$id").body<RoadmapView>()
                val rows = (view.ranked.map { it.project } + view.unranked).associateBy { it.id }
                val baseline = assertNotNull(view.baseline)
                assertEquals(id, baseline.id)
                assertEquals(TestPlan.scalar("SELECT plan_revision FROM baselines WHERE id = $id") { it.getLong(1) }, baseline.planRevision)

                val movingThen = assertNotNull(rows.getValue(moving).baseline)
                assertEquals("2027-02-08" to "2027-02-12", movingThen.span?.start to movingThen.span?.end)
                assertEquals(MovementKind.MOVED, movingThen.movement.kind)
                assertEquals(5, movingThen.movement.startDays)
                assertEquals(5, movingThen.movement.endDays)
                assertEquals(2, movingThen.rankPosition, "rank then (second); now it is first")
                assertEquals(1, rows.getValue(moving).rankPosition)
                val steadyThen = assertNotNull(rows.getValue(steady).baseline)
                assertEquals(MovementKind.UNCHANGED, steadyThen.movement.kind)
                assertEquals("2027-02-01" to "2027-02-28", steadyThen.targetStart to steadyThen.targetEnd, "the window then")
                assertEquals("2027-03-31", rows.getValue(steady).targetEnd, "the window now")
                assertNull(rows.getValue(newer).baseline, "newer than the baseline: no block")

                val removed = baseline.removedProjects.single { it.projectId == doomed }
                assertEquals("2027-02-15", removed.span?.start)
                assertEquals(rows.getValue(steady).programName, removed.programName)
                assertEquals(rows.getValue(steady).workStreamName, removed.workStreamName)
                assertEquals(false, baseline.removedProjects.any { it.projectId in rows.keys }, "a live project is never 'removed'")

                w.stranger.client.assertOverlayIsAdditive(path, id)
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    @Test
    fun `the parameter is refused with 400 - malformed, repeated, unknown, deleted`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rvbr")
        w.stranger.client.assertBaselineParameterRejected(path)
        assertEquals(HttpStatusCode.OK, w.stranger.client.get(path).status)
    }
}
