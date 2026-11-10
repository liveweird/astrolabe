package ch.nokillswit

import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.planning.MilestoneResponse
import ch.nokillswit.planning.PlanView
import ch.nokillswit.planning.PlanWorkStream
import ch.nokillswit.planning.ProgramMoveRequest
import ch.nokillswit.planning.ProgramResponse
import ch.nokillswit.planning.ProjectMoveRequest
import ch.nokillswit.planning.ProjectResponse
import ch.nokillswit.planning.ProjectUpdateRequest
import ch.nokillswit.planning.ProjectView
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.RoadmapView
import ch.nokillswit.planning.WorkStreamResponse
import ch.nokillswit.planning.WorkStreamUpdateRequest
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import java.sql.Connection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * `POST /projects/{id}/move` and `POST /programs/{id}/move` (v0.3.0 C5): the caller must own something ABOVE the node (the node's
 * own owner alone may not) AND something on the TARGET chain (or be ADMIN). Covered: 404 before 403 before the body before the target's
 * 400, the name clash in the target scope, the no-op, a closed stream as a target, what rides along (milestones, the ranking), every
 * chain-derived read agreeing afterwards, the audits, the `can.move` / `can.create*` flags against the real write and the re-guard
 * under the plan lock. The plan tables are SHARED suite state - unique names, assertions on own ids.
 */
class PlanMoveTest {
    private val forbidden = HttpStatusCode.Forbidden
    private val noContent = HttpStatusCode.NoContent

    /**
     * The standard [PlanWorld] (stream S1 -> program P1 -> project J, each with its own owner) plus the TARGETS: stream S2 owned by
     * [tgtStreamOwner] with program P2 owned by the SOURCE stream's owner (so `w.streamOwner` owns both chains — the dual caller),
     * and stream S3 owned by `w.streamOwner` too (a program move's dual target).
     */
    private class MoveWorld(
        val w: PlanWorld,
        val tgtStreamOwner: PlanCaller,
        val tgtStreamId: UInt,
        val tgtProgramId: UInt,
        val dualStreamId: UInt,
    ) {
        val everyone: List<Pair<String, PlanCaller>>
            get() = listOf(
                "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner,
                "project owner" to w.projectOwner, "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor,
                "target stream owner" to tgtStreamOwner,
            )
    }

    private suspend fun ApplicationTestBuilder.moveWorld(prefix: String): MoveWorld {
        val w = planWorld(prefix)
        val tgtStreamOwner = planCaller("$prefix-ts")
        val tgtStreamId = TestPlan.workStream(tgtStreamOwner.personId!!)
        return MoveWorld(
            w = w,
            tgtStreamOwner = tgtStreamOwner,
            tgtStreamId = tgtStreamId,
            tgtProgramId = TestPlan.program(tgtStreamId, w.streamOwner.personId!!),
            dualStreamId = TestPlan.workStream(w.streamOwner.personId!!),
        )
    }

    private fun moveProject(id: UInt) = "/api/v1/projects/$id/move"

    private fun moveProgram(id: UInt) = "/api/v1/programs/$id/move"

    private suspend fun HttpClient.rawPost(path: String, body: String): HttpResponse = post(path) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpResponse.detail(): String = body<ProblemDetail>().detail.orEmpty()

    private suspend fun PlanCaller.project(id: UInt): ProjectResponse = client.get("/api/v1/projects/$id").body()

    private suspend fun PlanCaller.program(id: UInt): ProgramResponse = client.get("/api/v1/programs/$id").body()

    /** Spins until the wall clock is strictly past [stamp]: `updatedAt` is epoch millis, so a later write stamps a larger one only then. */
    private fun awaitClockPast(stamp: Long) {
        val deadline = System.nanoTime() + CLOCK_WAIT_NANOS
        while (System.currentTimeMillis() <= stamp) {
            check(System.nanoTime() < deadline) { "the clock did not pass $stamp" }
            Thread.onSpinWait()
        }
    }

    private suspend fun PlanCaller.planView(): PlanView = client.get("/api/v1/views/plan").body()

    private fun PlanView.stream(id: UInt): PlanWorkStream = workStreams.single { it.id == id }

