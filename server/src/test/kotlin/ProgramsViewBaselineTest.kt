package ch.nokillswit

import ch.nokillswit.planning.MovementKind
import ch.nokillswit.planning.ProgramsView
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
 * `GET /views/programs?baseline=N` (v0.9 C7): a project row is the roadmap's with its `baseline` block, a program's and a work
 * stream's `baseline` is the roll-up of the frozen spans of their CURRENT projects (present only when one was frozen), the document's
 * `baseline` lists the projects deleted since (with the ids of their program and work stream), the 400 rules, and the overlay only
 * ADDS keys. 2027-02-01 is a Monday.
 */
class ProgramsViewBaselineTest {
    private val path = "/api/v1/views/programs"

    @Test
    fun `programs and work streams roll their projects' frozen spans up and compare them with the live ones`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvbp", teams = true)
        val team = w.requireTeams().teamId
        val owner = w.streamOwner.personId!!
        val projectOwner = w.projectOwner.personId!!
        val tag = planName("pvbp")
        val stream = TestPlan.workStream(owner, "$tag-ws")
        val program = TestPlan.program(stream, owner, "$tag-pg")
        val newProgram = TestPlan.program(stream, owner, "$tag-pg-new")
        val early = TestPlan.project(program, projectOwner, "$tag-early")
        val late = TestPlan.project(program, projectOwner, "$tag-late")
        val doomed = TestPlan.project(program, projectOwner, "$tag-doomed")
        val earlyMs = TestPlan.milestone(early, team)
        val lateMs = TestPlan.milestone(late, team)
        TestPlan.schedule(earlyMs, "2027-02-01", "2027-02-05")
        TestPlan.schedule(lateMs, "2027-02-08", "2027-02-12")
        TestPlan.schedule(TestPlan.milestone(doomed, team), "2027-02-15", "2027-02-19")
        val id = TestPlan.baseline(planName("pvbp"))
        try {
            // late slips two weeks; a project added to the program after the baseline takes no part in the frozen roll-up.
            TestPlan.schedule(lateMs, "2027-02-22", "2027-02-26")
            val newer = TestPlan.project(program, projectOwner, "$tag-newer")
            TestPlan.schedule(TestPlan.milestone(newer, team), "2027-03-01", "2027-03-05")
            val inNewProgram = TestPlan.project(newProgram, projectOwner, "$tag-in-new")
            TestPlan.schedule(TestPlan.milestone(inNewProgram, team), "2027-03-01", "2027-03-05")

            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/$doomed").status)

            val view = w.stranger.client.get("$path?baseline=$id").body<ProgramsView>()
            val baseline = assertNotNull(view.baseline)
            assertEquals(id, baseline.id)
            val removed = baseline.removedProjects.single { it.projectId == doomed }
            assertEquals(program, removed.programId, "the program then, so the page can place the row under it")
            assertEquals(stream, removed.workStreamId)
            assertEquals("$tag-pg", removed.programName)
            assertEquals("2027-02-15" to "2027-02-19", removed.span?.start to removed.span?.end)
            val workStream = view.workStreams.single { it.name == "$tag-ws" }
            val programNode = workStream.programs.single { it.name == "$tag-pg" }
            val projects = programNode.projects.associateBy { it.id }
            assertEquals(MovementKind.UNCHANGED, assertNotNull(projects.getValue(early).baseline).movement.kind)
            val lateThen = assertNotNull(projects.getValue(late).baseline)
            assertEquals(MovementKind.MOVED, lateThen.movement.kind)
            assertEquals(10, lateThen.movement.endDays)
            assertNull(projects.getValue(newer).baseline, "newer than the baseline: no block")

            // The program then: the earliest start to the latest end over early and late as frozen (02-01..02-12); now 02-01..03-05.
            val programThen = assertNotNull(programNode.baseline)
            assertEquals("2027-02-01" to "2027-02-12", programThen.span?.start to programThen.span?.end)
            assertEquals(MovementKind.MOVED, programThen.movement.kind)
            assertEquals(0, programThen.movement.startDays)
            assertEquals(15, programThen.movement.endDays, "02-12 -> 03-05 is fifteen working days")
            val streamThen = assertNotNull(workStream.baseline)
            assertEquals(programThen.span, streamThen.span, "the stream's frozen span comes from its framed programs only")
            assertEquals(15, streamThen.movement.endDays)

            // A program none of whose projects was frozen carries no block, and does not feed the stream's frozen span.
            assertNull(workStream.programs.single { it.name == "$tag-pg-new" }.baseline)

            w.stranger.client.assertOverlayIsAdditive(path, id)
        } finally {
            TestPlan.deleteBaseline(id)
        }
    }

    @Test
    fun `an unscheduled frozen project reads unchanged, and the parameter is refused with 400 - malformed, unknown, deleted`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pvbe")
            val id = TestPlan.baseline(planName("pvbe"))
            try {
                val view = w.stranger.client.get("$path?baseline=$id").body<ProgramsView>()
                val program = view.workStreams.single { it.id == w.streamId }.programs.single { it.id == w.programId }
                val block = assertNotNull(program.baseline, "its project was frozen")
                assertNull(block.span)
                assertEquals(MovementKind.UNCHANGED, block.movement.kind)
                assertEquals(MovementKind.UNCHANGED, assertNotNull(program.projects.single().baseline).movement.kind)
            } finally {
                TestPlan.deleteBaseline(id)
            }
            w.stranger.client.assertBaselineParameterRejected(path)
            assertEquals(HttpStatusCode.OK, w.stranger.client.get(path).status)
        }
}
