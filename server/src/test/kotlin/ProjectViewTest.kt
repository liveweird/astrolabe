package ch.nokillswit

import ch.nokillswit.planning.IdleGapView
import ch.nokillswit.planning.MilestoneCreateRequest
import ch.nokillswit.planning.MilestoneScheduleRequest
import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.planning.ProjectMilestone
import ch.nokillswit.planning.ProjectUpdateRequest
import ch.nokillswit.planning.ProjectView
import ch.nokillswit.planning.TargetWindowRequest
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/project/{id}` (v0.3.0): one project with its milestones for any authenticated caller, the scheduled/unscheduled split and
 * its ordering, the derived span and its drift against the target window, the per-caller `can:{}` flags (checked against the expected
 * rights table AND against what the server really lets through), and the 404 rules. 2026-11-02 is a Monday.
 */
class ProjectViewTest {
    private fun path(projectId: UInt) = "/api/v1/views/project/$projectId"

    private suspend fun PlanCaller.view(projectId: UInt): ProjectView = client.get(path(projectId)).body()

    private fun ProjectView.milestone(id: UInt): ProjectMilestone = (scheduled + unscheduled).single { it.id == id }

    @Test
    fun `unauthenticated requests are 401`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(path(1u)).status)
    }

    @Test
    fun `an unknown, deleted or orphaned project is 404 for every caller and a malformed id is 400`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvn")
        for ((label, caller) in w.outsiders + ("admin" to w.admin)) {
            assertEquals(HttpStatusCode.NotFound, caller.client.get(path(999_999u)).status, label)
        }
        assertEquals(HttpStatusCode.BadRequest, w.stranger.client.get("/api/v1/views/project/not-a-number").status)

        val gone = TestPlan.project(w.programId, w.projectOwner.personId!!)
        assertEquals(HttpStatusCode.OK, w.stranger.client.get(path(gone)).status)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/$gone").status)
        assertEquals(HttpStatusCode.NotFound, w.stranger.client.get(path(gone)).status, "a deleted project")

        // An ancestor that is gone hides the project too (the whole chain is joined active).
        val orphan = TestPlan.project(w.programId, w.projectOwner.personId)
        PostgresTestSupport.connect().use { it.exec("UPDATE programs SET marked_as_deleted = TRUE WHERE id = ?", w.programId.toInt()) }
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get(path(orphan)).status, "a deleted program")
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get(path(w.projectId)).status)

        val w2 = planWorld("pvn2")
        PostgresTestSupport.connect().use { it.exec("UPDATE work_streams SET marked_as_deleted = TRUE WHERE id = ?", w2.streamId.toInt()) }
        assertEquals(HttpStatusCode.NotFound, w2.admin.client.get(path(w2.projectId)).status, "a deleted work stream")
    }

    @Test
    fun `the document carries the project, its names and the revision, and splits and orders the milestones`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvs", teams = true)
        val t = w.requireTeams()
        val project = TestPlan.project(w.programId, w.projectOwner.personId!!, planName("pj"), "2026-11-02", "2026-11-13")
        val zulu = TestPlan.milestone(project, t.teamId, "Zulu", 1.5)
        val alpha = TestPlan.milestone(project, t.otherTeamId, "alpha", 0.25)
        val beta = TestPlan.milestone(project, t.teamId, "Beta", 12.0)
        val delta = TestPlan.milestone(project, t.teamId, "Delta")
        val gone = TestPlan.milestone(project, t.teamId, "gone")
        val zeta = TestPlan.milestone(project, t.teamId, "zeta")
        val aardvark = TestPlan.milestone(project, t.otherTeamId, "Aardvark", 0.0)
        val bravo = TestPlan.milestone(project, t.teamId, "bravo")
        val elsewhere = TestPlan.milestone(w.projectId, t.teamId, "elsewhere")
        TestPlan.schedule(zulu, "2026-11-09", "2026-11-13")
        TestPlan.schedule(alpha, "2026-11-09", "2026-11-13")
        TestPlan.schedule(beta, "2026-11-02", "2026-11-20")
        TestPlan.schedule(delta, "2026-11-09", "2026-11-10")
        TestPlan.schedule(gone, "2026-11-02", "2026-12-31")
        TestPlan.schedule(elsewhere, "2026-10-05", "2026-10-09")
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$gone").status)

        val view = w.stranger.view(project)
        assertEquals(TestPlan.revision(), view.revision)
        assertEquals(listOf(beta, delta, alpha, zulu), view.scheduled.map { it.id }, "by start, then end, then name case-insensitively")
        assertEquals(listOf(aardvark, bravo, zeta), view.unscheduled.map { it.id }, "by name, case-insensitively")
        val listed = (view.scheduled + view.unscheduled).map { it.id }
        assertTrue(gone !in listed && elsewhere !in listed, "deleted and foreign milestones are absent")

        val p = view.project
        assertEquals(project, p.id)
        assertEquals(w.programId, p.programId)
        assertEquals(w.streamId, p.workStreamId)
        assertTrue(p.programName.isNotBlank() && p.workStreamName.isNotBlank() && p.ownerName.isNotBlank())
        assertEquals(w.projectOwner.personId, p.ownerPersonId)
        assertEquals("2026-11-02", p.targetStart)
        assertEquals("2026-11-13", p.targetEnd)

        val first = view.milestone(beta)
        assertEquals(project, first.projectId)
        assertEquals("2026-11-02", first.startDate)
        assertEquals("2026-11-20", first.endDate)
        assertEquals(12.0, first.estimateMd)
        assertEquals(t.teamId, first.teamId)
        assertTrue(first.teamName.isNotBlank())
        assertEquals(t.otherTeamId, view.milestone(alpha).teamId)
        assertTrue(view.milestone(alpha).teamName != first.teamName, "each milestone names its own team")
        assertEquals(0.25, view.milestone(alpha).estimateMd)
        val tray = view.milestone(aardvark)
        assertNull(tray.startDate)
        assertNull(tray.endDate)
        assertEquals(0.0, tray.estimateMd)
        assertNull(tray.description)
    }

    @Test
    fun `the span runs from the earliest start to the latest end and the drift is its signed distance from the target window`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pvd", teams = true)
            val t = w.requireTeams()
            val owner = w.projectOwner.personId!!

            data class Case(val label: String, val window: Pair<String, String>?, val dates: List<Pair<String?, String?>>)
            val cases = listOf(
                Case("empty project with a window", "2026-11-02" to "2026-11-13", emptyList()),
                Case("only unscheduled milestones", "2026-11-02" to "2026-11-13", listOf(null to null)),
                Case("scheduled, no window", null, listOf("2026-11-09" to "2026-11-13")),
                Case("late end", "2026-11-02" to "2026-11-13", listOf("2026-11-02" to "2026-11-13", "2026-11-16" to "2026-11-20")),
                Case(
                    "ahead at both ends",
                    "2026-11-09" to "2026-11-27",
                    listOf("2026-11-04" to "2026-11-10", "2026-11-12" to "2026-11-20"),
                ),
                Case("on target", "2026-11-02" to "2026-11-13", listOf("2026-11-02" to "2026-11-06", "2026-11-09" to "2026-11-13")),
                Case("starts late, ends early", "2026-11-02" to "2026-11-30", listOf("2026-11-09" to "2026-11-23", null to null)),
            )
            val expected = mapOf(
                "empty project with a window" to (null to null),
                "only unscheduled milestones" to (null to null),
                "scheduled, no window" to (("2026-11-09" to "2026-11-13") to null),
                "late end" to (("2026-11-02" to "2026-11-20") to (0L to 7L)),
                "ahead at both ends" to (("2026-11-04" to "2026-11-20") to (-5L to -7L)),
                "on target" to (("2026-11-02" to "2026-11-13") to (0L to 0L)),
                "starts late, ends early" to (("2026-11-09" to "2026-11-23") to (7L to -7L)),
            )
            for (case in cases) {
                val project = TestPlan.project(w.programId, owner, planName("pj"), case.window?.first, case.window?.second)
                for ((index, dates) in case.dates.withIndex()) {
                    val id = TestPlan.milestone(project, t.teamId, "m$index")
                    if (dates.first != null) TestPlan.schedule(id, dates.first, dates.second)
                }
                val view = w.stranger.view(project)
                val (span, drift) = expected.getValue(case.label)
                assertEquals(span, view.span?.let { it.start to it.end }, "${case.label}: span")
                assertEquals(drift, view.drift?.let { it.startDays to it.endDays }, "${case.label}: drift")
            }
        }

    @Test
    fun `can flags per caller - owners manage the project, only ADMIN and the team's manager schedule`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvc", teams = true)
        val t = w.requireTeams()
        val mine = TestPlan.milestone(w.projectId, t.teamId, "mine")
        val theirs = TestPlan.milestone(w.projectId, t.otherTeamId, "theirs")
        TestPlan.schedule(theirs, "2026-11-02", "2026-11-06")

        // caller -> (manage the project and its milestones, edit the target window, schedule team's milestone, schedule other team's)
        data class Rights(val manage: Boolean, val window: Boolean, val scheduleMine: Boolean, val scheduleTheirs: Boolean)
        val expected = mapOf(
            "admin" to (w.admin to Rights(manage = true, window = true, scheduleMine = true, scheduleTheirs = true)),
            "stream owner" to (w.streamOwner to Rights(true, true, scheduleMine = false, scheduleTheirs = false)),
            "program owner" to (w.programOwner to Rights(true, true, false, false)),
            "project owner" to (w.projectOwner to Rights(true, window = false, scheduleMine = false, scheduleTheirs = false)),
            "team manager" to (t.manager to Rights(manage = false, window = false, scheduleMine = true, scheduleTheirs = false)),
            "other team's manager" to (t.otherManager to Rights(false, false, scheduleMine = false, scheduleTheirs = true)),
            "stranger" to (w.stranger to Rights(false, false, false, false)),
            "personless" to (w.personless to Rights(false, false, false, false)),
            "roadmap editor" to (w.editor to Rights(manage = false, window = true, scheduleMine = false, scheduleTheirs = false)),
        )
        for ((label, entry) in expected) {
            val (caller, rights) = entry
            val view = caller.view(w.projectId)
            assertEquals(rights.manage, view.project.can.edit, "$label: project.edit")
            assertEquals(rights.manage, view.project.can.delete, "$label: project.delete")
            assertEquals(rights.manage, view.project.can.createMilestone, "$label: project.createMilestone")
            assertEquals(rights.window, view.project.can.editTargetWindow, "$label: project.editTargetWindow")
            assertEquals(rights.manage, view.milestone(mine).can.edit, "$label: milestone.edit")
            assertEquals(rights.manage, view.milestone(mine).can.delete, "$label: milestone.delete")
            assertEquals(rights.scheduleMine, view.milestone(mine).can.schedule, "$label: schedule the unscheduled own-team milestone")
            assertEquals(rights.scheduleTheirs, view.milestone(theirs).can.schedule, "$label: schedule the scheduled other-team milestone")
        }
    }

    @Test
    fun `a flag is set exactly where the server lets the real write through`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pva", teams = true)
        val t = w.requireTeams()
        val mine = TestPlan.milestone(w.projectId, t.teamId, "mine")
        val theirs = TestPlan.milestone(w.projectId, t.otherTeamId, "theirs")
        TestPlan.schedule(theirs, "2026-11-02", "2026-11-06")
        val everyone = listOf(
            "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner, "project owner" to w.projectOwner,
            "team manager" to t.manager, "other team's manager" to t.otherManager, "stranger" to w.stranger, "personless" to w.personless,
            "editor" to w.editor,
        )
        fun status(allowed: Boolean, ok: HttpStatusCode) = if (allowed) ok else HttpStatusCode.Forbidden
        for ((label, caller) in everyone) {
            val view = caller.view(w.projectId)
            val m = view.milestone(mine)
            // The idempotent rewrites: the same plan fields, and the dates the milestone already has (the null pair for the tray row).
            val sameFields = MilestoneUpdateRequest(m.name, m.description, m.teamId, m.estimateMd)
            assertEquals(
                status(m.can.edit, HttpStatusCode.NoContent),
                caller.client.putJson("/api/v1/milestones/$mine", sameFields).status,
                "$label: milestone edit",
            )
            for (milestone in view.scheduled + view.unscheduled) {
                assertEquals(
                    status(milestone.can.schedule, HttpStatusCode.OK),
                    caller.client.putJson(
                        "/api/v1/milestones/${milestone.id}/schedule",
                        MilestoneScheduleRequest(view.revision, milestone.startDate, milestone.endDate),
                    ).status,
                    "$label: schedule ${milestone.name}",
                )
            }
            assertEquals(
                status(view.project.can.createMilestone, HttpStatusCode.Created),
                caller.client.postJson(
                    "/api/v1/projects/${w.projectId}/milestones",
                    MilestoneCreateRequest(planName("new"), null, t.teamId, 1.0),
                ).status,
                "$label: create a milestone",
            )
            val project = view.project
            assertEquals(
                status(project.can.edit, HttpStatusCode.NoContent),
                caller.client.putJson(
                    "/api/v1/projects/${project.id}",
                    ProjectUpdateRequest(project.name, project.description, project.ownerPersonId),
                ).status,
                "$label: project edit",
            )
            assertEquals(
                status(project.can.editTargetWindow, HttpStatusCode.NoContent),
                caller.client.putJson(
                    "/api/v1/projects/${project.id}/target-window",
                    TargetWindowRequest(project.targetStart, project.targetEnd),
                ).status,
                "$label: target window",
            )
            // A fresh project per caller for the destructive write; its flag is read from ITS view.
            val fresh = TestPlan.project(w.programId, w.projectOwner.personId!!)
            assertEquals(
                status(caller.view(fresh).project.can.delete, HttpStatusCode.NoContent),
                caller.client.delete("/api/v1/projects/$fresh").status,
                "$label: project delete",
            )
            val disposable = TestPlan.milestone(w.projectId, t.teamId, planName("tmp"))
            val canDelete = caller.view(w.projectId).milestone(disposable).can.delete
            assertEquals(
                status(canDelete, HttpStatusCode.NoContent),
                caller.client.delete("/api/v1/milestones/$disposable").status,
                "$label: milestone delete",
            )
        }
        assertFalse(w.projectOwner.view(w.projectId).milestone(mine).can.schedule)
    }

    @Test
    fun `a manager who loses the team - a new manager, none, an unlinked login or a deleted person - loses the schedule flag`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pvm", teams = true)
            val t = w.requireTeams()
            val id = TestPlan.milestone(w.projectId, t.teamId, "m")
            val managerPerson = t.manager.personId!!.toInt()
            val otherPerson = t.otherManager.personId!!.toInt()
            suspend fun flag(caller: PlanCaller) = caller.view(w.projectId).milestone(id).can.schedule
            fun sql(statement: String, vararg ids: Int) = PostgresTestSupport.connect().use { it.exec(statement, *ids) }
            val setManager = "UPDATE teams SET manager_person_id = ? WHERE id = ?"
            assertTrue(flag(t.manager))
            assertFalse(flag(t.otherManager))

            // The team moves to the other manager: the old one loses the flag, the new one gains it.
            sql(setManager, otherPerson, t.teamId.toInt())
            assertFalse(flag(t.manager))
            assertTrue(flag(t.otherManager))

            // The team has no manager at all.
            sql("UPDATE teams SET manager_person_id = NULL WHERE id = ?", t.teamId.toInt())
            assertFalse(flag(t.otherManager))
            assertFalse(flag(t.manager))

            // The first manager is back, then their person loses the login link: the person manages, the user does not.
            sql(setManager, managerPerson, t.teamId.toInt())
            assertTrue(flag(t.manager))
            sql("UPDATE people SET user_id = NULL WHERE id = ?", managerPerson)
            assertFalse(flag(t.manager))

            // The other manager's person is deleted: the login stays valid, the flag goes.
            sql(setManager, otherPerson, t.teamId.toInt())
            assertTrue(flag(t.otherManager))
            sql("UPDATE people SET marked_as_deleted = TRUE WHERE id = ?", otherPerson)
            assertFalse(flag(t.otherManager))
            assertTrue(w.admin.view(w.projectId).milestone(id).can.schedule, "ADMIN always schedules")
        }

    @Test
    fun `moving a milestone to another team moves the schedule flag from one manager to the other and keeps the dates`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pvt", teams = true)
            val t = w.requireTeams()
            val id = TestPlan.milestone(w.projectId, t.teamId, "m")
            TestPlan.schedule(id, "2026-11-02", "2026-11-06")
            assertTrue(t.manager.view(w.projectId).milestone(id).can.schedule)
            assertFalse(t.otherManager.view(w.projectId).milestone(id).can.schedule)

            val before = w.admin.view(w.projectId).milestone(id)
            val moved = MilestoneUpdateRequest(before.name, before.description, t.otherTeamId, before.estimateMd)
            assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.putJson("/api/v1/milestones/$id", moved).status)

            val after = t.manager.view(w.projectId).milestone(id)
            assertEquals(t.otherTeamId, after.teamId)
            assertEquals("2026-11-02" to "2026-11-06", after.startDate to after.endDate, "a team change keeps the dates")
            assertFalse(after.can.schedule, "the old manager no longer schedules it")
            assertTrue(t.otherManager.view(w.projectId).milestone(id).can.schedule, "the new manager inherits the bar")
            assertFalse(w.projectOwner.view(w.projectId).milestone(id).can.schedule)
        }

    @Test
    fun `a schedule write moves the milestone between the lists and the revision by one`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvr", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId, "m")
        val before = w.stranger.view(w.projectId)
        assertEquals(listOf(id), before.unscheduled.map { it.id })
        assertNull(before.span)
        val revision = TestPlan.schedule(id, "2026-11-02", "2026-11-06")
        val after = w.stranger.view(w.projectId)
        assertEquals(revision, after.revision)
        assertEquals(before.revision + 1, after.revision)
        assertEquals(listOf(id), after.scheduled.map { it.id })
        assertTrue(after.unscheduled.isEmpty())
        assertEquals("2026-11-02" to "2026-11-06", after.span?.let { it.start to it.end })
        TestPlan.schedule(id, null, null)
        assertNull(w.stranger.view(w.projectId).span, "unscheduling drops the span again")
    }

    @Test
    fun `idle gaps are the runs of 3 or more working days inside the span that none of the project's own milestones is in progress`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pvi")
            val team = TestTeams.seed(planName("pvi-t"), null)
            val first = TestPlan.milestone(w.projectId, team, "first", 1.0)
            assertEquals(emptyList(), w.stranger.view(w.projectId).idleGaps, "nothing scheduled")
            TestPlan.schedule(first, "2027-02-01", "2027-02-01")
            assertEquals(emptyList(), w.stranger.view(w.projectId).idleGaps, "one milestone")
            // A milestone of ANOTHER project, even of the same team, fills nothing of this project's hole.
            val otherProject = TestPlan.project(w.programId, w.projectOwner.personId!!)
            TestPlan.schedule(TestPlan.milestone(otherProject, team, "elsewhere", 1.0), "2027-02-03", "2027-02-04")
            val last = TestPlan.milestone(w.projectId, team, "last", 1.0)
            TestPlan.schedule(last, "2027-02-09", "2027-02-09")
            // Tue 02-02 .. Mon 02-08 is five working days; the weekend neither counts nor breaks the run.
            assertEquals(listOf(IdleGapView("2027-02-02", "2027-02-08", 5)), w.stranger.view(w.projectId).idleGaps)
            assertEquals(emptyList(), w.stranger.view(otherProject).idleGaps)
            // Moving the last milestone closer shortens the hole below 3 working days (Tue Wed): no gap.
            TestPlan.schedule(last, "2027-02-04", "2027-02-04")
            assertEquals(emptyList(), w.stranger.view(w.projectId).idleGaps)
        }

    @Test
    fun `a holiday shortens an idle gap and a milestone over a holiday-only span leaves its hole open`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvih")
        val team = TestTeams.seed(planName("pvih-t"), null)
        for ((start, end) in listOf("2027-01-04" to "2027-01-04", "2027-01-08" to "2027-01-08")) {
            TestPlan.schedule(TestPlan.milestone(w.projectId, team, "m-$start", 1.0), start, end)
        }
        assertEquals(listOf(IdleGapView("2027-01-05", "2027-01-07", 3)), w.stranger.view(w.projectId).idleGaps, "Tue Wed Thu")
        // Epiphany, Wednesday 2027-01-06: Tue Thu = 2 working days, the gap is gone.
        TestHolidays.with("2027-01-06") { assertEquals(emptyList(), w.stranger.view(w.projectId).idleGaps) }

        // A milestone dated only on a day that later becomes a holiday keeps its dates but covers nothing, so it stops splitting the hole.
        val split = TestPlan.project(w.programId, w.projectOwner.personId!!)
        for ((start, end) in listOf("2027-01-04" to "2027-01-04", "2027-01-06" to "2027-01-06", "2027-01-11" to "2027-01-11")) {
            TestPlan.schedule(TestPlan.milestone(split, team, "s-$start", 1.0), start, end)
        }
        assertEquals(emptyList(), w.stranger.view(split).idleGaps, "Tue | Thu Fri: 1 and 2 working days")
        TestHolidays.with("2027-01-06") {
            assertEquals(listOf(IdleGapView("2027-01-05", "2027-01-08", 3)), w.stranger.view(split).idleGaps, "Tue Thu Fri")
        }
    }

    @Test
    fun `a milestone whose only day became a holiday opens no leading idle gap`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvil")
        val team = TestTeams.seed(planName("pvil-t"), null)
        // A is only on Wed 2027-02-03, B on Tue 02-09: the hole Thu 04..Mon 08 is 3 working days inside the work.
        TestPlan.schedule(TestPlan.milestone(w.projectId, team, "a", 1.0), "2027-02-03", "2027-02-03")
        TestPlan.schedule(TestPlan.milestone(w.projectId, team, "b", 1.0), "2027-02-09", "2027-02-09")
        assertEquals(listOf(IdleGapView("2027-02-04", "2027-02-08", 3)), w.stranger.view(w.projectId).idleGaps)
        // Wed 02-03 a holiday: A keeps its dates (the span still starts there) but is no work, so nothing is idle before B.
        TestHolidays.with("2027-02-03") {
            val held = w.stranger.view(w.projectId)
            assertEquals("2027-02-03", held.span?.start)
            assertEquals(emptyList(), held.idleGaps)
        }
    }
}