    @Test
    fun `moving a project needs an owner ABOVE it AND the target chain - 404 before 403, 403 before the body, then the target's 400`() =
        testApplication {
            usePostgresTestcontainer()
            val m = moveWorld("mvp")
            val w = m.w
            val path = moveProject(w.projectId)
            val body = ProjectMoveRequest(m.tgtProgramId)
            val revision = TestPlan.revision()
            for ((label, caller) in m.everyone) {
                assertEquals(HttpStatusCode.NotFound, caller.client.postJson(moveProject(999999u), body).status, "404 first: $label")
            }
            // No right on the source (an outsider, or an owner of the TARGET only), or a right on the source only: 403 either way.
            val refused = listOf(
                "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor, "target stream owner" to m.tgtStreamOwner,
                "program owner" to w.programOwner, "project owner" to w.projectOwner,
            )
            for ((label, caller) in refused) {
                assertEquals(forbidden, caller.client.postJson(path, body).status, label)
            }
            assertEquals(forbidden, w.stranger.client.rawPost(path, "{ not json").status, "the source guard comes before the body")
            assertEquals(revision, TestPlan.revision(), "a refused move writes nothing")
            assertEquals(w.programId, w.admin.project(w.projectId).programId)

            // A source owner past the source guard (the program's owner is ABOVE the project): the body is read, then the target
            // (400 before its 403).
            val owner = w.programOwner.client
            assertEquals(HttpStatusCode.BadRequest, owner.rawPost(path, "{ not json").status)
            assertEquals(HttpStatusCode.BadRequest, owner.rawPost(path, "{}").status, "programId is required")
            val unknown = owner.postJson(path, ProjectMoveRequest(999999u))
            assertEquals(HttpStatusCode.BadRequest, unknown.status, "an unknown target is a body error, never a 404")
            assertEquals("Unknown or deleted program ids: 999999", unknown.detail())
            val deletedProgram = TestPlan.program(m.tgtStreamId, w.streamOwner.personId!!)
            w.admin.client.delete("/api/v1/programs/$deletedProgram")
            assertEquals(HttpStatusCode.BadRequest, owner.postJson(path, ProjectMoveRequest(deletedProgram)).status)
            val orphaned = TestPlan.program(m.dualStreamId, w.streamOwner.personId!!)
            PostgresTestSupport.connect().use {
                it.exec("UPDATE work_streams SET marked_as_deleted = TRUE WHERE id = ?", m.dualStreamId.toInt())
            }
            val afterFixtures = TestPlan.revision()
            assertEquals(HttpStatusCode.BadRequest, owner.postJson(path, ProjectMoveRequest(orphaned)).status, "its work stream is gone")
            assertEquals(forbidden, owner.postJson(path, body).status, "the target chain is checked after it exists")
            assertEquals(afterFixtures, TestPlan.revision(), "rejected moves write nothing")

            // Both chains: the dual owner succeeds, so does ADMIN (back again).
            val beforeMove = TestPlan.revision()
            assertEquals(noContent, w.streamOwner.client.postJson(path, body).status)
            assertEquals(m.tgtProgramId, w.admin.project(w.projectId).programId)
            assertEquals(beforeMove + 1, TestPlan.revision(), "a move is one plan write")
            assertEquals(noContent, w.admin.client.postJson(path, ProjectMoveRequest(w.programId)).status)
            assertEquals(w.programId, w.admin.project(w.projectId).programId)
        }

