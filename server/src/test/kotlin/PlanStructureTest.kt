package ch.nokillswit

import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.planning.ProgramCreateRequest
import ch.nokillswit.planning.ProgramResponse
import ch.nokillswit.planning.ProgramUpdateRequest
import ch.nokillswit.planning.ProjectCreateRequest
import ch.nokillswit.planning.ProjectResponse
import ch.nokillswit.planning.ProjectUpdateRequest
import ch.nokillswit.planning.TargetWindowRequest
import ch.nokillswit.planning.WorkStreamCreateRequest
import ch.nokillswit.planning.WorkStreamResponse
import ch.nokillswit.planning.WorkStreamUpdateRequest
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The plan nodes over HTTP (V12): the owner-scoped guard matrix of every route for every kind of caller (ADMIN, the owners at each
 * level, a stranger with a person, a person-less login, a `ROADMAP_EDITOR`), read-before-guard ordering (404 before 403, 403 before a
 * malformed body), owner reassignment, validation, name uniqueness per scope and the delete 409s. The plan tables are SHARED suite
 * state — every test mints unique names and asserts on its own ids.
 */
class PlanStructureTest {
    private val forbidden = HttpStatusCode.Forbidden

    private fun ws(owner: UInt, name: String = planName("ws"), start: String = "2026-01-01", end: String? = null) =
        WorkStreamCreateRequest(name = name, ownerPersonId = owner, startDate = start, endDate = end)

    private fun pg(owner: UInt, name: String = planName("pg")) = ProgramCreateRequest(name = name, ownerPersonId = owner)

    private fun pj(owner: UInt, name: String = planName("pj")) = ProjectCreateRequest(name = name, ownerPersonId = owner)

    private suspend fun HttpClient.rawPost(path: String, body: String): HttpResponse = post(path) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpClient.rawPut(path: String, body: String): HttpResponse = put(path) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpResponse.detail(): String = body<ProblemDetail>().detail.orEmpty()

