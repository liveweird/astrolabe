package ch.nokillswit

import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.planning.BaselineResponse
import ch.nokillswit.planning.BaselineView
import ch.nokillswit.planning.BaselineViewMilestone
import ch.nokillswit.planning.BaselineViewProject
import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.planning.MovementKind
import ch.nokillswit.planning.RankingResponse
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.UNKNOWN_BASELINE_PROBLEM
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/baseline/{id}` (v0.9 C7): the comparison document - every movement kind through the wire on a 2027 world including a
 * holiday, the projects' union (added and removed), the changed-only rule and the orderings, the 404/400/401 rules. The arithmetic is
 * `BaselineKernelsTest`'s. 2027-02-01 and 2027-03-01 are Mondays. A baseline copies the WHOLE shared plan, so every assertion is
 * anchored on this test's own rows. `?against=N` (1.7 C8) compares two baselines: the same document with "now" read from N's frozen
 * rows, the inverse order, and the 400/404 rules of the new parameter.
 */
class BaselineViewTest {
    private fun path(id: UInt) = "/api/v1/views/baseline/$id"

    private suspend fun HttpClient.compare(id: UInt): BaselineView = get(path(id)).body()

    private fun BaselineView.project(id: UInt): BaselineViewProject = projects.single { it.projectId == id }

    private fun BaselineView.milestone(id: UInt): BaselineViewMilestone = milestones.single { it.milestoneId == id }

    @Test
    fun `unauthenticated requests are 401`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(path(1u)).status)
    }

    @Test
    fun `an unknown or deleted baseline is 404 for every caller, a malformed id is 400, and a deleted one keeps its frozen rows`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bvn", teams = true)
            TestPlan.milestone(w.projectId, w.requireTeams().teamId)
            val id = TestPlan.baseline(planName("bvn"))
            val frozen = TestPlan.scalar("SELECT count(*) FROM baseline_milestones WHERE baseline_id = $id") { it.getInt(1) }
            try {
                for ((label, caller) in w.outsiders + ("admin" to w.admin) + ("owner" to w.projectOwner)) {
                    assertEquals(HttpStatusCode.OK, caller.client.get(path(id)).status, "a reader: $label")
                    assertEquals(HttpStatusCode.NotFound, caller.client.get(path(999_999u)).status, "unknown: $label")
                }
                assertEquals(HttpStatusCode.BadRequest, w.stranger.client.get("/api/v1/views/baseline/not-a-number").status)
                assertEquals(HttpStatusCode.BadRequest, w.stranger.client.get("/api/v1/views/baseline/-1").status)
                assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/baselines/$id").status)
                for ((label, caller) in w.outsiders + ("admin" to w.admin)) {
                    assertEquals(HttpStatusCode.NotFound, caller.client.get(path(id)).status, "deleted: $label")
                }
                assertTrue(frozen > 0)
                assertEquals(
                    frozen,
                    TestPlan.scalar("SELECT count(*) FROM baseline_milestones WHERE baseline_id = $id") { it.getInt(1) },
                    "the frozen rows stay for a soft-deleted baseline",
                )
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    @Test
    fun `right after taking it nothing has moved - the revision equals the baseline's and our project reads all unchanged`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bvz", teams = true)
            val t = w.requireTeams()
            val a = TestPlan.milestone(w.projectId, t.teamId, planName("a"), 4.0)
            val b = TestPlan.milestone(w.projectId, t.otherTeamId, planName("b"), 2.5)
            TestPlan.milestone(w.projectId, t.teamId, planName("tray"), 1.0)
            TestPlan.schedule(a, "2027-02-01", "2027-02-05")
            TestPlan.schedule(b, "2027-02-08", "2027-02-09")
            val id = TestPlan.baseline(planName("bvz"))
            try {
                val view = w.stranger.client.compare(id)
                val baseline = w.stranger.client.get("/api/v1/baselines/$id").body<BaselineResponse>()
                assertEquals(baseline, view.baseline)
                assertEquals(baseline.planRevision, view.revision, "the plan equals the baseline at that revision")
                val ours = view.project(w.projectId)
                assertEquals(MovementKind.UNCHANGED, ours.movement.kind)
                assertEquals(ours.baselineSpan, ours.span)
                assertEquals(3, ours.counts.unchanged)
                val c = ours.counts
                assertEquals(0, c.moved + c.added + c.removed + c.scheduled + c.unscheduled)
                assertTrue(view.milestones.none { it.projectId == w.projectId }, "unchanged rows are not listed")
                assertEquals(view.projects.size, view.totals.projects.unchanged, "every project is unchanged")
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    @Test
    fun `every kind of movement through the wire - working days, added and removed projects, changed-only rows and their order`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bvk", teams = true)
            val t = w.requireTeams()
            val owner = w.projectOwner.personId!!
            val p = w.projectId
            val moved = TestPlan.milestone(p, t.teamId, "Moved", 10.0)
            val steady = TestPlan.milestone(p, t.teamId, "Steady", 3.0)
            val reestimated = TestPlan.milestone(p, t.teamId, "Reestimated", 5.0)
            val dropped = TestPlan.milestone(p, t.teamId, "Dropped", 2.0)
            val tray = TestPlan.milestone(p, t.otherTeamId, "Tray", 2.0)
            val vanished = TestPlan.milestone(p, t.teamId, "Vanished", 1.0)
            val removedProject = TestPlan.project(w.programId, owner, planName("pj-r"))
            val removedProjectMilestone = TestPlan.milestone(removedProject, t.teamId, "R-ms", 3.0)
            TestPlan.schedule(moved, "2027-02-01", "2027-02-05")
            TestPlan.schedule(steady, "2027-02-08", "2027-02-12")
            TestPlan.schedule(reestimated, "2027-02-15", "2027-02-19")
            TestPlan.schedule(dropped, "2027-02-22", "2027-02-26")
            TestPlan.schedule(vanished, "2027-02-01", "2027-02-02")
            TestPlan.schedule(removedProjectMilestone, "2027-03-01", "2027-03-05")
            val id = TestPlan.baseline(planName("bvk"))
            try {
                // The plan moves on after the baseline.
                TestPlan.schedule(moved, "2027-02-08", "2027-02-12")
                assertEquals(
                    HttpStatusCode.NoContent,
                    w.admin.client.putJson("/api/v1/milestones/$reestimated", MilestoneUpdateRequest("Reestimated", null, t.teamId, 7.5))
                        .status,
                )
                TestPlan.schedule(dropped, null, null)
                TestPlan.schedule(tray, "2027-03-01", "2027-03-05")
                assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$vanished").status)
                val added = TestPlan.milestone(p, t.otherTeamId, "Added", 4.0)
                TestPlan.schedule(added, "2027-02-01", "2027-02-05")
                val newProject = TestPlan.project(w.programId, owner, planName("pj-q"))
                val newProjectMilestone = TestPlan.milestone(newProject, t.teamId, "Q-ms", 1.0)
                assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$removedProject").status)

                val view = TestHolidays.with("2027-02-03") { w.stranger.client.compare(id) }
                // Moved: Mon 02-01..Fri 02-05 -> Mon 02-08..Fri 02-12 with Wed 02-03 a holiday: start +4, end +5 (the hand-counted vector).
                val movedRow = view.milestone(moved)
                assertEquals(MovementKind.MOVED, movedRow.movement.kind)
                assertEquals(4, movedRow.movement.startDays)
                assertEquals(5, movedRow.movement.endDays)
                assertEquals(0.0, movedRow.movement.estimateDelta)
                assertEquals("2027-02-01", movedRow.frozen?.start)
                assertEquals("2027-02-08", movedRow.live?.start)
                assertEquals("Moved", movedRow.name)
                assertEquals(t.teamId, movedRow.teamId)
                assertTrue(movedRow.teamName.isNotBlank())
                // An estimate change alone: kind UNCHANGED, but the row is listed with the delta.
                val estimated = view.milestone(reestimated)
                assertEquals(MovementKind.UNCHANGED, estimated.movement.kind)
                assertEquals(2.5, estimated.movement.estimateDelta)
                assertEquals(5.0, estimated.frozen?.estimateMd)
                assertEquals(7.5, estimated.live?.estimateMd)
                assertEquals(MovementKind.UNSCHEDULED, view.milestone(dropped).movement.kind)
                assertNull(view.milestone(dropped).live?.start)
                assertEquals("2027-02-22", view.milestone(dropped).frozen?.start)
                assertEquals(MovementKind.SCHEDULED, view.milestone(tray).movement.kind)
                assertNull(view.milestone(tray).frozen?.start)
                assertEquals(t.otherTeamId, view.milestone(tray).teamId)
                val gone = view.milestone(vanished)
                assertEquals(MovementKind.REMOVED, gone.movement.kind)
                assertNull(gone.live)
                assertNotNull(gone.frozen)
                val fresh = view.milestone(added)
                assertEquals(MovementKind.ADDED, fresh.movement.kind)
                assertNull(fresh.frozen)
                assertNotNull(fresh.live)
                assertTrue(view.milestones.none { it.milestoneId == steady }, "an unchanged milestone is not listed")
                assertEquals(MovementKind.REMOVED, view.milestone(removedProjectMilestone).movement.kind)
                assertEquals(MovementKind.ADDED, view.milestone(newProjectMilestone).movement.kind)
                // The order: the projects' order, then start (live, else frozen), end, name, id.
                val ours = view.milestones.filter { it.projectId == p }.map { it.milestoneId }
                assertEquals(listOf(vanished, added, moved, reestimated, dropped, tray), ours)

                // The projects: counts over EVERY milestone row, the union of both sides.
                val project = view.project(p)
                assertEquals(1 + 1, project.counts.unchanged, "steady and the re-estimated one")
                assertEquals(1, project.counts.moved)
                assertEquals(1, project.counts.later)
                assertEquals(0, project.counts.earlier)
                assertEquals(1, project.counts.scheduled)
                assertEquals(1, project.counts.unscheduled)
                assertEquals(1, project.counts.added)
                assertEquals(1, project.counts.removed)
                // Span 02-01..02-26 then, 02-01..03-05 now: the end is 02-26 -> 03-05, five working days.
                assertEquals("2027-02-01", project.baselineSpan?.start)
                assertEquals("2027-02-26", project.baselineSpan?.end)
                assertEquals("2027-03-05", project.span?.end)
                assertEquals(MovementKind.MOVED, project.movement.kind)
                assertEquals(0, project.movement.startDays)
                assertEquals(5, project.movement.endDays)
                val removed = view.project(removedProject)
                assertEquals(MovementKind.REMOVED, removed.movement.kind)
                assertNull(removed.span)
                assertEquals("2027-03-01", removed.baselineSpan?.start)
                assertEquals(1, removed.counts.removed)
                val newer = view.project(newProject)
                assertEquals(MovementKind.ADDED, newer.movement.kind)
                assertNull(newer.baselineSpan)
                assertNull(newer.rankThen)
                assertEquals(1, newer.counts.added)
                val order = view.projects.filter { it.projectId in setOf(p, removedProject, newProject) }
                assertEquals(
                    order.sortedWith(compareBy({ it.name.lowercase() }, { it.projectId })).map { it.projectId },
                    order.map { it.projectId },
                    "one program: the projects are by name",
                )
                // The totals cover the whole plan: ours are inside them.
                assertTrue(view.totals.milestones.moved >= 1 && view.totals.milestones.later >= 1)
                assertTrue(view.totals.milestones.added >= 2 && view.totals.milestones.removed >= 2)
                assertTrue(view.totals.projects.added >= 1 && view.totals.projects.removed >= 1)
                val projectTotals = view.totals.projects
                assertEquals(
                    view.projects.size,
                    projectTotals.unchanged + projectTotals.moved + projectTotals.scheduled + projectTotals.unscheduled +
                        projectTotals.added + projectTotals.removed,
                )
                // On the plain calendar the same move is (+5, +5).
                val plain = w.stranger.client.compare(id).milestone(moved)
                assertEquals(5, plain.movement.startDays)
                assertEquals(5, plain.movement.endDays)
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    private suspend fun HttpClient.rank(ids: List<UInt>): Long =
        putJson("/api/v1/roadmap/ranking", RankingUpdateRequest(TestPlan.revision(), ids)).body<RankingResponse>().revision

    private suspend fun HttpClient.compare(id: UInt, against: UInt): BaselineView = get("${path(id)}?against=$against").body()

    /** The two-baseline world: A, one re-plan (the "first" below), B, a second re-plan only the live comparison sees. */
    private class TwoBaselines(
        val a: UInt, val b: UInt, val moved: UInt, val dropped: UInt, val added: UInt, val steady: UInt,
        val project: UInt, val removedProject: UInt, val newProject: UInt, val removedMs: UInt, val newMs: UInt, val dropTeam: UInt,
    )

    private suspend fun twoBaselines(w: PlanWorld, run: suspend (TwoBaselines) -> Unit) {
        val t = w.requireTeams()
        val owner = w.projectOwner.personId!!
        val p = w.projectId
        val dropTeam = TestTeams.seed(planName("bva-team"))
        val moved = TestPlan.milestone(p, t.teamId, "Moved", 4.0)
        val dropped = TestPlan.milestone(p, dropTeam, "Dropped", 2.0)
        val steady = TestPlan.milestone(p, t.teamId, "Steady", 3.0)
        val removedProject = TestPlan.project(w.programId, owner, planName("pj-r"))
        val removedMs = TestPlan.milestone(removedProject, t.teamId, "R-ms", 1.0)
        TestPlan.schedule(moved, "2027-02-01", "2027-02-05")
        TestPlan.schedule(dropped, "2027-02-08", "2027-02-12")
        TestPlan.schedule(steady, "2027-02-15", "2027-02-19")
        TestPlan.schedule(removedMs, "2027-03-01", "2027-03-05")
        w.admin.client.rank(listOf(p, removedProject))
        val a = TestPlan.baseline(planName("bva-a"))
        var b: UInt? = null
        try {
            // The first re-plan: a move, a milestone gone (its team deleted since), one added, a project gone, one new, a re-rank.
            TestPlan.schedule(moved, "2027-02-08", "2027-02-12")
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$dropped").status)
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$dropTeam").status)
            val added = TestPlan.milestone(p, t.otherTeamId, "Added", 1.0)
            TestPlan.schedule(added, "2027-02-22", "2027-02-26")
            assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$removedProject").status)
            val newProject = TestPlan.project(w.programId, owner, planName("pj-n"))
            val newMs = TestPlan.milestone(newProject, t.teamId, "N-ms", 1.0)
            TestPlan.schedule(newMs, "2027-03-01", "2027-03-05")
            w.admin.client.rank(listOf(newProject, p))
            b = TestPlan.baseline(planName("bva-b"))
            // The second re-plan: after B, so only the live comparison sees it.
            TestPlan.schedule(steady, "2027-03-01", "2027-03-05")
            run(TwoBaselines(a, b, moved, dropped, added, steady, p, removedProject, newProject, removedMs, newMs, dropTeam))
        } finally {
            b?.let { TestPlan.deleteBaseline(it) }
            TestPlan.deleteBaseline(a)
        }
    }

    @Test
    fun `against compares two baselines - only the first re-plan, then the inverse signs for the reverse order`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("bva", teams = true)
        twoBaselines(w) { x ->
            val client = w.stranger.client
            val forward = client.compare(x.a, x.b)
            assertEquals(x.a, forward.baseline.id)
            assertEquals(x.b, forward.against?.id, "the second baseline's header rides along")
            assertEquals(forward.baseline.planRevision < forward.against!!.planRevision, true)
            val movedRow = forward.milestone(x.moved)
            assertEquals(MovementKind.MOVED, movedRow.movement.kind)
            assertEquals(5, movedRow.movement.startDays)
            assertEquals(5, movedRow.movement.endDays)
            assertEquals("2027-02-01", movedRow.frozen?.start)
            assertEquals("2027-02-08", movedRow.live?.start, "live = the now side = B's frozen row")
            assertEquals(MovementKind.REMOVED, forward.milestone(x.dropped).movement.kind)
            assertNull(forward.milestone(x.dropped).live)
            assertTrue(forward.milestone(x.dropped).teamName.isNotBlank(), "a team deleted since is still named")
            assertEquals(MovementKind.ADDED, forward.milestone(x.added).movement.kind)
            assertNull(forward.milestone(x.added).frozen)
            assertEquals(MovementKind.REMOVED, forward.milestone(x.removedMs).movement.kind)
            assertEquals(MovementKind.ADDED, forward.milestone(x.newMs).movement.kind)
            assertTrue(forward.milestones.none { it.milestoneId == x.steady }, "B has not seen the second re-plan: unchanged")
            val project = forward.project(x.project)
            assertEquals(1, project.rankThen)
            assertEquals(2, project.rankNow)
            assertEquals(MovementKind.MOVED, project.movement.kind)
            assertEquals("2027-02-01", project.baselineSpan?.start)
            assertEquals("2027-02-08", project.span?.start)
            assertEquals(1, project.counts.moved)
            assertEquals(1, project.counts.added)
            assertEquals(1, project.counts.removed)
            assertEquals(MovementKind.REMOVED, forward.project(x.removedProject).movement.kind)
            assertNull(forward.project(x.removedProject).span)
            assertEquals(MovementKind.ADDED, forward.project(x.newProject).movement.kind)
            assertEquals(1, forward.project(x.newProject).rankNow)
            assertNull(forward.project(x.newProject).rankThen)

            val inverse = client.compare(x.b, x.a)
            assertEquals(x.b, inverse.baseline.id)
            assertEquals(x.a, inverse.against?.id)
            assertEquals(-5, inverse.milestone(x.moved).movement.startDays)
            assertEquals(-5, inverse.milestone(x.moved).movement.endDays)
            assertEquals(MovementKind.ADDED, inverse.milestone(x.dropped).movement.kind)
            assertEquals(MovementKind.REMOVED, inverse.milestone(x.added).movement.kind)
            assertEquals(MovementKind.ADDED, inverse.milestone(x.removedMs).movement.kind)
            assertEquals(MovementKind.REMOVED, inverse.milestone(x.newMs).movement.kind)
            assertEquals(2, inverse.project(x.project).rankThen)
            assertEquals(1, inverse.project(x.project).rankNow)
            assertEquals(MovementKind.ADDED, inverse.project(x.removedProject).movement.kind)
            assertEquals(MovementKind.REMOVED, inverse.project(x.newProject).movement.kind)

            // Totals agree with the rows of both baselines and swap with the order; every project row is counted once.
            val rows = TestPlan.scalar(
                "SELECT count(DISTINCT milestone_id) FROM baseline_milestones WHERE baseline_id IN (${x.a}, ${x.b})",
            ) { it.getInt(1) }
            fun BaselineView.milestoneRows() = totals.milestones.let {
                it.unchanged + it.moved + it.scheduled + it.unscheduled + it.added + it.removed
            }
            assertEquals(rows, forward.milestoneRows())
            assertEquals(rows, inverse.milestoneRows())
            assertEquals(forward.totals.milestones.added, inverse.totals.milestones.removed)
            assertEquals(forward.totals.milestones.removed, inverse.totals.milestones.added)
            assertEquals(forward.totals.milestones.later, inverse.totals.milestones.earlier)
            val projectRows = TestPlan.scalar(
                "SELECT count(DISTINCT project_id) FROM baseline_projects WHERE baseline_id IN (${x.a}, ${x.b})",
            ) { it.getInt(1) }
            assertEquals(projectRows, forward.projects.size)
            assertEquals(forward.projects.map { it.projectId }.toSet(), inverse.projects.map { it.projectId }.toSet())

            // The live comparison sees the second re-plan too; the path baseline alone decides the "then" side.
            val live = client.compare(x.a)
            assertNull(live.against)
            assertEquals(MovementKind.MOVED, live.milestone(x.steady).movement.kind)
        }
    }

    @Test
    fun `without against the document carries no against key and is the comparison with the live plan`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("bvq", teams = true)
        TestPlan.milestone(w.projectId, w.requireTeams().teamId)
        val id = TestPlan.baseline(planName("bvq"))
        try {
            val plain = w.stranger.client.rawJson(path(id)) as JsonObject
            assertFalse("against" in plain, "absent, not null")
            val other = TestPlan.baseline(planName("bvq-o"))
            try {
                val both = w.stranger.client.rawJson("${path(id)}?against=$other") as JsonObject
                assertTrue("against" in both, "present for ?against=N")
                assertEquals(plain.keys + "against", both.keys, "the parameter only adds the against key")
            } finally {
                TestPlan.deleteBaseline(other)
            }
        } finally {
            TestPlan.deleteBaseline(id)
        }
    }

    @Test
    fun `against is a 400 when malformed, repeated, itself, unknown or deleted - and a gone path baseline stays 404`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bvr", teams = true)
            TestPlan.milestone(w.projectId, w.requireTeams().teamId)
            val id = TestPlan.baseline(planName("bvr"))
            val other = TestPlan.baseline(planName("bvr-o"))
            val doomed = TestPlan.baseline(planName("bvr-d"))
            try {
                val client = w.stranger.client
                assertEquals(HttpStatusCode.OK, client.get("${path(id)}?against=$other").status)
                for (malformed in listOf("abc", "-1", "1.5", "99999999999", "$other&against=$id")) {
                    val response = client.get("${path(id)}?against=$malformed")
                    assertEquals(HttpStatusCode.BadRequest, response.status, "?against=$malformed")
                    assertEquals("about:blank", response.body<ProblemDetail>().type, "?against=$malformed is a plain 400")
                }
                val self = client.get("${path(id)}?against=$id")
                assertEquals(HttpStatusCode.BadRequest, self.status)
                assertEquals("about:blank", self.body<ProblemDetail>().type)
                assertEquals("A baseline cannot be compared with itself", self.body<ProblemDetail>().detail)
                val unknown = client.get("${path(id)}?against=999999")
                assertEquals(HttpStatusCode.BadRequest, unknown.status)
                assertEquals(UNKNOWN_BASELINE_PROBLEM, unknown.body<ProblemDetail>().type)
                assertEquals("Unknown or deleted baseline id: 999999", unknown.body<ProblemDetail>().detail)
                assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/baselines/$doomed").status)
                val gone = client.get("${path(id)}?against=$doomed")
                assertEquals(HttpStatusCode.BadRequest, gone.status, "a soft-deleted baseline")
                assertEquals(UNKNOWN_BASELINE_PROBLEM, gone.body<ProblemDetail>().type)
                // The path baseline's own 404 comes before any question about `against`.
                for (question in listOf("999998", "999999", "$other", "$doomed")) {
                    assertEquals(HttpStatusCode.NotFound, client.get("${path(999_999u)}?against=$question").status, "against=$question")
                }
                assertEquals(HttpStatusCode.NotFound, client.get("${path(doomed)}?against=$id").status, "a deleted path baseline")
                assertEquals(HttpStatusCode.NotFound, client.get("${path(doomed)}?against=$doomed").status)
            } finally {
                TestPlan.deleteBaseline(other)
                TestPlan.deleteBaseline(id)
                TestPlan.deleteBaseline(doomed)
            }
        }
}