    @Test
    fun `a moved project takes its milestones along, keeps its rank, and every chain-derived read and guard follows`() = testApplication {
        usePostgresTestcontainer()
        val m = moveWorld("mvr")
        val w = m.w
        val team = TestTeams.seed(planName("mvr-team"))
        val milestone = TestPlan.milestone(w.projectId, team)
        val before = w.admin.project(w.projectId)
        val ranked = w.admin.client.get("/api/v1/views/roadmap").body<RoadmapView>()
        val rank = ranked.ranked.map { it.project.id } + w.projectId
        assertEquals(
            HttpStatusCode.OK,
            w.admin.client.putJson("/api/v1/roadmap/ranking", RankingUpdateRequest(TestPlan.revision(), rank)).status,
        )
        val position = w.admin.client.get("/api/v1/views/roadmap").body<RoadmapView>()
            .ranked.single { it.project.id == w.projectId }.position
        awaitClockPast(before.updatedAt)

        assertEquals(noContent, w.admin.client.postJson(moveProject(w.projectId), ProjectMoveRequest(m.tgtProgramId)).status)

        val after = w.admin.project(w.projectId)
        assertEquals(m.tgtProgramId, after.programId)
        assertEquals(m.tgtStreamId, after.workStreamId, "the work stream follows the program")
        assertTrue(after.updatedAt > before.updatedAt)
        assertEquals(w.projectId, w.admin.client.get("/api/v1/milestones/$milestone").body<MilestoneResponse>().projectId)
        val view = w.stranger.client.get("/api/v1/views/project/${w.projectId}").body<ProjectView>()
        assertEquals(m.tgtProgramId, view.project.programId)
        assertEquals(m.tgtStreamId, view.project.workStreamId)
        assertEquals(listOf(milestone), (view.scheduled + view.unscheduled).map { it.id }, "the milestone rides along")
        val plan = w.stranger.planView()
        assertTrue(plan.stream(w.streamId).programs.single { it.id == w.programId }.projects.none { it.id == w.projectId })
        assertEquals(
            listOf(w.projectId),
            plan.stream(m.tgtStreamId).programs.single { it.id == m.tgtProgramId }.projects.map { it.id },
        )
        val roadmap = w.stranger.client.get("/api/v1/views/roadmap").body<RoadmapView>()
        val entry = roadmap.ranked.single { it.project.id == w.projectId }
        assertEquals(position, entry.position, "the global ranking is untouched")
        assertEquals(m.tgtProgramId, entry.project.programId)

        // The guards read the NEW chain: the old program owner is out, the new stream owner is in, and the project owner still owns it.
        val update = ProjectUpdateRequest(after.name, after.description, after.ownerPersonId)
        assertEquals(forbidden, w.programOwner.client.putJson("/api/v1/projects/${w.projectId}", update).status)
        assertEquals(noContent, m.tgtStreamOwner.client.putJson("/api/v1/projects/${w.projectId}", update).status)
        assertEquals(noContent, w.projectOwner.client.putJson("/api/v1/projects/${w.projectId}", update).status)
        assertEquals(true, m.tgtStreamOwner.client.get("/api/v1/views/project/${w.projectId}").body<ProjectView>().project.can.edit)
        assertEquals(false, w.programOwner.client.get("/api/v1/views/project/${w.projectId}").body<ProjectView>().project.can.edit)
    }

    @Test
    fun `a name clash in the target program is 409 with the project wording and writes nothing - a free name or another program is fine`() =
        testApplication {
            usePostgresTestcontainer()
            val m = moveWorld("mvc")
            val w = m.w
            val owner = w.projectOwner.personId!!
            val name = planName("clash")
            val moving = TestPlan.project(w.programId, owner, name.uppercase())
            TestPlan.project(m.tgtProgramId, owner, name.lowercase())
            val revision = TestPlan.revision()
            val clash = w.admin.client.postJson(moveProject(moving), ProjectMoveRequest(m.tgtProgramId))
            assertEquals(HttpStatusCode.Conflict, clash.status, "names are unique case-insensitively within the target program")
            assertEquals("A project with this name already exists in this program", clash.detail())
            assertEquals(revision, TestPlan.revision())
            assertEquals(w.programId, w.admin.project(moving).programId)
            // The same name under a DIFFERENT program is fine, and so is the target once the clash is renamed away.
            val otherProgram = TestPlan.program(m.tgtStreamId, owner)
            assertEquals(noContent, w.admin.client.postJson(moveProject(moving), ProjectMoveRequest(otherProgram)).status)
            val twin = TestPlan.project(w.programId, owner, name.uppercase())
            assertEquals(HttpStatusCode.Conflict, w.admin.client.postJson(moveProject(twin), ProjectMoveRequest(otherProgram)).status)
            w.admin.client.delete("/api/v1/projects/$moving")
            val retry = w.admin.client.postJson(moveProject(twin), ProjectMoveRequest(otherProgram))
            assertEquals(noContent, retry.status, "a deleted name is free")
        }

