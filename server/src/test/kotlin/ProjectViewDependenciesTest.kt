package ch.nokillswit

import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.ProjectDependency
import ch.nokillswit.planning.ProjectView
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The `dependencies` of `GET /views/project/{id}` (v0.4.0): every active link with an end in the project, both ends resolved (the
 * external ones with their own project's name, team and dates; a project end with its DERIVED span, never its target window), the pure
 * check (the first vector per type over HTTP; the table is in [DependencyKernelsTest]), the violated-first order, an unscheduled end
 * answering UNSCHEDULED without a warning, and the two flags against the real writes. 2027-02-01 is a Monday.
 */
class ProjectViewDependenciesTest {
    private suspend fun PlanCaller.view(projectId: UInt): ProjectView = client.get("/api/v1/views/project/$projectId").body()

    private fun ProjectView.link(id: UInt): ProjectDependency = dependencies.single { it.id == id }

    @Test
    fun `a view without links answers an empty list`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvd0")
        assertTrue(w.stranger.view(w.projectId).dependencies.isEmpty())
    }

    @Test
    fun `a cross-project link shows on both projects with resolved ends and its check - violated after the successor is dragged early`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pvd1", teams = true)
            val t = w.requireTeams()
            val b = secondProject(w, "pvd1")
            val a1 = TestPlan.milestone(w.projectId, t.teamId, "a1")
            val b1 = TestPlan.milestone(b.projectId, t.otherTeamId, "b1")
            TestPlan.schedule(a1, "2027-02-01", "2027-02-05")
            TestPlan.schedule(b1, "2027-02-08", "2027-02-12")
            val link = TestPlan.dependency(milestoneRef(a1), milestoneRef(b1), DependencyType.FS, 0)
            val aName = w.stranger.view(w.projectId).project.name
            val bName = w.stranger.view(b.projectId).project.name

            for (projectId in listOf(b.projectId, w.projectId)) {
                val dep = w.stranger.view(projectId).link(link)
                assertEquals(DependencyType.FS, dep.type)
                assertEquals(0, dep.lagDays)
                assertEquals(EndpointKind.MILESTONE, dep.predecessor.kind)
                assertEquals(a1, dep.predecessor.id)
                assertEquals("a1", dep.predecessor.name)
                assertEquals(w.projectId, dep.predecessor.projectId)
                assertEquals(aName, dep.predecessor.projectName, "the external end names its own project")
                assertEquals(t.teamId, dep.predecessor.teamId)
                assertEquals("2027-02-01" to "2027-02-05", dep.predecessor.startDate to dep.predecessor.endDate)
                assertEquals(b1, dep.successor.id)
                assertEquals(bName, dep.successor.projectName)
                assertEquals("2027-02-08" to "2027-02-12", dep.successor.startDate to dep.successor.endDate)
                assertEquals(DependencyStatus.OK, dep.check.status)
                assertNull(dep.check.shortfallDays)
                assertEquals("2027-02-08" to "2027-02-08", dep.check.requiredDate to dep.check.actualDate)
            }

            // The manager drags b1 two working weeks early: a warning, never a move.
            TestPlan.schedule(b1, "2027-01-25", "2027-01-29")
            for (projectId in listOf(b.projectId, w.projectId)) {
                val check = w.stranger.view(projectId).link(link).check
                assertEquals(DependencyStatus.VIOLATED, check.status)
                assertEquals(10, check.shortfallDays)
                assertEquals("2027-02-08" to "2027-01-25", check.requiredDate to check.actualDate)
            }
        }

    @Test
    fun `the first vector per type over HTTP - one working day short`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvd2", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "pvd2")
        val a = TestPlan.milestone(w.projectId, t.teamId, "a")
        TestPlan.schedule(a, "2027-02-01", "2027-02-05")
        // type -> the successor's span that is one working day short, and the required/actual dates of the check
        val vectors = mapOf(
            DependencyType.FS to Triple("2027-02-05" to "2027-02-12", "2027-02-08", "2027-02-05"),
            DependencyType.SS to Triple("2027-01-29" to "2027-02-12", "2027-02-01", "2027-01-29"),
            DependencyType.FF to Triple("2027-02-02" to "2027-02-04", "2027-02-05", "2027-02-04"),
            DependencyType.SF to Triple("2027-01-25" to "2027-01-28", "2027-01-29", "2027-01-28"),
        )
        for ((type, vector) in vectors) {
            val succ = TestPlan.milestone(b.projectId, t.teamId, "b-$type")
            TestPlan.schedule(succ, vector.first.first, vector.first.second)
            val link = TestPlan.dependency(milestoneRef(a), milestoneRef(succ), type, 0)
            val check = w.stranger.view(b.projectId).link(link).check
            assertEquals(DependencyStatus.VIOLATED, check.status, "$type")
            assertEquals(1, check.shortfallDays, "$type")
            assertEquals(vector.second to vector.third, check.requiredDate to check.actualDate, "$type")
        }
    }

    @Test
    fun `a holiday moves the needs date of an FS link and counts in a lag - the check reverts when it is removed`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvdh", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "pvdh")
        val a1 = TestPlan.milestone(w.projectId, t.teamId, "a1")
        val b1 = TestPlan.milestone(b.projectId, t.teamId, "b1")
        val b2 = TestPlan.milestone(b.projectId, t.teamId, "b2")
        // a1 ends Friday 2027-02-05. b1 starts the Monday after (FS, no lag); b2 starts Wednesday 02-10 (FS lag 2: exactly met).
        TestPlan.schedule(a1, "2027-02-01", "2027-02-05")
        TestPlan.schedule(b1, "2027-02-08", "2027-02-12")
        TestPlan.schedule(b2, "2027-02-10", "2027-02-12")
        val plain = TestPlan.dependency(milestoneRef(a1), milestoneRef(b1))
        val lagged = TestPlan.dependency(milestoneRef(a1), milestoneRef(b2), DependencyType.FS, 2)
        val before = w.stranger.view(w.projectId)
        assertEquals("2027-02-08", before.link(plain).check.requiredDate)
        assertEquals(DependencyStatus.OK, before.link(plain).check.status)
        assertEquals("2027-02-10", before.link(lagged).check.requiredDate)
        assertEquals(DependencyStatus.OK, before.link(lagged).check.status)

        // Monday 02-08 is a holiday: the "needs" date moves to the next working day (Tuesday) and b1, whose effective start is that same
        // Tuesday, still meets it; the lag now spends one of its two days on the holiday, so b2 is one working day short.
        TestHolidays.with("2027-02-08") {
            val held = w.stranger.view(w.projectId)
            assertEquals("2027-02-09", held.link(plain).check.requiredDate, "the holiday is skipped")
            assertEquals(DependencyStatus.OK, held.link(plain).check.status)
            assertEquals("2027-02-11", held.link(lagged).check.requiredDate, "lag 2 counts the working days of the calendar")
            assertEquals(DependencyStatus.VIOLATED, held.link(lagged).check.status)
            assertEquals(1, held.link(lagged).check.shortfallDays)
        }
        val after = w.stranger.view(w.projectId)
        assertEquals("2027-02-08", after.link(plain).check.requiredDate)
        assertEquals(DependencyStatus.OK, after.link(lagged).check.status)
    }

    @Test
    fun `violated first with the largest shortfall first, then OK, then unscheduled - names case-insensitive within a group`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pvd3", teams = true)
            val t = w.requireTeams()
            val pred = TestPlan.milestone(w.projectId, t.teamId, "pred")
            TestPlan.schedule(pred, "2027-02-01", "2027-02-05")
            // FS lag 0 needs a start on 2027-02-08; the shortfall is the working days before it.
            val successors = listOf(
                "OK-a" to ("2027-02-08" to "2027-02-12"),
                "ok-b" to ("2027-02-09" to "2027-02-12"),
                "alpha-v1" to ("2027-02-05" to "2027-02-12"),
                "Bravo-v1" to ("2027-02-05" to "2027-02-12"),
                "mid-v2" to ("2027-02-04" to "2027-02-12"),
                "zeta-v10" to ("2027-01-25" to "2027-01-29"),
                "unsched" to null,
            )
            for ((name, dates) in successors) {
                val id = TestPlan.milestone(w.projectId, t.teamId, name)
                if (dates != null) TestPlan.schedule(id, dates.first, dates.second)
                TestPlan.dependency(milestoneRef(pred), milestoneRef(id))
            }
            val ordered = w.stranger.view(w.projectId).dependencies
            assertEquals(
                listOf("zeta-v10", "mid-v2", "alpha-v1", "Bravo-v1", "OK-a", "ok-b", "unsched"),
                ordered.map { it.successor.name },
            )
            assertEquals(
                listOf(10, 2, 1, 1, null, null, null),
                ordered.map { it.check.shortfallDays },
            )
            assertEquals(
                List(4) { DependencyStatus.VIOLATED } + List(2) { DependencyStatus.OK } + DependencyStatus.UNSCHEDULED,
                ordered.map { it.check.status },
            )
        }

    @Test
    fun `a project end carries its derived span not its target window, and an unscheduled end is UNSCHEDULED without dates or warning`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pvd4", teams = true)
            val t = w.requireTeams()
            val a1 = TestPlan.milestone(w.projectId, t.teamId, "a1")
            val tray = TestPlan.milestone(w.projectId, t.teamId, "tray")
            TestPlan.schedule(a1, "2027-02-22", "2027-02-26")
            // A project with a target window far from its real span, and one with nothing scheduled at all.
            val windowed = TestPlan.project(w.programId, w.projectOwner.personId!!, targetStart = "2027-06-01", targetEnd = "2027-06-30")
            for ((name, dates) in listOf("w1" to ("2027-02-08" to "2027-02-10"), "w2" to ("2027-02-15" to "2027-02-19"))) {
                val id = TestPlan.milestone(windowed, t.teamId, name)
                TestPlan.schedule(id, dates.first, dates.second)
            }
            val empty = TestPlan.project(w.programId, w.projectOwner.personId)
            TestPlan.milestone(empty, t.teamId, "only-tray")

            val fromProject = TestPlan.dependency(projectRef(windowed), milestoneRef(a1))
            val fromEmptyProject = TestPlan.dependency(projectRef(empty), milestoneRef(a1), DependencyType.SS)
            val intoTray = TestPlan.dependency(milestoneRef(a1), milestoneRef(tray))
            val view = w.stranger.view(w.projectId)

            val project = view.link(fromProject)
            assertEquals(EndpointKind.PROJECT, project.predecessor.kind)
            assertEquals(windowed, project.predecessor.projectId)
            assertNull(project.predecessor.teamId)
            assertNull(project.predecessor.teamName)
            assertEquals("2027-02-08" to "2027-02-19", project.predecessor.startDate to project.predecessor.endDate)
            // FS: the working day after the derived span's Friday end, 2027-02-22, is where a1 starts.
            assertEquals(DependencyStatus.OK, project.check.status)
            assertEquals("2027-02-22", project.check.requiredDate)

            for (id in listOf(fromEmptyProject, intoTray)) {
                val check = view.link(id).check
                assertEquals(DependencyStatus.UNSCHEDULED, check.status)
                assertNull(check.shortfallDays)
                assertNull(check.requiredDate)
                assertNull(check.actualDate)
            }
            assertNull(view.link(fromEmptyProject).predecessor.startDate)
            assertNull(view.link(fromEmptyProject).predecessor.endDate)
        }

    @Test
    fun `links at the project itself appear, an unrelated link and a deleted one do not`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvd5", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "pvd5")
        val c = secondProject(w, "pvd5c")
        val a1 = TestPlan.milestone(w.projectId, t.teamId, "a1")
        val b1 = TestPlan.milestone(b.projectId, t.teamId, "b1")
        val c1 = TestPlan.milestone(c.projectId, t.teamId, "c1")
        val c2 = TestPlan.milestone(c.projectId, t.teamId, "c2")
        val intoProject = TestPlan.dependency(milestoneRef(b1), projectRef(w.projectId))
        val fromProject = TestPlan.dependency(projectRef(w.projectId), milestoneRef(c2))
        val unrelated = TestPlan.dependency(milestoneRef(c1), milestoneRef(c2))
        val doomed = TestPlan.dependency(milestoneRef(a1), milestoneRef(c1))
        assertEquals(setOf(intoProject, fromProject, doomed), w.stranger.view(w.projectId).dependencies.map { it.id }.toSet())
        assertEquals(setOf(intoProject), w.stranger.view(b.projectId).dependencies.map { it.id }.toSet())
        assertEquals(setOf(fromProject, unrelated, doomed), w.stranger.view(c.projectId).dependencies.map { it.id }.toSet())

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/dependencies/$doomed").status)
        assertEquals(setOf(intoProject, fromProject), w.stranger.view(w.projectId).dependencies.map { it.id }.toSet())
    }

    /** What a caller may do, seen from project A: create into A, delete a link into A, delete a link into B (predecessor in A). */
    private data class LinkRights(val create: Boolean, val deleteIntoA: Boolean, val deleteIntoB: Boolean)

    @Test
    fun `createDependency and each link's delete are set exactly where the real writes let the caller through`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvd6", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "pvd6")
        val aTarget = TestPlan.milestone(w.projectId, t.teamId, "a-target")
        val bTarget = TestPlan.milestone(b.projectId, t.teamId, "b-target")
        // caller -> may create into A; may delete a link whose successor is in A; may delete one whose successor is in B (shown on A)
        val expected = listOf(
            "admin" to (w.admin to LinkRights(true, true, true)),
            "stream owner" to (w.streamOwner to LinkRights(true, true, true)),
            "program owner" to (w.programOwner to LinkRights(true, true, true)),
            "A's project owner" to (w.projectOwner to LinkRights(true, true, false)),
            "B's project owner" to (b.owner to LinkRights(false, false, true)),
            "team manager" to (t.manager to LinkRights(false, false, false)),
            "other manager" to (t.otherManager to LinkRights(false, false, false)),
            "stranger" to (w.stranger to LinkRights(false, false, false)),
            "person-less" to (w.personless to LinkRights(false, false, false)),
            "roadmap editor" to (w.editor to LinkRights(false, false, false)),
        )
        for ((label, entry) in expected) {
            val (caller, rights) = entry
            // Two fresh links seen from A: B's milestone -> A's (successor in A), and A's -> B's (successor in B, predecessor in A).
            val intoA = TestPlan.dependency(milestoneRef(TestPlan.milestone(b.projectId, t.teamId)), milestoneRef(aTarget))
            val intoB = TestPlan.dependency(milestoneRef(TestPlan.milestone(w.projectId, t.teamId)), milestoneRef(bTarget))
            val view = caller.view(w.projectId)
            assertEquals(rights.create, view.project.can.createDependency, "$label: createDependency")
            assertEquals(rights.deleteIntoA, view.link(intoA).can.delete, "$label: delete a link into A")
            assertEquals(rights.deleteIntoB, view.link(intoB).can.delete, "$label: delete a link into B")

            // The real writes agree.
            val created = caller.client.postDependency(
                w.projectId,
                milestoneRef(TestPlan.milestone(b.projectId, t.teamId)),
                projectRef(w.projectId),
            )
            assertEquals(if (rights.create) HttpStatusCode.Created else HttpStatusCode.Forbidden, created.status, "$label: POST")
            assertEquals(
                if (rights.deleteIntoA) HttpStatusCode.NoContent else HttpStatusCode.Forbidden,
                caller.client.delete("/api/v1/dependencies/$intoA").status,
                "$label: DELETE into A",
            )
            assertEquals(
                if (rights.deleteIntoB) HttpStatusCode.NoContent else HttpStatusCode.Forbidden,
                caller.client.delete("/api/v1/dependencies/$intoB").status,
                "$label: DELETE into B",
            )
        }
    }
}
