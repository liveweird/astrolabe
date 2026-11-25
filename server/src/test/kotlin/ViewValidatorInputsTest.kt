package ch.nokillswit

import ch.nokillswit.people.PersonUpdateRequest
import ch.nokillswit.planning.PlanView
import ch.nokillswit.planning.ProgramsView
import ch.nokillswit.planning.PublicHolidayCreateRequest
import ch.nokillswit.planning.PublicHolidayResponse
import ch.nokillswit.teams.CapacityPeriodRequest
import ch.nokillswit.teams.CapacityPeriodResponse
import ch.nokillswit.teams.TeamUpdateRequest
import ch.nokillswit.users.Permission
import ch.nokillswit.users.UserPermissionsUpdateRequest
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.isSuccess
import io.ktor.server.testing.testApplication
import java.time.LocalDate
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The backlog line behind the view validators (1.22), case by case: a write that is NOT plan state (a team or person rename, a
 * `ROADMAP_EDITOR` grant, a person's login link, a capacity period) changes what a view returns without moving the plan revision, and
 * the tag - a hash of the answer - moves with the document anyway. Each case reads (a tag) and re-reads once (a `304`), writes through
 * the API, asserts the plan revision did not move, then reads with the old tag (a `200`, a NEW tag, the new value in the body) and
 * once more with the new tag (a `304`). A holiday is a plan write: the revision AND the tag move. The Jira and Flow cases are
 * `ViewValidatorExternalInputsTest`'s.
 */
class ViewValidatorInputsTest {
    /**
     * Reads every one of [expectations]' urls (a `304` on the second read), runs [write], and asserts each is now a `200` with a new tag
     * and, where given, a body holding the expected text, then a `304` for the new tag. The plan revision must move exactly when
     * [planWrite] says the write is plan state.
     */
    private suspend fun HttpClient.followsWrite(
        expectations: Map<String, String?>,
        planWrite: Boolean = false,
        cuttable: Set<String> = emptySet(),
        write: suspend () -> Unit,
    ) {
        val before = expectations.keys.associateWith { assertRevalidates(it) }
        val revision = TestPlan.revision()
        write()
        if (planWrite) assertTrue(TestPlan.revision() > revision, "a plan write moves the revision") else {
            assertEquals(revision, TestPlan.revision(), "this write is not plan state: the plan revision does not move")
        }
        expectations.forEach { (url, expected) ->
            val response = conditional(url, before.getValue(url))
            // A capped document (team load: 200 rows, dependencies: 1,000 rows) of a full shared database may have cut this test's row:
            // then the write changes nothing in it, and "skip that document" is the only honest verdict.
            if (url in cuttable && response.status == HttpStatusCode.NotModified && get(url).bodyAsText().contains("\"truncated\":true")) {
                return@forEach
            }
            assertEquals(HttpStatusCode.OK, response.status, "$url: the old tag no longer matches")
            val tag = assertNotNull(response.headers[HttpHeaders.ETag], url)
            assertNotEquals(before.getValue(url), tag, "$url: a new document, a new tag")
            val text = response.bodyAsText()
            if (expected != null) assertTrue(text.contains(expected), "$url: the body holds `$expected`")
            assertNotModified(url, tag, "$url: the new tag matches")
        }
    }

    private suspend fun HttpResponse.ok(label: String) = assertTrue(status.isSuccess(), "$label: ${status} ${bodyAsText().take(200)}")

    @Test
    fun `a team rename reaches the team view, the team load, the roadmap and the dependencies`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("vitr", teams = true)
        val manager = w.requireTeams().manager
        // A name that sorts first, so the 200-row cut of the team load never hides it among the shared database's other teams.
        val teamId = TestTeams.seed("0vi-${planName("old")}", manager.personId)
        val other = w.requireTeams().otherTeamId
        val a = TestPlan.milestone(w.projectId, teamId)
        val b = TestPlan.milestone(w.projectId, other)
        TestPlan.dependency(milestoneRef(a), milestoneRef(b))
        val renamed = "0vi-renamed-${planName("new")}"
        w.stranger.client.followsWrite(
            mapOf(
                "/api/v1/views/team/$teamId" to renamed,
                "/api/v1/views/team-load" to renamed,
                "/api/v1/views/roadmap" to renamed,
                "/api/v1/views/dependencies" to renamed,
            ),
            cuttable = setOf("/api/v1/views/team-load", "/api/v1/views/dependencies"),
        ) {
            w.admin.client.putJson("/api/v1/teams/$teamId", TeamUpdateRequest(renamed, null, manager.personId)).ok("rename the team")
        }
    }

    @Test
    fun `a person rename reaches the plan view's owner and the team view's manager`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("vipr", teams = true)
        val t = w.requireTeams()
        val owner = w.projectOwner
        val ownerNew = planName("owner-renamed")
        w.stranger.client.followsWrite(mapOf("/api/v1/views/plan" to ownerNew, "/api/v1/views/project/${w.projectId}" to ownerNew)) {
            w.admin.client.putJson("/api/v1/people/${owner.personId}", PersonUpdateRequest(ownerNew, null, owner.userId)).ok("rename owner")
        }
        val managerNew = planName("manager-renamed")
        w.stranger.client.followsWrite(mapOf("/api/v1/views/team/${t.teamId}" to managerNew)) {
            val person = t.manager.personId
            w.admin.client.putJson("/api/v1/people/$person", PersonUpdateRequest(managerNew, null, t.manager.userId)).ok("rename manager")
        }
    }

    @Test
    fun `a ROADMAP_EDITOR grant and its removal move the grantee's roadmap tag and nobody else's`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("vigr")
        val grantee = planCaller("vigr-grantee")
        val roadmap = "/api/v1/views/roadmap"
        val strangerTag = w.stranger.client.assertRevalidates(roadmap)
        grantee.client.followsWrite(mapOf(roadmap to "\"editRank\":true")) {
            val grant = UserPermissionsUpdateRequest(listOf(Permission.ROADMAP_EDITOR))
            w.admin.client.putJson("/api/v1/users/${grantee.userId}/permissions", grant).ok("grant")
        }
        val unmoved = w.stranger.client.conditional(roadmap, strangerTag)
        assertEquals(HttpStatusCode.NotModified, unmoved.status, "another login's tag does not move")
        grantee.client.followsWrite(mapOf(roadmap to "\"editRank\":false")) {
            w.admin.client.putJson("/api/v1/users/${grantee.userId}/permissions", UserPermissionsUpdateRequest(emptyList())).ok("revoke")
        }
        assertEquals(HttpStatusCode.NotModified, w.stranger.client.conditional(roadmap, strangerTag).status, "nor at the removal")
    }

    @Test
    fun `a person's login link, set and cleared, moves that login's plan and project views`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("vilk")
        val login = planCaller("vilk-login", withPerson = false)
        val ownerName = planName("vilk-owner")
        val owner = TestPeople.seed(ownerName)
        val projectId = TestPlan.project(w.programId, owner)
        val views = mapOf("/api/v1/views/plan" to null, "/api/v1/views/project/$projectId" to null)
        val before = login.client.get("/api/v1/views/project/$projectId").bodyAsText()
        login.client.followsWrite(views) {
            w.admin.client.putJson("/api/v1/people/$owner", PersonUpdateRequest(ownerName, null, login.userId)).ok("link")
        }
        val linked = login.client.get("/api/v1/views/project/$projectId").bodyAsText()
        assertNotEquals(before, linked, "the link changes what the login may do")
        login.client.followsWrite(views) {
            w.admin.client.putJson("/api/v1/people/$owner", PersonUpdateRequest(ownerName, null, null)).ok("unlink")
        }
        assertEquals(before, login.client.get("/api/v1/views/project/$projectId").bodyAsText(), "and the unlink restores it")
    }

    @Test
    fun `a capacity period created, changed and deleted moves the team view and the team load`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("vicp", teams = true)
        val teamId = TestTeams.seed("0vi-${planName("cap")}", w.requireTeams().manager.personId)
        val milestone = TestPlan.milestone(w.projectId, teamId, estimate = 2.0)
        TestPlan.schedule(milestone, "2027-02-01", "2027-02-05")
        val views = mapOf("/api/v1/views/team/$teamId" to null, "/api/v1/views/team-load" to null)
        val admin = w.admin.client
        var periodId = 0u
        w.stranger.client.followsWrite(views) {
            val created = admin.postJson("/api/v1/teams/$teamId/capacity", CapacityPeriodRequest("2027-01-04", 7.5, null))
            created.ok("create the period")
            periodId = created.body<CapacityPeriodResponse>().id
        }
        w.stranger.client.followsWrite(views) {
            admin.putJson("/api/v1/capacity-periods/$periodId", CapacityPeriodRequest("2027-01-04", 1.0, null)).ok("change the period")
        }
        w.stranger.client.followsWrite(views) { admin.delete("/api/v1/capacity-periods/$periodId").ok("delete the period") }
    }

    @Test
    fun `a rename of a chain member's team moves the team view's tag with the chain parameter and not without it`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("vich", teams = true)
        val t = w.requireTeams()
        // x1 (a third team) -> y1 -> p1 (the viewed team): x1 is a member two hops away and is named in no dependencies[] row.
        val far = TestTeams.seed("0vi-${planName("far")}", null)
        val x = secondProject(w, "vich-x")
        val y = secondProject(w, "vich-y")
        val x1 = TestPlan.milestone(x.projectId, far, "x1").also { TestPlan.schedule(it, "2027-02-01", "2027-02-05") }
        val y1 = TestPlan.milestone(y.projectId, t.otherTeamId, "y1").also { TestPlan.schedule(it, "2027-02-08", "2027-02-12") }
        val p1 = TestPlan.milestone(w.projectId, t.teamId, "p1").also { TestPlan.schedule(it, "2027-02-15", "2027-02-19") }
        TestPlan.dependency(milestoneRef(x1), milestoneRef(y1))
        TestPlan.dependency(milestoneRef(y1), milestoneRef(p1))
        val plain = "/api/v1/views/team/${t.teamId}"
        val withChain = "$plain?criticalChain=true"
        val client = w.stranger.client
        val plainTag = client.assertRevalidates(plain)
        assertNotEquals(plainTag, client.assertRevalidates(withChain), "the tags with and without the parameter differ")
        val renamed = "0vi-renamed-${planName("far")}"
        client.followsWrite(mapOf(withChain to renamed)) {
            w.admin.client.putJson("/api/v1/teams/$far", TeamUpdateRequest(renamed, null, null)).ok("rename the member's team")
        }
        assertEquals(HttpStatusCode.NotModified, client.conditional(plain, plainTag).status, "the plain document holds no such name")
    }

    @Test
    fun `a holiday is a plan write - the revision and the tag both move`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("viho")
        val date = LocalDate.of(2900, 1, 1).plusDays(Random.nextLong(0, 36_000)).toString()
        var holidayId = 0u
        try {
            w.stranger.client.followsWrite(mapOf("/api/v1/views/plan" to null, "/api/v1/views/team-load" to null), planWrite = true) {
                val created = w.admin.client.postJson("/api/v1/public-holidays", PublicHolidayCreateRequest(date, planName("holiday")))
                created.ok("create the holiday")
                holidayId = created.body<PublicHolidayResponse>().id
            }
        } finally {
            if (holidayId != 0u) w.admin.client.delete("/api/v1/public-holidays/$holidayId")
        }
    }

    @Test
    fun `a program order and a work stream order write are plan state - the plan and programs tags move with the new order in the body`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("vior")
            val owner = w.streamOwner.personId!!
            val first = planName("vio-a")
            val second = planName("vio-b")
            val a = TestPlan.program(w.streamId, owner, first)
            val b = TestPlan.program(w.streamId, owner, second)
            val urls = mapOf("/api/v1/views/plan" to null, "/api/v1/views/programs" to null)
            val client = w.stranger.client
            try {
                client.followsWrite(urls, planWrite = true) {
                    w.streamOwner.client.putProgramOrder(w.streamId, 0, listOf(b, a)).ok("order the programs")
                }
                val planPrograms = client.get("/api/v1/views/plan").body<PlanView>().workStreams.single { it.id == w.streamId }
                val inPlan = planPrograms.programs.map { it.id }.filter { it != w.programId }
                assertEquals(listOf(b, a), inPlan, "the plan view draws the program order")
                val tree = client.get("/api/v1/views/programs").body<ProgramsView>().workStreams.single { it.id == w.streamId }
                val inTree = tree.programs.map { it.id }.filter { it != w.programId }
                assertEquals(listOf(b, a), inTree, "the programs view draws the program order")
                val other = TestPlan.workStream(owner)
                client.followsWrite(urls, planWrite = true) {
                    w.admin.client.putWorkStreamOrder(TestPlan.workStreamOrderRevision(), listOf(other, w.streamId)).ok("order the streams")
                }
                val mine = setOf(other, w.streamId)
                val planStreams = client.get("/api/v1/views/plan").body<PlanView>().workStreams.map { it.id }.filter { it in mine }
                assertEquals(listOf(other, w.streamId), planStreams, "the plan view draws the stream order")
                val treeStreams = client.get("/api/v1/views/programs").body<ProgramsView>().workStreams.map { it.id }.filter { it in mine }
                assertEquals(listOf(other, w.streamId), treeStreams, "the programs view draws the stream order")
            } finally {
                TestPlan.resetWorkStreamOrder()
            }
        }
}