    @Test
    fun `moving to the current parent is a no-op 204 - nothing is stamped and nothing is audited`() = testApplication {
        usePostgresTestcontainer()
        val m = moveWorld("mvn")
        val w = m.w
        val projectBefore = w.admin.project(w.projectId)
        val programBefore = w.admin.program(w.programId)
        awaitClockPast(maxOf(projectBefore.updatedAt, programBefore.updatedAt))
        withAuditCapture { capture ->
            assertEquals(noContent, w.programOwner.client.postJson(moveProject(w.projectId), ProjectMoveRequest(w.programId)).status)
            assertEquals(noContent, w.streamOwner.client.postJson(moveProgram(w.programId), ProgramMoveRequest(w.streamId)).status)
            assertEquals(
                forbidden,
                w.projectOwner.client.postJson(moveProject(w.projectId), ProjectMoveRequest(w.programId)).status,
                "the no-op is for a caller who passes both guards - the project's own owner does not",
            )
            assertEquals(forbidden, w.stranger.client.postJson(moveProject(w.projectId), ProjectMoveRequest(w.programId)).status)
            capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", w.stranger.userId.toLong()) }
            assertTrue(capture.events.none { it.message == "project.moved" || it.message == "program.moved" })
        }
        assertEquals(projectBefore.updatedAt, w.admin.project(w.projectId).updatedAt)
        assertEquals(programBefore.updatedAt, w.admin.program(w.programId).updatedAt)
    }

    @Test
    fun `moving a program needs the owner of its work stream AND the target work stream - its projects ride along, names never clash`() =
        testApplication {
            usePostgresTestcontainer()
            val m = moveWorld("mvg")
            val w = m.w
            val path = moveProgram(w.programId)
            val body = ProgramMoveRequest(m.dualStreamId)
            val revision = TestPlan.revision()
            for ((label, caller) in m.everyone) {
                assertEquals(HttpStatusCode.NotFound, caller.client.postJson(moveProgram(999999u), body).status, "404 first: $label")
            }
            val refused = listOf(
                "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor, "target stream owner" to m.tgtStreamOwner,
                "program owner" to w.programOwner, "project owner" to w.projectOwner,
            )
            for ((label, caller) in refused) {
                assertEquals(forbidden, caller.client.postJson(path, body).status, label)
            }
            assertEquals(forbidden, w.stranger.client.rawPost(path, "{ not json").status, "the source guard comes before the body")
            assertEquals(revision, TestPlan.revision())
            assertEquals(w.streamId, w.admin.program(w.programId).workStreamId)

            val owner = w.streamOwner.client
            assertEquals(HttpStatusCode.BadRequest, owner.rawPost(path, "{ not json").status)
            assertEquals(HttpStatusCode.BadRequest, owner.rawPost(path, "{}").status)
            val unknown = owner.postJson(path, ProgramMoveRequest(999999u))
            assertEquals(HttpStatusCode.BadRequest, unknown.status, "an unknown target is a body error, never a 404")
            assertEquals("Unknown or deleted work stream ids: 999999", unknown.detail())
            val deletedStream = TestPlan.workStream(w.streamOwner.personId!!)
            w.admin.client.delete("/api/v1/work-streams/$deletedStream")
            assertEquals(HttpStatusCode.BadRequest, owner.postJson(path, ProgramMoveRequest(deletedStream)).status)
            assertEquals(forbidden, owner.postJson(path, ProgramMoveRequest(m.tgtStreamId)).status, "owns nothing on the target stream")

            val beforeMove = TestPlan.revision()
            assertEquals(noContent, w.streamOwner.client.postJson(path, body).status)
            val moved = w.admin.program(w.programId)
            assertEquals(m.dualStreamId, moved.workStreamId)
            assertEquals(m.dualStreamId, w.admin.project(w.projectId).workStreamId, "its project follows")
            assertEquals(beforeMove + 1, TestPlan.revision())
            val plan = w.stranger.planView()
            assertEquals(
                listOf(w.projectId),
                plan.stream(m.dualStreamId).programs.single { it.id == w.programId }.projects.map { it.id },
            )
            assertTrue(plan.stream(w.streamId).programs.none { it.id == w.programId })
            // The chain moved with it: the old stream's owner is out of the program now unless they own the new stream too.
            assertEquals(noContent, w.admin.client.postJson(path, ProgramMoveRequest(m.tgtStreamId)).status)
            assertEquals(forbidden, w.streamOwner.client.postJson(path, ProgramMoveRequest(w.streamId)).status, "no longer on the chain")
            val inPlace = m.tgtStreamOwner.client.postJson(path, ProgramMoveRequest(m.tgtStreamId))
            assertEquals(noContent, inPlace.status, "the new stream's owner is above the program and owns the target: a no-op")
        }