    @Test
    fun `every authenticated caller reads a node and an unknown or deleted id is 404`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rd")
        for ((label, caller) in w.outsiders) {
            assertEquals(HttpStatusCode.OK, caller.client.get("/api/v1/work-streams/${w.streamId}").status, label)
            assertEquals(HttpStatusCode.OK, caller.client.get("/api/v1/programs/${w.programId}").status, label)
            assertEquals(HttpStatusCode.OK, caller.client.get("/api/v1/projects/${w.projectId}").status, label)
        }
        val stream = w.stranger.client.get("/api/v1/work-streams/${w.streamId}").body<WorkStreamResponse>()
        assertEquals(w.streamOwner.personId, stream.ownerPersonId)
        assertEquals("2026-01-01", stream.startDate)
        assertNull(stream.endDate)
        val program = w.stranger.client.get("/api/v1/programs/${w.programId}").body<ProgramResponse>()
        assertEquals(w.streamId, program.workStreamId)
        val project = w.stranger.client.get("/api/v1/projects/${w.projectId}").body<ProjectResponse>()
        assertEquals(w.programId, project.programId)
        assertEquals(w.streamId, project.workStreamId)
        assertEquals(w.projectOwner.personId, project.ownerPersonId)
        assertTrue(project.ownerName.isNotBlank())
        assertNull(project.targetStart)
        for (path in listOf("work-streams", "programs", "projects")) {
            assertEquals(HttpStatusCode.NotFound, w.stranger.client.get("/api/v1/$path/999999").status, path)
        }
        val gone = TestPlan.workStream(w.streamOwner.personId!!)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/work-streams/$gone").status)
        assertEquals(HttpStatusCode.NotFound, w.stranger.client.get("/api/v1/work-streams/$gone").status)
    }

    @Test
    fun `creating a work stream is ADMIN only with the guard before the body, and returns the stored record`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wsc")
        val owner = w.streamOwner.personId!!
        val callers = listOf("stream owner" to w.streamOwner, "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor)
        for ((label, caller) in callers) {
            assertEquals(forbidden, caller.client.postJson("/api/v1/work-streams", ws(owner)).status, label)
            assertEquals(
                forbidden,
                caller.client.rawPost("/api/v1/work-streams", "{ not json").status,
                "$label: a malformed body stays 403",
            )
        }
        val revision = TestPlan.revision()
        val name = planName("Created")
        val created = w.admin.client.postJson(
            "/api/v1/work-streams",
            WorkStreamCreateRequest("  $name  ", "  a description  ", owner, "2026-03-29", "2026-10-25"),
        )
        assertEquals(HttpStatusCode.Created, created.status)
        val body = created.body<WorkStreamResponse>()
        assertEquals("/api/v1/work-streams/${body.id}", created.headers["Location"])
        assertEquals(name, body.name, "the sanitizer trims")
        assertEquals("a description", body.description)
        assertEquals(owner, body.ownerPersonId)
        assertEquals("2026-03-29", body.startDate, "DST-change days survive the DATE column")
        assertEquals("2026-10-25", body.endDate)
        assertEquals(body, w.stranger.client.get("/api/v1/work-streams/${body.id}").body<WorkStreamResponse>())
        assertEquals(revision + 1, TestPlan.revision(), "the create bumped the plan revision once")
    }

    @Test
    fun `a work stream rejects an inactive owner and bad dates with 400 and writes nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wsv")
        val owner = w.streamOwner.personId!!
        val gone = TestPeople.seed(planName("gone"))
        TestPeople.softDelete(gone)
        val revision = TestPlan.revision()
        val bad = listOf(
            "blank name" to ws(owner, name = "   "),
            "name too long" to ws(owner, name = "x".repeat(101)),
            "description too long" to WorkStreamCreateRequest(planName("d"), "x".repeat(501), owner, "2026-01-01"),
            "control character" to ws(owner, name = "tab\tname"),
            "unknown owner" to ws(999999u),
            "deleted owner" to ws(gone),
            "short date" to ws(owner, start = "2026-1-1"),
            "impossible day" to ws(owner, start = "2026-02-30"),
            "timestamp" to ws(owner, start = "2026-01-01T00:00:00Z"),
            "year before 1900" to ws(owner, start = "1899-12-31"),
            "year after 2999" to ws(owner, start = "3000-01-01"),
            "end before start" to ws(owner, start = "2026-02-01", end = "2026-01-31"),
            "end not a date" to ws(owner, end = "soon"),
        )
        for ((label, request) in bad) {
            assertEquals(HttpStatusCode.BadRequest, w.admin.client.postJson("/api/v1/work-streams", request).status, label)
        }
        assertEquals(
            HttpStatusCode.BadRequest,
            w.admin.client.rawPost("/api/v1/work-streams", """{"name":"${planName("noowner")}","startDate":"2026-01-01"}""").status,
            "the owner is required on every node",
        )
        val deleted = w.admin.client.postJson("/api/v1/work-streams", ws(gone))
        assertTrue(deleted.detail().contains("owner"))
        // A one-day span (end == start) is valid.
        assertEquals(
            HttpStatusCode.Created,
            w.admin.client.postJson("/api/v1/work-streams", ws(owner, start = "2026-05-05", end = "2026-05-05")).status,
        )
        assertEquals(revision + 1, TestPlan.revision(), "only the one valid create moved the revision")
    }

    @Test
    fun `work stream update and delete need the stream's owner or ADMIN - 404 before 403, 403 before the body`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wsm")
        val owner = w.streamOwner.personId!!
        val update = WorkStreamUpdateRequest(name = planName("renamed"), ownerPersonId = owner, startDate = "2026-01-01")
        val strangers = listOf(
            "program owner" to w.programOwner, "project owner" to w.projectOwner,
            "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor,
        )
        for ((label, caller) in strangers) {
            assertEquals(forbidden, caller.client.putJson("/api/v1/work-streams/${w.streamId}", update).status, "PUT as $label")
            assertEquals(forbidden, caller.client.delete("/api/v1/work-streams/${w.streamId}").status, "DELETE as $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.putJson("/api/v1/work-streams/999999", update).status, "404 first: $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.delete("/api/v1/work-streams/999999").status, "404 first: $label")
        }
        assertEquals(
            forbidden,
            w.stranger.client.rawPut("/api/v1/work-streams/${w.streamId}", "{ not json").status,
            "a forbidden caller's malformed body stays 403",
        )
        assertEquals(
            HttpStatusCode.BadRequest,
            w.streamOwner.client.rawPut("/api/v1/work-streams/${w.streamId}", "{ not json").status,
            "the owner's malformed body is a 400",
        )
        for ((label, caller) in listOf("admin" to w.admin, "stream owner" to w.streamOwner)) {
            val renamed = planName("by-$label".replace(' ', '-'))
            assertEquals(
                HttpStatusCode.NoContent,
                caller.client.putJson("/api/v1/work-streams/${w.streamId}", update.copy(name = renamed)).status,
                label,
            )
            assertEquals(renamed, w.stranger.client.get("/api/v1/work-streams/${w.streamId}").body<WorkStreamResponse>().name)
        }
        // Deleting: each allowed caller on a disposable stream of their own.
        for ((label, caller) in listOf("admin" to w.admin, "stream owner" to w.streamOwner)) {
            val disposable = TestPlan.workStream(owner)
            assertEquals(HttpStatusCode.NoContent, caller.client.delete("/api/v1/work-streams/$disposable").status, label)
            assertEquals(HttpStatusCode.NotFound, caller.client.delete("/api/v1/work-streams/$disposable").status, "already deleted")
            assertEquals(HttpStatusCode.NotFound, caller.client.putJson("/api/v1/work-streams/$disposable", update).status)
        }
        assertEquals(
            HttpStatusCode.BadRequest,
            w.streamOwner.client.putJson("/api/v1/work-streams/${w.streamId}", update.copy(endDate = "2025-12-31")).status,
            "end before start on update",
        )
    }

    @Test
    fun `programs - create under a stream needs the stream's owner, edit and delete any owner of the program's chain`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pgm")
        val owner = w.programOwner.personId!!
        val streamForbidden = listOf(
            "program owner" to w.programOwner, "project owner" to w.projectOwner,
            "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor,
        )
        for ((label, caller) in streamForbidden) {
            assertEquals(forbidden, caller.client.postJson("/api/v1/work-streams/${w.streamId}/programs", pg(owner)).status, label)
            assertEquals(
                HttpStatusCode.NotFound, caller.client.postJson("/api/v1/work-streams/999999/programs", pg(owner)).status,
                "404 before 403: $label",
            )
        }
        assertEquals(
            forbidden, w.stranger.client.rawPost("/api/v1/work-streams/${w.streamId}/programs", "{ not json").status,
            "a forbidden caller's malformed body stays 403",
        )
        for ((label, caller) in listOf("admin" to w.admin, "stream owner" to w.streamOwner)) {
            val response = caller.client.postJson("/api/v1/work-streams/${w.streamId}/programs", pg(owner))
            assertEquals(HttpStatusCode.Created, response.status, label)
            val program = response.body<ProgramResponse>()
            assertEquals("/api/v1/programs/${program.id}", response.headers["Location"])
            assertEquals(w.streamId, program.workStreamId)
            assertEquals(owner, program.ownerPersonId)
        }
        val gone = TestPeople.seed(planName("gone"))
        TestPeople.softDelete(gone)
        assertEquals(HttpStatusCode.BadRequest, w.admin.client.postJson("/api/v1/work-streams/${w.streamId}/programs", pg(gone)).status)
        assertEquals(
            HttpStatusCode.BadRequest,
            w.admin.client.postJson("/api/v1/work-streams/${w.streamId}/programs", pg(owner, "")).status,
        )

        val update = ProgramUpdateRequest(name = planName("renamed"), ownerPersonId = owner)
        val notProgramOwners = listOf(
            "project owner" to w.projectOwner, "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor,
        )
        for ((label, caller) in notProgramOwners) {
            assertEquals(forbidden, caller.client.putJson("/api/v1/programs/${w.programId}", update).status, "PUT as $label")
            assertEquals(forbidden, caller.client.delete("/api/v1/programs/${w.programId}").status, "DELETE as $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.putJson("/api/v1/programs/999999", update).status, "404 first: $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.delete("/api/v1/programs/999999").status, "404 first: $label")
        }
        assertEquals(forbidden, w.stranger.client.rawPut("/api/v1/programs/${w.programId}", "{ not json").status)
        for ((label, caller) in listOf("admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner)) {
            val renamed = planName("by-${label.replace(' ', '-')}")
            assertEquals(
                HttpStatusCode.NoContent,
                caller.client.putJson("/api/v1/programs/${w.programId}", update.copy(name = renamed)).status,
                label,
            )
            assertEquals(renamed, w.stranger.client.get("/api/v1/programs/${w.programId}").body<ProgramResponse>().name)
            val disposable = TestPlan.program(w.streamId, owner)
            assertEquals(HttpStatusCode.NoContent, caller.client.delete("/api/v1/programs/$disposable").status, "DELETE as $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.delete("/api/v1/programs/$disposable").status)
        }
    }

    @Test
    fun `projects - create needs an owner of the program's chain, edit and delete any owner, the project's own included`() =
        testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pjm")
        val owner = w.projectOwner.personId!!
        val createForbidden = listOf(
            "project owner" to w.projectOwner, "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor,
        )
        for ((label, caller) in createForbidden) {
            assertEquals(forbidden, caller.client.postJson("/api/v1/programs/${w.programId}/projects", pj(owner)).status, label)
            assertEquals(
                HttpStatusCode.NotFound,
                caller.client.postJson("/api/v1/programs/999999/projects", pj(owner)).status,
                "404 first: $label",
            )
        }
        assertEquals(forbidden, w.stranger.client.rawPost("/api/v1/programs/${w.programId}/projects", "{ not json").status)
        for ((label, caller) in listOf("admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner)) {
            val response = caller.client.postJson(
                "/api/v1/programs/${w.programId}/projects",
                ProjectCreateRequest(planName("by-${label.replace(' ', '-')}"), null, owner, "2026-02-01", "2026-04-30"),
            )
            assertEquals(HttpStatusCode.Created, response.status, label)
            val project = response.body<ProjectResponse>()
            assertEquals("/api/v1/projects/${project.id}", response.headers["Location"])
            assertEquals(w.programId, project.programId)
            assertEquals(w.streamId, project.workStreamId)
            assertEquals("2026-02-01", project.targetStart, "creators are window editors: the window rides the create body")
            assertEquals("2026-04-30", project.targetEnd)
        }
        val withoutWindow = w.admin.client.postJson("/api/v1/programs/${w.programId}/projects", pj(owner)).body<ProjectResponse>()
        assertNull(withoutWindow.targetStart)
        assertNull(withoutWindow.targetEnd)

        val update = ProjectUpdateRequest(name = planName("renamed"), ownerPersonId = owner)
        for ((label, caller) in listOf("stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor)) {
            assertEquals(forbidden, caller.client.putJson("/api/v1/projects/${w.projectId}", update).status, "PUT as $label")
            assertEquals(forbidden, caller.client.delete("/api/v1/projects/${w.projectId}").status, "DELETE as $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.putJson("/api/v1/projects/999999", update).status, "404 first: $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.delete("/api/v1/projects/999999").status, "404 first: $label")
        }
        assertEquals(forbidden, w.stranger.client.rawPut("/api/v1/projects/${w.projectId}", "{ not json").status)
        val everyOwner = listOf(
            "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner, "project owner" to w.projectOwner,
        )
        for ((label, caller) in everyOwner) {
            val renamed = planName("by-${label.replace(' ', '-')}")
            assertEquals(
                HttpStatusCode.NoContent,
                caller.client.putJson("/api/v1/projects/${w.projectId}", update.copy(name = renamed)).status,
                label,
            )
            assertEquals(renamed, w.stranger.client.get("/api/v1/projects/${w.projectId}").body<ProjectResponse>().name)
            val disposable = TestPlan.project(w.programId, owner)
            assertEquals(HttpStatusCode.NoContent, caller.client.delete("/api/v1/projects/$disposable").status, "DELETE as $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.delete("/api/v1/projects/$disposable").status)
        }
        val gone = TestPeople.seed(planName("gone"))
        TestPeople.softDelete(gone)
        assertEquals(HttpStatusCode.BadRequest, w.admin.client.postJson("/api/v1/programs/${w.programId}/projects", pj(gone)).status)
        assertEquals(
            HttpStatusCode.BadRequest,
            w.admin.client.putJson("/api/v1/projects/${w.projectId}", update.copy(ownerPersonId = gone)).status,
        )
    }

    @Test
    fun `the target window is set by ADMIN, an owner above the project or a roadmap editor - never by the project's own owner alone`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tw")
            val path = "/api/v1/projects/${w.projectId}/target-window"
            val window = TargetWindowRequest("2026-03-01", "2026-06-30")
            for ((label, caller) in listOf("project owner" to w.projectOwner, "stranger" to w.stranger, "personless" to w.personless)) {
                assertEquals(forbidden, caller.client.putJson(path, window).status, label)
                assertEquals(
                    HttpStatusCode.NotFound,
                    caller.client.putJson("/api/v1/projects/999999/target-window", window).status,
                    "404 first: $label",
                )
            }
            assertEquals(
                forbidden,
                w.projectOwner.client.rawPut(path, "{ not json").status,
                "a forbidden caller's malformed body stays 403",
            )
            val allowed = listOf(
                "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner, "roadmap editor" to w.editor,
            )
            for ((index, entry) in allowed.withIndex()) {
                val (label, caller) = entry
                val next = TargetWindowRequest("2026-0${index + 1}-01", "2026-0${index + 1}-28")
                assertEquals(HttpStatusCode.NoContent, caller.client.putJson(path, next).status, label)
                val stored = w.stranger.client.get("/api/v1/projects/${w.projectId}").body<ProjectResponse>()
                assertEquals(next.targetStart, stored.targetStart, label)
                assertEquals(next.targetEnd, stored.targetEnd, label)
            }
            // A grant is read per request: revoking it takes effect at once.
            TestUsers.service.replacePermissions(w.editor.userId, emptySet())
            assertEquals(forbidden, w.editor.client.putJson(path, window).status, "revoked")

            val invalid = listOf(
                "only a start" to TargetWindowRequest("2026-03-01", null),
                "only an end" to TargetWindowRequest(null, "2026-03-01"),
                "end before start" to TargetWindowRequest("2026-03-02", "2026-03-01"),
                "bad shape" to TargetWindowRequest("2026-3-1", "2026-03-02"),
                "impossible day" to TargetWindowRequest("2026-02-30", "2026-03-02"),
                "year before 1900" to TargetWindowRequest("1899-12-31", "2026-03-02"),
                "year after 2999" to TargetWindowRequest("2026-03-01", "3000-01-01"),
            )
            val revision = TestPlan.revision()
            for ((label, request) in invalid) {
                assertEquals(HttpStatusCode.BadRequest, w.admin.client.putJson(path, request).status, label)
            }
            assertEquals(revision, TestPlan.revision(), "a rejected window never moves the revision")
            // Equal dates are a one-day window; omitting both clears it.
            assertEquals(HttpStatusCode.NoContent, w.admin.client.putJson(path, TargetWindowRequest("2026-03-01", "2026-03-01")).status)
            assertEquals(HttpStatusCode.NoContent, w.admin.client.putJson(path, TargetWindowRequest()).status)
            assertNull(w.admin.client.get("/api/v1/projects/${w.projectId}").body<ProjectResponse>().targetStart)

            // An owner who is also an ancestor (the program owner owns this project too) IS an owner above it: allowed.
            val both = TestPlan.project(w.programId, w.programOwner.personId!!)
            assertEquals(HttpStatusCode.NoContent, w.programOwner.client.putJson("/api/v1/projects/$both/target-window", window).status)
        }

    @Test
    fun `any owner on the chain may reassign the owner - the new owner must be active and the rights move with it`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("own")
        val streamOwner = w.streamOwner.personId!!
        val programOwner = w.programOwner.personId!!
        val stranger = w.stranger.personId!!
        val admin = w.admin.client

        // Work stream: the owner hands it over, loses the rights, and the new owner can hand it back.
        val streamPath = "/api/v1/work-streams/${w.streamId}"
        val streamBody = WorkStreamUpdateRequest(name = planName("handover"), ownerPersonId = stranger, startDate = "2026-01-01")
        assertEquals(HttpStatusCode.NoContent, w.streamOwner.client.putJson(streamPath, streamBody).status)
        assertEquals(stranger, admin.get(streamPath).body<WorkStreamResponse>().ownerPersonId)
        assertEquals(forbidden, w.streamOwner.client.putJson(streamPath, streamBody).status)
        assertEquals(forbidden, w.streamOwner.client.delete(streamPath).status)
        assertEquals(HttpStatusCode.NoContent, w.stranger.client.putJson(streamPath, streamBody.copy(ownerPersonId = streamOwner)).status)
        assertEquals(
            HttpStatusCode.NoContent,
            w.streamOwner.client.putJson(streamPath, streamBody.copy(ownerPersonId = streamOwner)).status,
        )

        // Program: the program owner hands it to the editor; the stream owner above takes it back.
        val programPath = "/api/v1/programs/${w.programId}"
        val programBody = ProgramUpdateRequest(name = planName("handover"), ownerPersonId = w.editor.personId!!)
        assertEquals(HttpStatusCode.NoContent, w.programOwner.client.putJson(programPath, programBody).status)
        assertEquals(forbidden, w.programOwner.client.putJson(programPath, programBody).status)
        assertEquals(HttpStatusCode.NoContent, w.editor.client.putJson(programPath, programBody).status, "the new owner edits")
        assertEquals(
            HttpStatusCode.NoContent,
            w.streamOwner.client.putJson(programPath, programBody.copy(ownerPersonId = programOwner)).status,
        )
        assertEquals(
            HttpStatusCode.NoContent,
            w.programOwner.client.putJson(programPath, programBody.copy(ownerPersonId = programOwner)).status,
        )

        // Project: its own owner hands it to the stranger; the program owner above takes it back.
        val projectPath = "/api/v1/projects/${w.projectId}"
        val projectBody = ProjectUpdateRequest(name = planName("handover"), ownerPersonId = stranger)
        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.putJson(projectPath, projectBody).status)
        assertEquals(forbidden, w.projectOwner.client.putJson(projectPath, projectBody).status)
        assertEquals(HttpStatusCode.NoContent, w.stranger.client.putJson(projectPath, projectBody).status)
        assertEquals(
            HttpStatusCode.NoContent,
            w.programOwner.client.putJson(projectPath, projectBody.copy(ownerPersonId = w.projectOwner.personId!!)).status,
        )

        // An inactive new owner is a 400 and the stored owner stays.
        val gone = TestPeople.seed(planName("gone"))
        TestPeople.softDelete(gone)
        assertEquals(HttpStatusCode.BadRequest, w.streamOwner.client.putJson(streamPath, streamBody.copy(ownerPersonId = gone)).status)
        assertEquals(HttpStatusCode.BadRequest, w.programOwner.client.putJson(programPath, programBody.copy(ownerPersonId = gone)).status)
        assertEquals(streamOwner, admin.get(streamPath).body<WorkStreamResponse>().ownerPersonId)
        assertEquals(programOwner, admin.get(programPath).body<ProgramResponse>().ownerPersonId)
    }

    @Test
    fun `names are unique per scope among active rows - streams and programs globally, projects within their program`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("uq")
        val admin = w.admin.client
        val owner = w.streamOwner.personId!!

        // Work streams: global, case-insensitive; a rename or a delete frees the name.
        val streamName = planName("Atlas")
        val first = admin.postJson("/api/v1/work-streams", ws(owner, streamName)).body<WorkStreamResponse>()
        val clash = admin.postJson("/api/v1/work-streams", ws(owner, streamName.uppercase()))
        assertEquals(HttpStatusCode.Conflict, clash.status)
        assertTrue(clash.detail().contains("work stream"))
        val other = TestPlan.workStream(owner)
        assertEquals(
            HttpStatusCode.Conflict,
            admin.putJson("/api/v1/work-streams/$other", WorkStreamUpdateRequest(streamName, null, owner, "2026-01-01")).status,
            "a rename onto an existing name",
        )
        assertEquals(
            HttpStatusCode.NoContent,
            admin.putJson(
                "/api/v1/work-streams/${first.id}",
                WorkStreamUpdateRequest(planName("Atlas2"), null, owner, "2026-01-01"),
            ).status,
        )
        assertEquals(
            HttpStatusCode.Created,
            admin.postJson("/api/v1/work-streams", ws(owner, streamName)).status,
            "a renamed stream frees its name",
        )

        // Programs: global across streams.
        val programName = planName("Apollo")
        val secondStream = TestPlan.workStream(owner)
        assertEquals(HttpStatusCode.Created, admin.postJson("/api/v1/work-streams/${w.streamId}/programs", pg(owner, programName)).status)
        val programClash = admin.postJson("/api/v1/work-streams/$secondStream/programs", pg(owner, programName.lowercase()))
        assertEquals(HttpStatusCode.Conflict, programClash.status, "the same name under ANOTHER stream still clashes")
        assertTrue(programClash.detail().contains("program"))
        val renameTarget = TestPlan.program(w.streamId, owner)
        assertEquals(
            HttpStatusCode.Conflict,
            admin.putJson("/api/v1/programs/$renameTarget", ProgramUpdateRequest(programName, null, owner)).status,
        )
        val deletedProgram = TestPlan.program(w.streamId, owner, planName("Phoenix"))
        val phoenix = admin.get("/api/v1/programs/$deletedProgram").body<ProgramResponse>().name
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/programs/$deletedProgram").status)
        assertEquals(
            HttpStatusCode.Created,
            admin.postJson("/api/v1/work-streams/${w.streamId}/programs", pg(owner, phoenix)).status,
            "a deleted program frees its name",
        )

        // Projects: unique within the program, free to repeat in another program.
        val projectName = planName("Rollout")
        assertEquals(HttpStatusCode.Created, admin.postJson("/api/v1/programs/${w.programId}/projects", pj(owner, projectName)).status)
        val projectClash = admin.postJson("/api/v1/programs/${w.programId}/projects", pj(owner, projectName.uppercase()))
        assertEquals(HttpStatusCode.Conflict, projectClash.status)
        assertTrue(projectClash.detail().contains("project"))
        val otherProgram = TestPlan.program(w.streamId, owner)
        assertEquals(
            HttpStatusCode.Created,
            admin.postJson("/api/v1/programs/$otherProgram/projects", pj(owner, projectName)).status,
            "the same project name in ANOTHER program is fine",
        )
        val sibling = TestPlan.project(w.programId, owner)
        assertEquals(
            HttpStatusCode.Conflict,
            admin.putJson("/api/v1/projects/$sibling", ProjectUpdateRequest(projectName, null, owner)).status,
            "a rename onto a sibling's name",
        )
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/projects/$sibling").status)
    }

    @Test
    fun `deleting a node with active children is 409 and succeeds once the children are gone - a closed stream still takes children`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("del")
            val admin = w.admin.client
            val owner = w.streamOwner.personId!!
            val streamId = TestPlan.workStream(owner)
            val programId = TestPlan.program(streamId, owner)
            val projectId = TestPlan.project(programId, owner)
            val revision = TestPlan.revision()

            val streamBlocked = w.streamOwner.client.delete("/api/v1/work-streams/$streamId")
            assertEquals(HttpStatusCode.Conflict, streamBlocked.status)
            assertEquals("Work stream has active programs", streamBlocked.detail())
            val programBlocked = admin.delete("/api/v1/programs/$programId")
            assertEquals(HttpStatusCode.Conflict, programBlocked.status)
            assertEquals("Program has active projects", programBlocked.detail())
            assertEquals(revision, TestPlan.revision(), "a refused delete never moves the revision")

            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/projects/$projectId").status)
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/programs/$programId").status)
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/work-streams/$streamId").status)

            // A closed work stream (an end date) is no barrier to new children (the user's answer 4).
            val closed = TestPlan.workStream(owner, endDate = "2026-06-30")
            assertEquals(HttpStatusCode.Created, admin.postJson("/api/v1/work-streams/$closed/programs", pg(owner)).status)
        }

    @Test
    fun `closing and reopening a work stream is an end-date transition on a full-replace PUT`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("close")
        val owner = w.streamOwner.personId!!
        val id = TestPlan.workStream(owner)
        val path = "/api/v1/work-streams/$id"
        val name = w.admin.client.get(path).body<WorkStreamResponse>().name
        assertEquals(
            HttpStatusCode.NoContent,
            w.streamOwner.client.putJson(path, WorkStreamUpdateRequest(name, null, owner, "2026-01-01", "2026-09-30")).status,
        )
        assertEquals("2026-09-30", w.admin.client.get(path).body<WorkStreamResponse>().endDate)
        assertEquals(
            HttpStatusCode.NoContent,
            w.streamOwner.client.putJson(path, WorkStreamUpdateRequest(name, null, owner, "2026-01-01")).status,
        )
        assertNull(w.admin.client.get(path).body<WorkStreamResponse>().endDate, "an omitted end date reopens the stream")
    }

    @Test
    fun `plan mutations audit their events and a rejected one emits nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("aud")
        val owner = w.streamOwner.personId!!
        val strangerPerson = w.stranger.personId!!
        val admin = w.admin.client
        withAuditCapture { capture ->
            val streamName = planName("audited")
            val stream = admin.postJson("/api/v1/work-streams", ws(owner, streamName)).body<WorkStreamResponse>()
            val streamId = stream.id.toLong()
            val created = capture.awaitEvent { it.message == "work_stream.created" && it.hasKeyValue("workStreamId", streamId) }
            assertNotNull(created)
            assertTrue(created.hasKeyValue("byUserId", w.admin.userId.toLong()))
            assertTrue(created.hasKeyValue("name", streamName))
            assertTrue(created.hasKeyValue("ownerPersonId", owner.toLong()))

            val path = "/api/v1/work-streams/${stream.id}"
            val plain = WorkStreamUpdateRequest(streamName, null, owner, "2026-01-01")
            admin.putJson(path, plain)
            assertNotNull(capture.awaitEvent { it.message == "work_stream.updated" && it.hasKeyValue("workStreamId", streamId) })
            assertEquals(0, capture.events.count { it.message == "work_stream.owner_changed" }, "no owner change, no owner event")
            admin.putJson(path, plain.copy(ownerPersonId = strangerPerson, endDate = "2026-12-31"))
            val ownerChanged = capture.awaitEvent { it.message == "work_stream.owner_changed" && it.hasKeyValue("workStreamId", streamId) }
            assertNotNull(ownerChanged)
            assertTrue(ownerChanged.hasKeyValue("ownerFrom", owner.toLong()))
            assertTrue(ownerChanged.hasKeyValue("ownerTo", strangerPerson.toLong()))
            assertNotNull(capture.awaitEvent { it.message == "work_stream.closed" && it.hasKeyValue("workStreamId", streamId) })
            admin.putJson(path, plain.copy(ownerPersonId = strangerPerson))
            assertNotNull(capture.awaitEvent { it.message == "work_stream.reopened" && it.hasKeyValue("workStreamId", streamId) })

            val program = admin.postJson("$path/programs", pg(owner)).body<ProgramResponse>()
            val programId = program.id.toLong()
            val programCreated = capture.awaitEvent { it.message == "program.created" && it.hasKeyValue("programId", programId) }
            assertNotNull(programCreated)
            assertTrue(programCreated.hasKeyValue("workStreamId", streamId))
            admin.putJson("/api/v1/programs/${program.id}", ProgramUpdateRequest(program.name, null, strangerPerson))
            assertNotNull(capture.awaitEvent { it.message == "program.updated" && it.hasKeyValue("programId", programId) })
            assertNotNull(capture.awaitEvent { it.message == "program.owner_changed" && it.hasKeyValue("programId", programId) })

            val project = admin.postJson("/api/v1/programs/${program.id}/projects", pj(owner)).body<ProjectResponse>()
            val projectId = project.id.toLong()
            val projectCreated = capture.awaitEvent { it.message == "project.created" && it.hasKeyValue("projectId", projectId) }
            assertNotNull(projectCreated)
            assertTrue(projectCreated.hasKeyValue("programId", programId))
            admin.putJson("/api/v1/projects/${project.id}", ProjectUpdateRequest(project.name, null, strangerPerson))
            assertNotNull(capture.awaitEvent { it.message == "project.updated" && it.hasKeyValue("projectId", projectId) })
            assertNotNull(capture.awaitEvent { it.message == "project.owner_changed" && it.hasKeyValue("projectId", projectId) })

            val window = "/api/v1/projects/${project.id}/target-window"
            admin.putJson(window, TargetWindowRequest("2026-03-01", "2026-04-01"))
            val set = capture.awaitEvent { it.message == "project.target_window_changed" && it.hasKeyValue("projectId", projectId) }
            assertNotNull(set)
            assertTrue(set.hasKeyValue("startFrom", null))
            assertTrue(set.hasKeyValue("startTo", "2026-03-01"))
            assertTrue(set.hasKeyValue("endTo", "2026-04-01"))
            admin.putJson(window, TargetWindowRequest("2026-03-01", "2026-04-01"))
            assertEquals(
                1,
                capture.events.count { it.message == "project.target_window_changed" && it.hasKeyValue("projectId", projectId) },
                "an unchanged window is not an event",
            )

            admin.delete("/api/v1/projects/${project.id}")
            assertNotNull(capture.awaitEvent { it.message == "project.deleted" && it.hasKeyValue("projectId", projectId) })
            admin.delete("/api/v1/programs/${program.id}")
            assertNotNull(capture.awaitEvent { it.message == "program.deleted" && it.hasKeyValue("programId", programId) })
            admin.delete(path)
            assertNotNull(capture.awaitEvent { it.message == "work_stream.deleted" && it.hasKeyValue("workStreamId", streamId) })

            // Rejected writes: a forbidden caller, a clash and a bad body emit no mutation event.
            val before = capture.events.count { it.message?.startsWith("work_stream.") == true }
            w.stranger.client.putJson("/api/v1/work-streams/${w.streamId}", plain)
            admin.postJson("/api/v1/work-streams", ws(owner, name = ""))
            assertEquals(
                before,
                capture.events.count { it.message?.startsWith("work_stream.") == true },
                "rejected writes audit nothing of their own",
            )
            assertNotNull(
                capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", w.stranger.userId.toLong()) },
                "the denial is audited centrally",
            )
        }
    }
}
