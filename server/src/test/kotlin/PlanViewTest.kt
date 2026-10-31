package ch.nokillswit

import ch.nokillswit.planning.PlanView
import ch.nokillswit.planning.PlanWorkStream
import ch.nokillswit.planning.ProgramUpdateRequest
import ch.nokillswit.planning.ProjectUpdateRequest
import ch.nokillswit.planning.TargetWindowRequest
import ch.nokillswit.planning.WorkStreamUpdateRequest
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/plan`: the whole tree for any authenticated caller, its ordering, and the per-caller `can:{}` flags — checked against
 * the expected rights table and against what the server really does (an idempotent write answers 204 exactly where the flag is set).
 */
class PlanViewTest {
    private suspend fun PlanCaller.view(): PlanView = client.get("/api/v1/views/plan").body()

    private fun PlanView.stream(id: UInt): PlanWorkStream = workStreams.single { it.id == id }

    @Test
    fun `the tree lists open work streams before closed ones, every level by name, with owners and dates`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("view")
        val owner = w.streamOwner.personId!!
        val p = planName("vw")
        val closed = TestPlan.workStream(owner, "$p-0-closed", endDate = "2026-06-30")
        val openB = TestPlan.workStream(owner, "$p-b", startDate = "2026-03-29")
        val openA = TestPlan.workStream(owner, "$p-a")
        val zeta = TestPlan.program(openA, owner, "$p-Zeta")
        val alpha = TestPlan.program(openA, owner, "$p-alpha")
        val deletedProgram = TestPlan.program(openA, owner, "$p-gone")
        TestPlan.project(zeta, owner, "$p-Beta", "2026-10-25", "2026-10-25")
        TestPlan.project(zeta, owner, "$p-alpha")
        val deleted = TestPlan.project(zeta, owner, "$p-deleted")
        w.admin.client.delete("/api/v1/projects/$deleted")
        w.admin.client.delete("/api/v1/programs/$deletedProgram")

        val view = w.stranger.view()
        assertEquals(TestPlan.revision(), view.revision)
        val mine = view.workStreams.filter { it.id in setOf(closed, openA, openB) }.map { it.id }
        assertEquals(listOf(openA, openB, closed), mine, "open streams by name, then the closed one even though its name sorts first")
        val stream = view.stream(openA)
        assertEquals(listOf(alpha, zeta), stream.programs.map { it.id }, "programs by name, case-insensitively; the deleted one is absent")
        assertEquals(listOf("$p-alpha", "$p-Beta"), stream.programs.single { it.id == zeta }.projects.map { it.name })
        val beta = stream.programs.single { it.id == zeta }.projects.single { it.name == "$p-Beta" }
        assertEquals("2026-10-25", beta.targetStart)
        assertEquals("2026-10-25", beta.targetEnd)
        assertEquals(zeta, beta.programId)
        assertEquals(openA, beta.workStreamId)
        assertEquals(openA, stream.programs.first().workStreamId)
        assertEquals("2026-03-29", view.stream(openB).startDate)
        assertEquals("2026-06-30", view.stream(closed).endDate)
        assertNull(view.stream(openA).endDate)
        assertTrue(stream.ownerName.isNotBlank())
        assertTrue(stream.programs.none { it.id == deletedProgram })
    }

    @Test
    fun `can flags per caller follow ownership - admin everything, owners down their chain, the window also for a roadmap editor`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("can")
            // caller -> (manage stream, manage program, manage project, edit window, create work stream)
            data class Rights(val stream: Boolean, val program: Boolean, val project: Boolean, val window: Boolean, val create: Boolean)
            val expected = mapOf(
                "admin" to (w.admin to Rights(stream = true, program = true, project = true, window = true, create = true)),
                "stream owner" to (w.streamOwner to Rights(true, true, true, window = true, create = false)),
                "program owner" to (w.programOwner to Rights(false, true, true, window = true, create = false)),
                "project owner" to (w.projectOwner to Rights(false, false, true, window = false, create = false)),
                "stranger" to (w.stranger to Rights(false, false, false, window = false, create = false)),
                "personless" to (w.personless to Rights(false, false, false, window = false, create = false)),
                "roadmap editor" to (w.editor to Rights(false, false, false, window = true, create = false)),
            )
            for ((label, entry) in expected) {
                val (caller, rights) = entry
                val view = caller.view()
                val stream = view.stream(w.streamId)
                val program = stream.programs.single { it.id == w.programId }
                val project = program.projects.single { it.id == w.projectId }
                assertEquals(rights.create, view.can.createWorkStream, "$label: createWorkStream")
                assertEquals(rights.stream, stream.can.edit, "$label: stream.edit")
                assertEquals(rights.stream, stream.can.delete, "$label: stream.delete")
                assertEquals(rights.stream, stream.can.createProgram, "$label: stream.createProgram")
                assertEquals(rights.program, program.can.edit, "$label: program.edit")
                assertEquals(rights.program, program.can.delete, "$label: program.delete")
                assertEquals(rights.program, program.can.createProject, "$label: program.createProject")
                assertEquals(rights.project, project.can.edit, "$label: project.edit")
                assertEquals(rights.project, project.can.delete, "$label: project.delete")
                assertEquals(rights.window, project.can.editTargetWindow, "$label: project.editTargetWindow")
            }
        }

    @Test
    fun `a flag is set exactly where the server lets an idempotent write through`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("agree")
        val everyone = listOf(
            "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner,
            "project owner" to w.projectOwner, "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor,
        )
        // Give the project a window so the idempotent window PUT rewrites the same values.
        w.admin.client.putJson("/api/v1/projects/${w.projectId}/target-window", TargetWindowRequest("2026-05-01", "2026-05-31"))
        fun status(allowed: Boolean) = if (allowed) HttpStatusCode.NoContent else HttpStatusCode.Forbidden
        for ((label, caller) in everyone) {
            val stream = caller.view().stream(w.streamId)
            val program = stream.programs.single { it.id == w.programId }
            val project = program.projects.single { it.id == w.projectId }
            assertNotNull(project.targetStart)
            assertEquals(
                status(stream.can.edit),
                caller.client.putJson(
                    "/api/v1/work-streams/${stream.id}",
                    WorkStreamUpdateRequest(stream.name, stream.description, stream.ownerPersonId, stream.startDate, stream.endDate),
                ).status,
                "$label: work stream edit",
            )
            assertEquals(
                status(program.can.edit),
                caller.client.putJson(
                    "/api/v1/programs/${program.id}",
                    ProgramUpdateRequest(program.name, program.description, program.ownerPersonId),
                ).status,
                "$label: program edit",
            )
            assertEquals(
                status(project.can.edit),
                caller.client.putJson(
                    "/api/v1/projects/${project.id}",
                    ProjectUpdateRequest(project.name, project.description, project.ownerPersonId),
                ).status,
                "$label: project edit",
            )
            assertEquals(
                status(project.can.editTargetWindow),
                caller.client.putJson(
                    "/api/v1/projects/${project.id}/target-window",
                    TargetWindowRequest(project.targetStart, project.targetEnd),
                ).status,
                "$label: target window",
            )
        }
        assertFalse(w.projectOwner.view().stream(w.streamId).programs.single().projects.single().can.editTargetWindow)
    }
}