    @Test
    fun `the plan view's flags agree with the real moves - a source move flag AND a target create flag, exactly`() = testApplication {
        usePostgresTestcontainer()
        val m = moveWorld("mvf")
        val w = m.w
        val projectOwner = w.projectOwner.personId!!
        val allowedProjects = mutableSetOf<String>()
        val allowedPrograms = mutableSetOf<String>()
        val projectMoveFlag = mutableSetOf<String>()
        for ((label, caller) in m.everyone) {
            val project = TestPlan.project(w.programId, projectOwner)
            val program = TestPlan.program(w.streamId, w.programOwner.personId!!)
            val view = caller.planView()
            val projectSource = view.stream(w.streamId).programs.single { it.id == w.programId }.projects.single { it.id == project }
            val projectTarget = view.stream(m.tgtStreamId).programs.single { it.id == m.tgtProgramId }.can.createProject
            val programSource = view.stream(w.streamId).programs.single { it.id == program }.can.move
            val programTarget = view.stream(m.dualStreamId).can.createProgram
            val project204 = caller.client.postJson(moveProject(project), ProjectMoveRequest(m.tgtProgramId)).status
            val program204 = caller.client.postJson(moveProgram(program), ProgramMoveRequest(m.dualStreamId)).status
            assertEquals(if (projectSource.can.move && projectTarget) noContent else forbidden, project204, "$label: project move")
            assertEquals(if (programSource && programTarget) noContent else forbidden, program204, "$label: program move")
            if (project204 == noContent) allowedProjects += label
            if (program204 == noContent) allowedPrograms += label
            if (projectSource.can.move) projectMoveFlag += label
        }
        assertEquals(setOf("admin", "stream owner"), allowedProjects, "only a caller above the node AND on the target chain (or ADMIN)")
        assertEquals(setOf("admin", "stream owner"), allowedPrograms)
        assertEquals(
            setOf("admin", "stream owner", "program owner"),
            projectMoveFlag,
            "the project's own owner has edit but never the move flag",
        )
    }

    @Test
    fun `a node's own owner cannot move it even into a parent they own - an owner above who also owns the target can`() = testApplication {
        usePostgresTestcontainer()
        val m = moveWorld("mvo")
        val w = m.w
        // The project's own owner owns another program; the program's own owner owns another work stream.
        val ownProgram = TestPlan.program(m.tgtStreamId, w.projectOwner.personId!!)
        val ownStream = TestPlan.workStream(w.programOwner.personId!!)
        val revision = TestPlan.revision()
        assertEquals(forbidden, w.projectOwner.client.postJson(moveProject(w.projectId), ProjectMoveRequest(ownProgram)).status)
        assertEquals(forbidden, w.programOwner.client.postJson(moveProgram(w.programId), ProgramMoveRequest(ownStream)).status)
        assertEquals(revision, TestPlan.revision())
        assertEquals(w.programId, w.admin.project(w.projectId).programId)
        assertEquals(w.streamId, w.admin.program(w.programId).workStreamId)

        // An owner ABOVE the node who also owns the target moves it: the program's owner takes the project into a program of theirs...
        val theirProgram = TestPlan.program(m.tgtStreamId, w.programOwner.personId!!)
        assertEquals(noContent, w.programOwner.client.postJson(moveProject(w.projectId), ProjectMoveRequest(theirProgram)).status)
        assertEquals(theirProgram, w.admin.project(w.projectId).programId)
        // ...and, still above it there (they own that program), takes it back.
        assertEquals(noContent, w.programOwner.client.postJson(moveProject(w.projectId), ProjectMoveRequest(w.programId)).status)
        assertEquals(w.programId, w.admin.project(w.projectId).programId)
        // The stream's owner takes the program into a stream they own.
        assertEquals(noContent, w.streamOwner.client.postJson(moveProgram(w.programId), ProgramMoveRequest(m.dualStreamId)).status)
        assertEquals(m.dualStreamId, w.admin.program(w.programId).workStreamId)
    }

