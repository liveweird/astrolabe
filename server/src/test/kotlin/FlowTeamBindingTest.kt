package ch.nokillswit

import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The team bindings' writes (`POST /integrations/flow/team-bindings`, `DELETE …/{id}`): the caller matrix (ADMIN and the team's manager
 * write; another team's manager, a project owner, an editor, a stranger and a person-less login are refused), the order of the rules (the
 * body is decoded first, then the team is resolved - 404 for every caller -, then the guard, then the rest), both 409s, unlink, a deleted
 * connection's hidden bindings and a Flow team once held by a deleted team. The mirror comes from a real run over a scripted document.
 */
class FlowTeamBindingTest {
    private companion object {
        const val PREFIX = "flowbind"
    }

    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
    }

    private suspend fun mirror(vararg teams: Pair<Int, String>): ScriptedFlowMirror =
        ScriptedFlowMirror(PREFIX).connect().refresh(*teams.map { (id, name) -> flowTeamJson(id, name) }.toTypedArray())

    @Test
    fun `ADMIN and the team's manager link a team - every other caller is 403, even with a bad flowTeamId`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbmatrix", teams = true)
        val teams = w.requireTeams()
        val m = mirror(1 to planName("fb-a"), 2 to planName("fb-b"))
        val outsiders = listOf(
            "other team's manager" to teams.otherManager, "project owner" to w.projectOwner, "program owner" to w.programOwner,
            "stream owner" to w.streamOwner, "editor" to w.editor, "stranger" to w.stranger, "person-less login" to w.personless,
        )
        for ((who, caller) in outsiders) {
            assertEquals(HttpStatusCode.Forbidden, caller.client.fbBind(m.connectionId, 1, teams.teamId).status, "$who must not link")
            assertEquals(HttpStatusCode.Forbidden, caller.client.fbBind(m.connectionId, 0, teams.teamId).status, "$who: 403 beats the 400")
            assertEquals(HttpStatusCode.Forbidden, caller.client.fbBind(999_999u, 1, teams.teamId).status, "$who: 403 beats the connection")
        }
        assertEquals(0, fbActiveCount(m.connectionId), "nothing was written")

        val response = teams.manager.client.fbBind(m.connectionId, 1, teams.teamId)
        val byManager = response.fbBinding()
        assertEquals("$FB_BINDINGS/${byManager.id}", response.headers[HttpHeaders.Location])
        assertEquals(listOf(m.connectionId, teams.teamId, 1), listOf(byManager.connectionId, byManager.teamId, byManager.flowTeamId))
        assertTrue(fbActive(byManager.id))
        // ADMIN links a team it does not manage; the manager of one team cannot link another's.
        val byAdmin = w.admin.client.fbBind(m.connectionId, 2, teams.otherTeamId).fbBinding()
        assertEquals(teams.otherTeamId, byAdmin.teamId)
        assertEquals(2, fbActiveCount(m.connectionId))
    }

    @Test
    fun `the order is body 400, team 404 for every caller, guard 403, then connection and Flow team 400`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fborder", teams = true)
        val teams = w.requireTeams()
        val m = mirror(1 to planName("fb-a"))
        val callers = listOf("admin" to w.admin, "manager" to teams.manager, "stranger" to w.stranger, "person-less login" to w.personless)
        // 1. The team is in the body: an undecodable one is a 400 for everybody - no team was addressed.
        for ((who, caller) in callers) {
            val bodies = listOf(
                "{ not json", "{}", """{"connectionId":1,"flowTeamId":"x","teamId":1}""",
                """{"connectionId":-1,"flowTeamId":1,"teamId":1}""",
            )
            for (body in bodies) {
                val response = caller.client.post(FB_BINDINGS) {
                    contentType(ContentType.Application.Json)
                    setBody(body)
                }
                assertEquals(HttpStatusCode.BadRequest, response.status, "$who: $body")
            }
        }
        // 2. An unknown or deleted team is a 404 for EVERY caller, whatever else is wrong with the request.
        for ((who, caller) in callers) {
            assertEquals(HttpStatusCode.NotFound, caller.client.fbBind(m.connectionId, 1, 999_999u).status, "$who: unknown team")
            assertEquals(HttpStatusCode.NotFound, caller.client.fbBind(999_999u, 0, 999_999u).status, "$who: the team is resolved first")
        }
        val gone = TestTeams.seed(planName("fb-gone"))
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$gone").status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.fbBind(m.connectionId, 1, gone).status)
        // 3. Past the guard the 400s apply, in the documented order.
        val admin = w.admin.client
        assertEquals(HttpStatusCode.BadRequest, admin.fbBind(m.connectionId, 0, teams.teamId).status, "flowTeamId must be positive")
        assertEquals(HttpStatusCode.BadRequest, admin.fbBind(m.connectionId, -4, teams.teamId).status)
        assertEquals(HttpStatusCode.BadRequest, admin.fbBind(999_999u, 1, teams.teamId).status, "unknown connection")
        val unknownFlowTeam = admin.fbBind(m.connectionId, 77, teams.teamId)
        assertEquals(HttpStatusCode.BadRequest, unknownFlowTeam.status)
        assertEquals("Unknown Flow team: refresh the connection", unknownFlowTeam.fbProblem().detail)
        jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", m.connectionId.toInt())
        assertEquals(HttpStatusCode.BadRequest, teams.manager.client.fbBind(m.connectionId, 1, teams.teamId).status, "disabled connection")
        assertEquals(0, fbActiveCount(m.connectionId))
    }

    @Test
    fun `a team has one Flow team and a Flow team one team - both 409s, across connections too`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbconflict", teams = true)
        val teams = w.requireTeams()
        val first = planName("fb-first")
        val second = planName("fb-second")
        val m = mirror(1 to first, 2 to second)
        val other = mirror(1 to planName("fb-elsewhere"))
        val teamName = TestTeams.rawRows().single { it.id == teams.teamId }.name
        val otherTeamName = TestTeams.rawRows().single { it.id == teams.otherTeamId }.name
        val admin = w.admin.client
        admin.fbBind(m.connectionId, 1, teams.teamId).fbBinding()

        val teamTaken = admin.fbBind(m.connectionId, 2, teams.teamId)
        assertEquals(HttpStatusCode.Conflict, teamTaken.status)
        val teamProblem = teamTaken.fbProblem()
        assertEquals("urn:astrolabe:problem:already-bound", teamProblem.type)
        assertEquals("Team $teamName is already linked to Flow team $first", teamProblem.detail)

        val flowTeamTaken = admin.fbBind(m.connectionId, 1, teams.otherTeamId)
        assertEquals(HttpStatusCode.Conflict, flowTeamTaken.status)
        val flowProblem = flowTeamTaken.fbProblem()
        assertEquals("urn:astrolabe:problem:already-bound", flowProblem.type)
        assertEquals("Flow team $first is already linked to team $teamName", flowProblem.detail)

        // One Astrolabe team has at most one Flow team across ALL connections.
        assertEquals(HttpStatusCode.Conflict, admin.fbBind(other.connectionId, 1, teams.teamId).status)
        // The refusals changed nothing, and the free pairs still link.
        assertEquals(1, fbActiveCount(m.connectionId) + fbActiveCount(other.connectionId))
        assertEquals(HttpStatusCode.Created, admin.fbBind(m.connectionId, 2, teams.otherTeamId).status, otherTeamName)
    }

    @Test
    fun `two simultaneous links of one Flow team make one binding and one 409`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbrace", teams = true)
        val teams = w.requireTeams()
        val m = mirror(1 to planName("fb-race"))
        val statuses = coroutineScope {
            listOf(teams.teamId, teams.otherTeamId)
                .map { team -> async { w.admin.client.fbBind(m.connectionId, 1, team).status } }.awaitAll()
        }
        assertEquals(listOf(HttpStatusCode.Created, HttpStatusCode.Conflict), statuses.sortedBy { it.value })
        assertEquals(1, fbActiveCount(m.connectionId))
    }

    @Test
    fun `unlink - the manager and ADMIN may, others are 403, an unknown or unlinked binding is 404 for every caller`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbunlink", teams = true)
        val teams = w.requireTeams()
        val m = mirror(1 to planName("fb-a"))
        val binding = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        val path = "$FB_BINDINGS/${binding.id}"
        val outsiders = listOf(
            "other team's manager" to teams.otherManager, "project owner" to w.projectOwner, "editor" to w.editor,
            "stranger" to w.stranger, "person-less login" to w.personless,
        )
        for ((who, caller) in outsiders) {
            assertEquals(HttpStatusCode.Forbidden, caller.client.delete(path).status, "$who must not unlink")
        }
        assertTrue(fbActive(binding.id))
        assertEquals(HttpStatusCode.NoContent, teams.manager.client.delete(path).status)
        assertEquals(false, fbActive(binding.id), "a soft delete: the row stays as history")
        // Gone is gone for everybody, and an unknown id likewise - the 404 comes before the 403.
        for ((who, caller) in outsiders + listOf("admin" to w.admin, "manager" to teams.manager)) {
            assertEquals(HttpStatusCode.NotFound, caller.client.delete(path).status, "$who: already unlinked")
            assertEquals(HttpStatusCode.NotFound, caller.client.delete("$FB_BINDINGS/999999").status, "$who: unknown")
        }
        // Both sides are free again; ADMIN may unlink too.
        val again = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("$FB_BINDINGS/${again.id}").status)
        assertEquals(0, fbActiveCount(m.connectionId))
    }

    @Test
    fun `a deleted connection's bindings are hidden and its teams can link elsewhere`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbconn", teams = true)
        val teams = w.requireTeams()
        val m = mirror(1 to planName("fb-a"))
        val elsewhere = mirror(1 to planName("fb-b"))
        val binding = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        assertNotNull(w.stranger.client.get("/api/v1/teams/${teams.teamId}/flow").bodyAsText().fbObject().fbNullable("binding"))

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("$FB_CONNECTIONS/${m.connectionId}").status)

        assertEquals(false, fbActive(binding.id), "the connection delete soft-deleted its binding")
        val panel = w.stranger.client.get("/api/v1/teams/${teams.teamId}/flow").bodyAsText()
        assertNull(panel.fbObject().fbNullable("binding"), "the panel no longer shows the link")
        assertEquals(HttpStatusCode.NotFound, w.stranger.client.get("$FB_TEAMS?connectionId=${m.connectionId}").status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.delete("$FB_BINDINGS/${binding.id}").status)
        val toDeleted = w.admin.client.fbBind(m.connectionId, 1, teams.teamId)
        assertEquals(HttpStatusCode.BadRequest, toDeleted.status, "a deleted connection is unknown")
        // The team is free: it links to a Flow team of another connection.
        assertEquals(HttpStatusCode.Created, w.admin.client.fbBind(elsewhere.connectionId, 1, teams.teamId).status)
    }

    @Test
    fun `a Flow team once linked to a team that was deleted since can be linked again - the dead holder is released`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbdead", teams = true)
        val teams = w.requireTeams()
        val flowName = planName("fb-held")
        val m = mirror(1 to flowName)
        val old = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/${teams.teamId}").status)

        // A deleted team's binding reads as no binding anywhere.
        assertEquals(emptyList(), newFlowBindingService().bindingsOf(m.connectionId))
        val listed = w.stranger.client.get("$FB_TEAMS?connectionId=${m.connectionId}").bodyAsText().fbObject()
        assertNull(listed.fbItems().single().fbNullable("boundTeamId"))
        assertEquals(HttpStatusCode.NotFound, w.admin.client.delete("$FB_BINDINGS/${old.id}").status, "the dead team's link is hidden")
        val toDeletedTeam = w.admin.client.fbBind(m.connectionId, 1, teams.teamId)
        assertEquals(HttpStatusCode.NotFound, toDeletedTeam.status, "a deleted team cannot be linked")

        withAuditCapture { audit ->
            val fresh = w.admin.client.fbBind(m.connectionId, 1, teams.otherTeamId).fbBinding()
            assertEquals(false, fbActive(old.id), "the dead holder was released")
            assertTrue(fbActive(fresh.id))
            val released = audit.awaitEvent { it.message == "flow.team_unbound" && it.hasKeyValue("bindingId", old.id.toLong()) }
            assertNotNull(released)
            assertTrue(released.hasKeyValue("reason", "TEAM_GONE") && released.hasKeyValue("teamId", teams.teamId.toLong()))
            val order = audit.events.map { it.message }
            assertTrue(order.indexOf("flow.team_unbound") < order.indexOf("flow.team_bound"), "the release is reported first")
        }
        assertEquals(1, fbActiveCount(m.connectionId))
    }
}
