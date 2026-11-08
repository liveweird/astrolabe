package ch.nokillswit

import ch.nokillswit.flow.FlowMatchSkipReason
import ch.nokillswit.flow.FlowTeamMatchResponse
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * "Link all suggested" (`POST …/connections/{id}/team-bindings/match`, ADMIN) and the Flow team list that shows the suggestions
 * (`GET /integrations/flow/teams`). The documents are scripted (a MockEngine Flow behind a real run) and use this test's UNIQUE team
 * names, so the match never meets another test's teams in the shared database; the stub's fixed names are proven by the kernel test.
 */
class FlowTeamMatchTest {
    private companion object {
        const val PREFIX = "flowmatch"
    }

    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
    }

    private fun matchPath(connectionId: UInt) = "$FB_CONNECTIONS/$connectionId/team-bindings/match"

    private suspend fun HttpClient.match(connectionId: UInt): HttpResponse = post(matchPath(connectionId))

    private suspend fun HttpResponse.matched(): FlowTeamMatchResponse {
        assertEquals(HttpStatusCode.OK, status, bodyAsText())
        return fbJson.decodeFromString(bodyAsText())
    }

    @Test
    fun `match by name links exactly the unique folded matches and reports the rest`() = testApplication {
        usePostgresTestcontainer()
        val admin = planCaller("fbm-ad", UserRole.ADMIN, withPerson = false).client
        val u = planName("m")
        val alpha = TestTeams.seed("alpha-$u")
        val beta = TestTeams.seed("beta   $u")
        TestTeams.seed("platnosci-$u")
        val gamma = TestTeams.seed("gamma-$u")
        TestTeams.seed("dup-$u")
        val taken = TestTeams.seed("taken-$u")
        val elsewhere = ScriptedFlowMirror(PREFIX).connect().refresh(flowTeamJson(1, "Elsewhere-$u"))
        val m = ScriptedFlowMirror(PREFIX).connect().refresh(
            flowTeamJson(1, "ALPHA-$u"), // case differs: matches alpha
            flowTeamJson(2, "Beta $u"), // whitespace differs: matches beta
            flowTeamJson(3, "Płatności-$u"), // accents count: no match for platnosci
            flowTeamJson(4, "Gamma-$u"), // linked beforehand
            flowTeamJson(5, "Dup-$u"), // two Flow teams fold to one name: neither is suggested
            flowTeamJson(6, "DUP-$u"),
            flowTeamJson(7, "Orphan-$u"), // no Astrolabe counterpart
            flowTeamJson(8, "Taken-$u"), // its team is linked to another connection's Flow team: not a candidate
        )
        admin.fbBind(m.connectionId, 4, gamma).fbBinding()
        admin.fbBind(elsewhere.connectionId, 1, taken).fbBinding()

        withAuditCapture { audit ->
            val first = admin.match(m.connectionId).matched()
            assertEquals(mapOf(1 to alpha, 2 to beta), first.bound.associate { it.flowTeamId to it.teamId })
            assertEquals(
                mapOf(
                    3 to FlowMatchSkipReason.NO_MATCH, 4 to FlowMatchSkipReason.ALREADY_BOUND, 5 to FlowMatchSkipReason.NO_MATCH,
                    6 to FlowMatchSkipReason.NO_MATCH, 7 to FlowMatchSkipReason.NO_MATCH, 8 to FlowMatchSkipReason.NO_MATCH,
                ),
                first.skipped.associate { it.flowTeamId to it.reason },
            )
            assertEquals(3, fbActiveCount(m.connectionId), "gamma was linked before; alpha and beta now")
            val summary = audit.awaitEvent { it.message == "flow.teams_matched" }
            assertNotNull(summary)
            assertTrue(
                listOf("boundCount" to 2, "skippedNoMatch" to 5, "skippedAlreadyBound" to 1, "connectionId" to m.connectionId.toLong())
                    .all { (key, value) -> summary.hasKeyValue(key, value) },
                "${summary.keyValuePairs}",
            )
            val auditedIds = summary.keyValuePairs.single { it.key == "bindingIds" }.value
            assertEquals(first.bound.map { it.bindingId }.sorted().joinToString(","), auditedIds)
            val bound = audit.events.filter { it.message == "flow.team_bound" && it.hasKeyValue("via", "match") }
            assertEquals(2, bound.size, "one flow.team_bound per link")

            // Again: nothing is left to link, and the two new links read as already linked.
            val second = admin.match(m.connectionId).matched()
            assertEquals(emptyList(), second.bound)
            val alreadyBound = second.skipped.filter { it.reason == FlowMatchSkipReason.ALREADY_BOUND }
            assertEquals(setOf(1, 2, 4), alreadyBound.map { it.flowTeamId }.toSet())
        }
    }

    @Test
    fun `match releases a deleted team's holder of a Flow team and links the new team of the same name`() = testApplication {
        usePostgresTestcontainer()
        val admin = planCaller("fbm-dead", UserRole.ADMIN, withPerson = false).client
        val u = planName("dead")
        val old = TestTeams.seed("held-$u")
        val m = ScriptedFlowMirror(PREFIX).connect().refresh(flowTeamJson(1, "Held-$u"))
        val oldBinding = admin.fbBind(m.connectionId, 1, old).fbBinding()
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/teams/$old").status)
        val fresh = TestTeams.seed("held-$u") // the deleted team's name is free again
        withAuditCapture { audit ->
            val result = admin.match(m.connectionId).matched()
            assertEquals(mapOf(1 to fresh), result.bound.associate { it.flowTeamId to it.teamId })
            assertEquals(emptyList(), result.skipped)
            assertEquals(false, fbActive(oldBinding.id), "the dead holder was released")
            assertEquals(1, fbActiveCount(m.connectionId))
            val released = assertNotNull(audit.awaitEvent { it.message == "flow.team_unbound" })
            assertTrue(released.hasKeyValue("reason", "TEAM_GONE") && released.hasKeyValue("bindingId", oldBinding.id.toLong()))
            assertNotNull(audit.awaitEvent { it.message == "flow.teams_matched" })
            val order = audit.events.map { it.message }.filter { it.startsWith("flow.team") }
            val expected = listOf("flow.team_unbound", "flow.team_bound", "flow.teams_matched")
            assertEquals(expected, order, "released, then linked, then the summary")
        }
    }

    @Test
    fun `only ADMIN may match - the guard runs before the connection is looked up`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbmguard", teams = true)
        val teams = w.requireTeams()
        val m = ScriptedFlowMirror(PREFIX).connect().refresh(flowTeamJson(1, planName("fb-a")))
        val disabled = ScriptedFlowMirror(PREFIX).connect().refresh(flowTeamJson(1, planName("fb-b")))
        jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", disabled.connectionId.toInt())
        val outsiders = listOf(
            "team's manager" to teams.manager, "other team's manager" to teams.otherManager, "project owner" to w.projectOwner,
            "editor" to w.editor, "stranger" to w.stranger, "person-less login" to w.personless,
        )
        for ((who, caller) in outsiders) {
            assertEquals(HttpStatusCode.Forbidden, caller.client.match(m.connectionId).status, who)
            assertEquals(HttpStatusCode.Forbidden, caller.client.match(999_999u).status, "$who: a uniform 403, existing or not")
        }
        assertEquals(HttpStatusCode.NotFound, w.admin.client.match(999_999u).status)
        assertEquals(HttpStatusCode.BadRequest, w.admin.client.match(disabled.connectionId).status, "a disabled connection")
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("$FB_CONNECTIONS/${m.connectionId}").status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.match(m.connectionId).status, "a deleted connection")
        jbSql("UPDATE flow_connections SET enabled = TRUE WHERE id = ?", disabled.connectionId.toInt())
        assertEquals(HttpStatusCode.OK, w.admin.client.match(disabled.connectionId).status)
    }

    @Test
    fun `the Flow team list is open to every login and shows binding, suggestion and counts - never a secret`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fblist", teams = true)
        val teams = w.requireTeams()
        val u = planName("l")
        val suggestedTeam = TestTeams.seed("sugg-$u")
        val boundName = TestTeams.rawRows().single { it.id == teams.teamId }.name
        val m = ScriptedFlowMirror(PREFIX).connect().refresh(
            flowTeamJson(1, "SUGG-$u", sprints = 3, members = 2),
            flowTeamJson(2, "Linked-$u", sprints = 0, members = 0),
            flowTeamJson(3, "Lonely-$u"),
            flowTeamJson(4, "Twin-$u"),
            flowTeamJson(5, "TWIN-$u"),
        )
        TestTeams.seed("twin-$u")
        val binding = w.admin.client.fbBind(m.connectionId, 2, teams.teamId).fbBinding()

        for (caller in listOf(w.stranger, w.personless, w.projectOwner, teams.otherManager)) {
            val response = caller.client.get("$FB_TEAMS?connectionId=${m.connectionId}")
            assertEquals(HttpStatusCode.OK, response.status)
            val text = response.bodyAsText()
            listOf("flow_int_", "flow.test", "acc-", "Member ", "apiToken", "baseUrl").forEach {
                assertTrue(it !in text, "no '$it' in $text")
            }
            val body = text.fbObject()
            assertEquals(m.connectionId.toString(), body.getValue("connectionId").jsonPrimitive.content)
            assertNotNull(body.fbNullable("teamsAt"))
            val items = body.fbItems().associateBy { it.getValue("flowTeamId").jsonPrimitive.content.toInt() }
            assertEquals(5, items.size)
            val suggested = items.getValue(1)
            assertEquals(suggestedTeam.toString(), suggested.getValue("suggestedTeamId").jsonPrimitive.content)
            assertEquals("sugg-$u", suggested.getValue("suggestedTeamName").jsonPrimitive.content)
            assertEquals(Triple("2", "3", true), Triple(
                suggested.getValue("members").jsonPrimitive.content, suggested.getValue("sprints").jsonPrimitive.content,
                suggested.fbNullable("bindingId") == null,
            ))
            val linked = items.getValue(2)
            assertEquals(binding.id.toString(), linked.getValue("bindingId").jsonPrimitive.content)
            assertEquals(teams.teamId.toString(), linked.getValue("boundTeamId").jsonPrimitive.content)
            assertEquals(boundName, linked.getValue("boundTeamName").jsonPrimitive.content)
            assertNull(linked.fbNullable("suggestedTeamId"), "a linked Flow team is never re-suggested")
            assertNull(items.getValue(3).fbNullable("suggestedTeamId"), "no counterpart")
            assertNull(items.getValue(4).fbNullable("suggestedTeamId"), "two Flow teams fold to one name")
        }
        // A disabled connection is still listed; a connection that never ran has an empty mirror.
        jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", m.connectionId.toInt())
        assertEquals(HttpStatusCode.OK, w.stranger.client.get("$FB_TEAMS?connectionId=${m.connectionId}").status)
        val fresh = ScriptedFlowMirror(PREFIX).connect()
        val empty = w.stranger.client.get("$FB_TEAMS?connectionId=${fresh.connectionId}").bodyAsText().fbObject()
        assertNull(empty.fbNullable("teamsAt"))
        assertEquals(emptyList(), empty.fbItems())
    }

    @Test
    fun `the Flow team list is 404 for an unknown connection and 400 for a bad connectionId`() = testApplication {
        usePostgresTestcontainer()
        val client = planCaller("fbl400").client
        val m = ScriptedFlowMirror(PREFIX).connect()
        assertEquals(HttpStatusCode.NotFound, client.get("$FB_TEAMS?connectionId=999999").status)
        assertEquals(HttpStatusCode.BadRequest, client.get(FB_TEAMS).status)
        assertEquals(HttpStatusCode.BadRequest, client.get("$FB_TEAMS?connectionId=abc").status)
        val repeated = "connectionId=${m.connectionId}&connectionId=${m.connectionId}"
        assertEquals(HttpStatusCode.BadRequest, client.get("$FB_TEAMS?$repeated").status)
    }
}