    @Test
    fun `a closed work stream is a valid target for both moves`() = testApplication {
        usePostgresTestcontainer()
        val m = moveWorld("mvx")
        val w = m.w
        val closedId = TestPlan.workStream(w.streamOwner.personId!!)
        val stream = w.admin.client.get("/api/v1/work-streams/$closedId").body<WorkStreamResponse>()
        val close = WorkStreamUpdateRequest(stream.name, null, stream.ownerPersonId, stream.startDate, "2026-12-31")
        assertEquals(noContent, w.admin.client.putJson("/api/v1/work-streams/$closedId", close).status)
        assertEquals("2026-12-31", w.admin.client.get("/api/v1/work-streams/$closedId").body<WorkStreamResponse>().endDate)
        val inClosed = TestPlan.program(closedId, w.streamOwner.personId!!)

        assertEquals(noContent, w.streamOwner.client.postJson(moveProject(w.projectId), ProjectMoveRequest(inClosed)).status)
        assertEquals(closedId, w.admin.project(w.projectId).workStreamId)
        assertEquals(noContent, w.streamOwner.client.postJson(moveProgram(w.programId), ProgramMoveRequest(closedId)).status)
        assertEquals(closedId, w.admin.program(w.programId).workStreamId)
    }

    @Test
    fun `moves audit project_moved and program_moved with from and to - a rejected or no-op move emits nothing`() = testApplication {
        usePostgresTestcontainer()
        val m = moveWorld("mva")
        val w = m.w
        withAuditCapture { capture ->
            val projectId = w.projectId.toLong()
            assertEquals(noContent, w.streamOwner.client.postJson(moveProject(w.projectId), ProjectMoveRequest(m.tgtProgramId)).status)
            val project = capture.awaitEvent { it.message == "project.moved" && it.hasKeyValue("projectId", projectId) }
            assertNotNull(project)
            assertTrue(project.hasKeyValue("byUserId", w.streamOwner.userId.toLong()))
            assertTrue(project.hasKeyValue("programFrom", w.programId.toLong()))
            assertTrue(project.hasKeyValue("programTo", m.tgtProgramId.toLong()))

            val programId = w.programId.toLong()
            assertEquals(noContent, w.admin.client.postJson(moveProgram(w.programId), ProgramMoveRequest(m.dualStreamId)).status)
            val program = capture.awaitEvent { it.message == "program.moved" && it.hasKeyValue("programId", programId) }
            assertNotNull(program)
            assertTrue(program.hasKeyValue("byUserId", w.admin.userId.toLong()))
            assertTrue(program.hasKeyValue("workStreamFrom", w.streamId.toLong()))
            assertTrue(program.hasKeyValue("workStreamTo", m.dualStreamId.toLong()))

            w.admin.client.postJson(moveProject(w.projectId), ProjectMoveRequest(m.tgtProgramId)) // already there
            w.stranger.client.postJson(moveProject(w.projectId), ProjectMoveRequest(w.programId)) // refused
            w.admin.client.postJson(moveProject(w.projectId), ProjectMoveRequest(999999u)) // 400
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", w.stranger.userId.toLong()) })
            assertEquals(1, capture.events.count { it.message == "project.moved" && it.hasKeyValue("projectId", projectId) })
            assertEquals(1, capture.events.count { it.message == "program.moved" && it.hasKeyValue("programId", programId) })
        }
    }

    // The guards re-run under the plan lock against the chains and the person re-read THERE (a request can be held open after the outer
    // guard): each case holds the lock, lets the request pass the outer checks and queue, commits a change, and expects the verdict of
    // the NEW state, with nothing written and no revision bump.

    private suspend fun heldProjectMove(m: MoveWorld, mutate: (Connection) -> Unit): HttpResponse =
        requestHeldAtPlanLock({ m.w.streamOwner.client.postJson(moveProject(m.w.projectId), ProjectMoveRequest(m.tgtProgramId)) }, mutate)

