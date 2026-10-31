package ch.nokillswit

import ch.nokillswit.planning.MilestoneCreateRequest
import ch.nokillswit.planning.MilestoneResponse
import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.plugins.ProblemDetail
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
 * Milestones over HTTP (V14): the plan-field guard matrix (the owner chain of the project, the project's own owner included; ADMIN; a team
 * MANAGER who owns nothing edits NO plan field), read-before-guard ordering, the estimate rules and the stored `NUMERIC(8,2)` text, name
 * uniqueness per project, a team change keeping the dates, the project-delete cascade and the audit trail. The schedule PUT has its own
 * class ([MilestoneScheduleTest]). Plan and team tables are SHARED suite state: every test mints unique names and asserts on its own ids.
 */
class MilestoneTest {
    private val forbidden = HttpStatusCode.Forbidden

    private fun create(teamId: UInt, name: String = planName("ms"), estimate: Double = 2.0, description: String? = null) =
        MilestoneCreateRequest(name = name, description = description, teamId = teamId, estimateMd = estimate)

    private fun update(teamId: UInt, name: String = planName("ms"), estimate: Double = 2.0, description: String? = null) =
        MilestoneUpdateRequest(name = name, description = description, teamId = teamId, estimateMd = estimate)

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
    fun `unauthenticated requests are 401`() = testApplication {
        usePostgresTestcontainer()
        val client = jsonClient()
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/projects/1/milestones").status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/milestones/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.put("/api/v1/milestones/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.put("/api/v1/milestones/1/schedule").status)
        assertEquals(HttpStatusCode.Unauthorized, client.delete("/api/v1/milestones/1").status)
    }

    @Test
    fun `creating a milestone needs an owner of the project's chain or ADMIN - 404 before 403, 403 before the body`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("msc", teams = true)
        val t = w.requireTeams()
        val path = "/api/v1/projects/${w.projectId}/milestones"
        val denied = w.outsiders + ("team manager" to t.manager)
        for ((label, caller) in denied) {
            assertEquals(forbidden, caller.client.postJson(path, create(t.teamId)).status, label)
            assertEquals(forbidden, caller.client.rawPost(path, "{ not json").status,
                "a forbidden caller's malformed body stays 403: $label")
            assertEquals(
                HttpStatusCode.NotFound,
                caller.client.postJson("/api/v1/projects/999999/milestones", create(t.teamId)).status,
                "404 first: $label",
            )
        }
        val allowed = listOf(
            "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner, "project owner" to w.projectOwner,
        )
        for ((label, caller) in allowed) {
            val response = caller.client.postJson(path, create(t.teamId, planName("by-${label.replace(' ', '-')}"), 12.25, "d"))
            assertEquals(HttpStatusCode.Created, response.status, label)
            val milestone = response.body<MilestoneResponse>()
            assertEquals("/api/v1/milestones/${milestone.id}", response.headers["Location"])
            assertEquals(w.projectId, milestone.projectId)
            assertEquals(t.teamId, milestone.teamId)
            assertTrue(milestone.teamName.isNotBlank())
            assertEquals(12.25, milestone.estimateMd)
            assertEquals("d", milestone.description)
            assertNull(milestone.startDate, "a new milestone is always unscheduled: $label")
            assertNull(milestone.endDate)
        }
    }

    @Test
    fun `every authenticated caller reads a milestone and an unknown, deleted or orphaned id is 404`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("msr", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        for ((label, caller) in w.outsiders + ("manager" to t.manager) + ("admin" to w.admin)) {
            val response = caller.client.get("/api/v1/milestones/$id")
            assertEquals(HttpStatusCode.OK, response.status, label)
            assertEquals(id, response.body<MilestoneResponse>().id)
        }
        assertEquals(HttpStatusCode.NotFound, w.stranger.client.get("/api/v1/milestones/999999").status)
        // An ancestor that is gone hides the milestone too (the whole chain is joined active).
        val orphaned = TestPlan.milestone(w.projectId, t.teamId)
        PostgresTestSupport.connect().use { it.exec("UPDATE programs SET marked_as_deleted = TRUE WHERE id = ?", w.programId.toInt()) }
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get("/api/v1/milestones/$orphaned").status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get("/api/v1/milestones/$id").status)
    }

    @Test
    fun `updating a milestone needs an owner of the chain or ADMIN - a team manager edits no plan field`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("msu", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId, estimate = 1.0)
        val path = "/api/v1/milestones/$id"
        val denied = w.outsiders + ("team manager" to t.manager)
        for ((label, caller) in denied) {
            assertEquals(forbidden, caller.client.putJson(path, update(t.teamId)).status, "PUT as $label")
            assertEquals(forbidden, caller.client.delete(path).status, "DELETE as $label")
            assertEquals(forbidden, caller.client.rawPut(path, "{ not json").status, "malformed body stays 403: $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.putJson("/api/v1/milestones/999999", update(t.teamId)).status, label)
            assertEquals(HttpStatusCode.NotFound, caller.client.delete("/api/v1/milestones/999999").status, label)
        }
        val everyOwner = listOf(
            "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner, "project owner" to w.projectOwner,
        )
        for ((index, entry) in everyOwner.withIndex()) {
            val (label, caller) = entry
            val renamed = planName("by-${label.replace(' ', '-')}")
            val estimate = 3.0 + index
            assertEquals(HttpStatusCode.NoContent, caller.client.putJson(path, update(t.teamId, renamed, estimate, "note")).status, label)
            val stored = w.stranger.client.get(path).body<MilestoneResponse>()
            assertEquals(renamed, stored.name)
            assertEquals(estimate, stored.estimateMd)
            assertEquals("note", stored.description)
        }
        assertEquals(HttpStatusCode.NoContent, w.admin.client.putJson(path, update(t.teamId, planName("clear"))).status)
        assertNull(w.admin.client.get(path).body<MilestoneResponse>().description, "PUT is a full replace: an omitted description clears")
    }

    @Test
    fun `deleting a milestone needs an owner of the chain or ADMIN and frees its name`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("msd", teams = true)
        val t = w.requireTeams()
        val denied = w.outsiders + ("team manager" to t.manager)
        val everyOwner = listOf(
            "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner, "project owner" to w.projectOwner,
        )
        for ((label, caller) in everyOwner) {
            val name = planName("del")
            val id = TestPlan.milestone(w.projectId, t.teamId, name)
            for ((deniedLabel, outsider) in denied) {
                assertEquals(forbidden, outsider.client.delete("/api/v1/milestones/$id").status, "$deniedLabel deleting for $label")
            }
            assertEquals(HttpStatusCode.NoContent, caller.client.delete("/api/v1/milestones/$id").status, label)
            assertEquals(HttpStatusCode.NotFound, caller.client.delete("/api/v1/milestones/$id").status, "a second delete is 404")
            assertEquals(HttpStatusCode.NotFound, caller.client.get("/api/v1/milestones/$id").status)
            val again = w.admin.client.postJson("/api/v1/projects/${w.projectId}/milestones", create(t.teamId, name))
            assertEquals(HttpStatusCode.Created, again.status, "the name is free after the delete")
        }
    }

    @Test
    fun `invalid payloads are 400 and write nothing - names, descriptions, control characters, an inactive team, bad estimates`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("msv", teams = true)
            val t = w.requireTeams()
            val admin = w.admin.client
            val path = "/api/v1/projects/${w.projectId}/milestones"
            val id = TestPlan.milestone(w.projectId, t.teamId, estimate = 1.0)
            val before = TestPlan.revision()
            val gone = TestTeams.seed(planName("msv-gone"))
            TestTeams.service.delete(gone)
            val invalid = listOf(
                "blank name" to create(t.teamId, name = "  "),
                "overlong name" to create(t.teamId, name = "x".repeat(101)),
                "overlong description" to create(t.teamId, description = "d".repeat(501)),
                "control character" to create(t.teamId, name = "bad\u0007name"),
                "unknown team" to create(999_999u),
                "soft-deleted team" to create(gone),
                "negative estimate" to create(t.teamId, estimate = -0.25),
                "three decimals" to create(t.teamId, estimate = 1.125),
                "a sub-cent estimate" to create(t.teamId, estimate = 0.001),
                "one million" to create(t.teamId, estimate = 1_000_000.0),
                "above one million" to create(t.teamId, estimate = 1_000_000.5),
            )
            for ((label, body) in invalid) {
                assertEquals(HttpStatusCode.BadRequest, admin.postJson(path, body).status, "create: $label")
                val asUpdate = update(body.teamId, body.name, body.estimateMd, body.description)
                assertEquals(HttpStatusCode.BadRequest, admin.putJson("/api/v1/milestones/$id", asUpdate).status, "update: $label")
            }
            assertEquals("Unknown or deleted team ids: 999999", admin.postJson(path, create(999_999u)).detail())
            assertEquals(
                "Estimate must be a non-negative man-day figure with at most two decimals",
                admin.postJson(path, create(t.teamId, estimate = 1.125)).detail(),
            )
            for (raw in listOf(
                """{"name":"n","teamId":${t.teamId},"estimateMd":"abc"}""",
                """{"name":"n","teamId":${t.teamId},"estimateMd":1e999}""",
                """{"name":"n","teamId":${t.teamId}}""",
                """{"name":"n","estimateMd":1}""",
            )) {
                assertEquals(HttpStatusCode.BadRequest, admin.rawPost(path, raw).status, raw)
            }
            assertEquals(before, TestPlan.revision(), "no rejected write moved the revision")
            assertEquals(1.0, admin.get("/api/v1/milestones/$id").body<MilestoneResponse>().estimateMd, "nothing was written")
        }

    @Test
    fun `the estimate round-trips exactly over HTTP and is stored as NUMERIC(8,2) text equal to the sent value`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("mse", teams = true)
        val t = w.requireTeams()
        val admin = w.admin.client
        val samples = mapOf(0.0 to "0.00", 0.1 to "0.10", 0.25 to "0.25", 12.25 to "12.25", 3.0 to "3.00", 999_999.99 to "999999.99",
            0.01 to "0.01")
        for ((sent, stored) in samples) {
            val created = admin.postJson("/api/v1/projects/${w.projectId}/milestones", create(t.teamId, estimate = sent))
            assertEquals(HttpStatusCode.Created, created.status, "create $sent")
            val id = created.body<MilestoneResponse>().id
            assertEquals(sent, admin.get("/api/v1/milestones/$id").body<MilestoneResponse>().estimateMd, "read back $sent")
            assertEquals(stored, TestPlan.scalar("SELECT estimate_md::text FROM milestones WHERE id = $id") { it.getString(1) })
            assertEquals(HttpStatusCode.NoContent, admin.putJson("/api/v1/milestones/$id", update(t.teamId, planName("ms"), 7.5)).status)
            assertEquals("7.50", TestPlan.scalar("SELECT estimate_md::text FROM milestones WHERE id = $id") { it.getString(1) })
            assertEquals(HttpStatusCode.NoContent, admin.putJson("/api/v1/milestones/$id", update(t.teamId, planName("ms"), sent)).status)
            assertEquals(stored, TestPlan.scalar("SELECT estimate_md::text FROM milestones WHERE id = $id") { it.getString(1) },
                "update $sent")
        }
    }

    @Test
    fun `a negative-zero estimate is stored and audited as 0`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("msz", teams = true)
        val t = w.requireTeams()
        withAuditCapture { capture ->
            val response = w.admin.client.rawPost(
                "/api/v1/projects/${w.projectId}/milestones",
                """{"name":"${planName("negzero")}","teamId":${t.teamId},"estimateMd":-0.0}""",
            )
            assertEquals(HttpStatusCode.Created, response.status)
            val id = response.body<MilestoneResponse>().id
            assertEquals("0.00", TestPlan.scalar("SELECT estimate_md::text FROM milestones WHERE id = $id") { it.getString(1) })
            val event = capture.awaitEvent { it.message == "milestone.created" && it.hasKeyValue("milestoneId", id.toLong()) }
            assertNotNull(event)
            assertTrue(event.hasKeyValue("estimateMd", 0.0), "the audit never logs -0.0")
        }
    }

    @Test
    fun `milestone names are unique per project, case-insensitively, and renames or deletes free them`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("msn", teams = true)
        val t = w.requireTeams()
        val admin = w.admin.client
        val path = "/api/v1/projects/${w.projectId}/milestones"
        val name = planName("Discovery")
        val first = admin.postJson(path, create(t.teamId, name)).body<MilestoneResponse>()
        val clash = admin.postJson(path, create(t.teamId, name.uppercase()))
        assertEquals(HttpStatusCode.Conflict, clash.status)
        assertEquals("A milestone with this name already exists in this project", clash.detail())
        // "Discovery" recurs across projects.
        val otherProject = TestPlan.project(w.programId, w.projectOwner.personId!!)
        assertEquals(HttpStatusCode.Created, admin.postJson("/api/v1/projects/$otherProject/milestones", create(t.teamId, name)).status)
        // A rename onto another active name is a clash; keeping one's own name is not.
        val second = admin.postJson(path, create(t.teamId, planName("second"))).body<MilestoneResponse>()
        assertEquals(HttpStatusCode.Conflict, admin.putJson("/api/v1/milestones/${second.id}", update(t.teamId, name)).status)
        assertEquals(HttpStatusCode.NoContent, admin.putJson("/api/v1/milestones/${first.id}", update(t.teamId, name, 5.0)).status)
        // Renaming frees the old name; deleting frees the current one.
        assertEquals(HttpStatusCode.NoContent, admin.putJson("/api/v1/milestones/${first.id}", update(t.teamId,
            planName("renamed"))).status)
        assertEquals(HttpStatusCode.Created, admin.postJson(path, create(t.teamId, name)).status, "the renamed milestone freed its name")
        val reused = admin.postJson(path, create(t.teamId, planName("temp"))).body<MilestoneResponse>()
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/${reused.id}").status)
        assertEquals(HttpStatusCode.Created, admin.postJson(path, create(t.teamId, reused.name)).status,
            "a deleted milestone frees its name")
    }

    @Test
    fun `a team change keeps the dates, moves the scheduling right to the new team's manager and audits milestone team_changed`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("mst", teams = true)
            val t = w.requireTeams()
            val id = TestPlan.milestone(w.projectId, t.teamId, estimate = 2.0)
            TestPlan.schedule(id, "2026-11-02", "2026-11-13")
            val path = "/api/v1/milestones/$id"
            val name = w.admin.client.get(path).body<MilestoneResponse>().name
            withAuditCapture { capture ->
                assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.putJson(path, update(t.otherTeamId, name, 4.0)).status)
                val moved = w.admin.client.get(path).body<MilestoneResponse>()
                assertEquals(t.otherTeamId, moved.teamId)
                assertEquals("2026-11-02", moved.startDate, "a team change leaves the bar where it was")
                assertEquals("2026-11-13", moved.endDate)
                val event = capture.awaitEvent { it.message == "milestone.team_changed" && it.hasKeyValue("milestoneId", id.toLong()) }
                assertNotNull(event)
                assertTrue(event.hasKeyValue("teamFrom", t.teamId.toLong()))
                assertTrue(event.hasKeyValue("teamTo", t.otherTeamId.toLong()))
                assertTrue(event.hasKeyValue("byUserId", w.projectOwner.userId.toLong()))

                // The old manager lost the right, the new one inherited the bar.
                val revision = TestPlan.revision()
                val schedule = ch.nokillswit.planning.MilestoneScheduleRequest(revision, "2026-11-03", "2026-11-04")
                assertEquals(forbidden, t.manager.client.putJson("$path/schedule", schedule).status)
                assertEquals(HttpStatusCode.OK, t.otherManager.client.putJson("$path/schedule", schedule).status)

                // The same team again is an update, not a team change.
                assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.putJson(path, update(t.otherTeamId, name, 5.0)).status)
                assertNotNull(capture.awaitEvent { it.message == "milestone.updated" && it.hasKeyValue("estimateMd", 5.0) })
                assertEquals(1, capture.events.count { it.message == "milestone.team_changed" && it.hasKeyValue("milestoneId",
                    id.toLong()) })
            }
        }

    @Test
    fun `deleting a project cascades its active milestones, counts them in the audit and keeps the ranking dense`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("msx", teams = true)
        val t = w.requireTeams()
        val kept = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val keptMilestone = TestPlan.milestone(kept, t.teamId)
        val doomed = List(3) { TestPlan.milestone(w.projectId, t.teamId) }
        val alreadyGone = TestPlan.milestone(w.projectId, t.teamId)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$alreadyGone").status)
        val ranking = ch.nokillswit.planning.RankingUpdateRequest(TestPlan.revision(), listOf(w.projectId, kept))
        assertEquals(HttpStatusCode.OK, w.admin.client.putJson("/api/v1/roadmap/ranking", ranking).status)
        withAuditCapture { capture ->
            assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/${w.projectId}").status)
            val event = capture.awaitEvent { it.message == "project.deleted" && it.hasKeyValue("projectId", w.projectId.toLong()) }
            assertNotNull(event)
            assertTrue(event.hasKeyValue("milestoneCount", 3), "only the active milestones are counted")
        }
        for (id in doomed + alreadyGone) {
            assertEquals(HttpStatusCode.NotFound, w.admin.client.get("/api/v1/milestones/$id").status)
        }
        assertEquals(HttpStatusCode.OK, w.admin.client.get("/api/v1/milestones/$keptMilestone").status,
            "other projects keep their milestones")
        val position = TestPlan.scalar("SELECT position FROM roadmap_entries WHERE project_id = $kept") { it.getInt(1) }
        assertEquals(1, position, "the ranking closed the gap in the same transaction")
        // The team no longer counts the deleted milestones: only the kept project's one remains.
        assertEquals(HttpStatusCode.Conflict, w.admin.client.delete("/api/v1/teams/${t.teamId}").status)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$keptMilestone").status)
    }

    @Test
    fun `milestone mutations audit their events and a rejected one emits nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("msa", teams = true)
        val t = w.requireTeams()
        val admin = w.admin.client
        withAuditCapture { capture ->
            val name = planName("audited")
            val created = admin.postJson("/api/v1/projects/${w.projectId}/milestones", create(t.teamId, name,
                1.5)).body<MilestoneResponse>()
            val id = created.id.toLong()
            val createdEvent = capture.awaitEvent { it.message == "milestone.created" && it.hasKeyValue("milestoneId", id) }
            assertNotNull(createdEvent)
            assertTrue(createdEvent.hasKeyValue("byUserId", w.admin.userId.toLong()))
            assertTrue(createdEvent.hasKeyValue("projectId", w.projectId.toLong()))
            assertTrue(createdEvent.hasKeyValue("name", name))
            assertTrue(createdEvent.hasKeyValue("teamId", t.teamId.toLong()))
            assertTrue(createdEvent.hasKeyValue("estimateMd", 1.5))

            val renamed = planName("audited-renamed")
            admin.putJson("/api/v1/milestones/$id", update(t.teamId, renamed, 2.5))
            val updated = capture.awaitEvent { it.message == "milestone.updated" && it.hasKeyValue("milestoneId", id) }
            assertNotNull(updated)
            assertTrue(updated.hasKeyValue("name", renamed))
            assertTrue(updated.hasKeyValue("estimateMd", 2.5))
            assertEquals(0, capture.events.count { it.message == "milestone.team_changed" }, "no team change, no rights-path event")

            // Rejected writes emit nothing of their own; a 403 is the central denial.
            val before = capture.events.count { it.message?.startsWith("milestone.") == true }
            w.stranger.client.putJson("/api/v1/milestones/$id", update(t.teamId))
            admin.putJson("/api/v1/milestones/$id", update(t.teamId, name = ""))
            admin.postJson("/api/v1/projects/${w.projectId}/milestones", create(t.teamId, renamed))
            assertEquals(before, capture.events.count { it.message?.startsWith("milestone.") == true })
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", w.stranger.userId.toLong()) })

            admin.delete("/api/v1/milestones/$id")
            val deleted = capture.awaitEvent { it.message == "milestone.deleted" && it.hasKeyValue("milestoneId", id) }
            assertNotNull(deleted)
            assertTrue(deleted.hasKeyValue("projectId", w.projectId.toLong()))
        }
    }
}