    @Test
    fun `source ownership lost while the request was held is 403 - the source chain is re-read under the lock`() = testApplication {
        usePostgresTestcontainer()
        val m = moveWorld("held1")
        val revision = TestPlan.revision()
        val response = heldProjectMove(m) {
            it.exec("UPDATE work_streams SET owner_person_id = ? WHERE id = ?", m.w.stranger.personId!!.toInt(), m.w.streamId.toInt())
        }
        assertEquals(forbidden, response.status)
        assertEquals(revision, TestPlan.revision())
        assertEquals(m.w.programId, m.w.admin.project(m.w.projectId).programId)
    }

    @Test
    fun `target ownership lost while the request was held is 403, a target deleted meanwhile is 400, a project deleted meanwhile is 404`() =
        testApplication {
            usePostgresTestcontainer()
            val m = moveWorld("held2")
            val revision = TestPlan.revision()
            val lost = heldProjectMove(m) {
                it.exec("UPDATE programs SET owner_person_id = ? WHERE id = ?", m.w.stranger.personId!!.toInt(), m.tgtProgramId.toInt())
            }
            assertEquals(forbidden, lost.status, "the target chain is re-read under the lock too")
            // The committed owner change stays, so the next cases are ADMIN's.
            val gone = requestHeldAtPlanLock(
                { m.w.admin.client.postJson(moveProject(m.w.projectId), ProjectMoveRequest(m.tgtProgramId)) },
                { it.exec("UPDATE programs SET marked_as_deleted = TRUE WHERE id = ?", m.tgtProgramId.toInt()) },
            )
            assertEquals(HttpStatusCode.BadRequest, gone.status)
            assertEquals(revision, TestPlan.revision())
            val deleted = requestHeldAtPlanLock(
                { m.w.admin.client.postJson(moveProject(m.w.projectId), ProjectMoveRequest(m.w.programId)) },
                { it.exec("UPDATE projects SET marked_as_deleted = TRUE WHERE id = ?", m.w.projectId.toInt()) },
            )
            assertEquals(HttpStatusCode.NotFound, deleted.status)
            assertEquals(revision, TestPlan.revision())
        }

    @Test
    fun `re-linking the caller's person while the move was held revokes it, and a name taken in the target meanwhile is 409`() =
        testApplication {
            usePostgresTestcontainer()
            val m = moveWorld("held3")
            val w = m.w
            val replacement = TestUsers.seed(email = uniqueEmail("held3-new"), password = "pw", role = ch.nokillswit.users.UserRole.USER)
            val revision = TestPlan.revision()
            val relinked = heldProjectMove(m) {
                it.exec("UPDATE people SET user_id = ? WHERE id = ?", replacement.toInt(), w.streamOwner.personId!!.toInt())
            }
            assertEquals(forbidden, relinked.status)
            assertEquals(revision, TestPlan.revision())

            val name = w.admin.project(w.projectId).name
            val rival = TestPlan.project(m.tgtProgramId, w.projectOwner.personId!!)
            val clash = requestHeldAtPlanLock(
                { w.admin.client.postJson(moveProject(w.projectId), ProjectMoveRequest(m.tgtProgramId)) },
                { it.prepareStatement("UPDATE projects SET \"name\" = ? WHERE id = ?").use { st ->
                    st.setString(1, name)
                    st.setInt(2, rival.toInt())
                    st.executeUpdate()
                } },
            )
            assertEquals(HttpStatusCode.Conflict, clash.status, "the unique index is the arbiter under the lock")
            assertNotEquals(m.tgtProgramId, w.admin.project(w.projectId).programId)
        }

    @Test
    fun `a program move re-checks its target under the lock - a work stream deleted meanwhile is 400`() = testApplication {
        usePostgresTestcontainer()
        val m = moveWorld("held4")
        val w = m.w
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { w.streamOwner.client.postJson(moveProgram(w.programId), ProgramMoveRequest(m.dualStreamId)) },
            { it.exec("UPDATE work_streams SET marked_as_deleted = TRUE WHERE id = ?", m.dualStreamId.toInt()) },
        )
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals(revision, TestPlan.revision())
        assertEquals(w.streamId, w.admin.program(w.programId).workStreamId)
    }

    private companion object {
        /** The clock is only ever a few milliseconds behind: a wait this long means it is stuck or the stamp is from the future. */
        const val CLOCK_WAIT_NANOS = 5_000_000_000L
    }
}
