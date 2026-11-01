package ch.nokillswit

import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.STALE_REVISION_PROBLEM
import ch.nokillswit.planning.TeamOrderResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
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
 * The team milestone order (V17) over HTTP: `PUT /teams/{id}/milestone-order`. The order is the TEAM's own (the manager or ADMIN write
 * it, nobody else — above all not the project's owner), read-before-guard (404, 403, then the body, then the validation), compared
 * against the team's OWN order revision, a partial list with `[]` as the reset, and never reordered by a project-rank change. The
 * lifecycle half (the dense positions after a milestone leaves, the deferrable constraint, the race, the held-request re-guard) is
 * `TeamOrderLifecycleTest`.
 */
class TeamOrderTest {
    private val ok = HttpStatusCode.OK
    private val forbidden = HttpStatusCode.Forbidden

    private suspend fun HttpClient.rawOrder(teamId: UInt, body: String): HttpResponse = put("/api/v1/teams/$teamId/milestone-order") {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun PlanWorld.milestones(teamId: UInt, count: Int, projectId: UInt = this.projectId): List<UInt> =
        List(count) { TestPlan.milestone(projectId, teamId) }

    @Test
    fun `the team's manager and ADMIN reorder - the project owner and every other caller get 403, whatever they own`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tomx", teams = true)
        val t = w.requireTeams()
        val (a, b) = w.milestones(t.teamId, 2)
        assertEquals(ok, t.manager.client.putTeamOrder(t.teamId, TestPlan.revision(), listOf(a, b)).status)
        assertEquals(listOf(a, b), TestPlan.teamOrderIds(t.teamId))
        val admin = w.admin.client.putTeamOrder(t.teamId, TestPlan.revision(), listOf(b, a))
        assertEquals(ok, admin.status)
        assertEquals(TestPlan.revision(), admin.body<TeamOrderResponse>().revision, "the answer is the plan revision the write left behind")
        val denied = listOf(
            "project owner" to w.projectOwner, "program owner" to w.programOwner, "stream owner" to w.streamOwner,
            "stranger" to w.stranger, "personless" to w.personless, "roadmap editor" to w.editor,
            "the other team's manager" to t.otherManager,
        )
        val revision = TestPlan.revision()
        for ((label, caller) in denied) {
            assertEquals(forbidden, caller.client.putTeamOrder(t.teamId, revision, listOf(a)).status, label)
        }
        assertEquals(listOf(b, a), TestPlan.teamOrderIds(t.teamId), "the refused writes stored nothing")
        assertEquals(revision, TestPlan.revision(), "nor moved the plan revision")
    }

    @Test
    fun `an unknown or deleted team is 404 for every caller, and a forbidden caller's malformed body stays 403`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("to404", teams = true)
        val t = w.requireTeams()
        val gone = TestTeams.seed(planName("to404-gone"), null)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$gone").status)
        for ((label, caller) in listOf("stranger" to w.stranger, "project owner" to w.projectOwner, "manager" to t.manager,
            "admin" to w.admin)) {
            val revision = TestPlan.revision()
            assertEquals(HttpStatusCode.NotFound, caller.client.putTeamOrder(999999u, revision, emptyList()).status, "unknown: $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.putTeamOrder(gone, revision, emptyList()).status, "deleted: $label")
        }
        withAuditCapture { capture ->
            assertEquals(forbidden, w.projectOwner.client.rawOrder(t.teamId, "{ not json").status)
            assertEquals(forbidden, t.otherManager.client.rawOrder(t.teamId, """{"milestoneIds":"x"}""").status)
            val owner = w.projectOwner.userId.toLong()
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", owner) })
        }
    }

    @Test
    fun `the 400s come after the guard - bad bodies, unknown, deleted and other-team ids change nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("to400", teams = true)
        val t = w.requireTeams()
        val (a, doomed) = w.milestones(t.teamId, 2)
        val (foreign) = w.milestones(t.otherTeamId, 1)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$doomed").status)
        TestPlan.teamOrder(t.teamId, listOf(a))
        val revision = TestPlan.revision()
        val manager = t.manager.client
        val bad = mapOf(
            "duplicate" to listOf(a, a),
            "unknown" to listOf(a, 999_999u),
            "deleted" to listOf(a, doomed),
            "more than 1000" to List(1001) { 5_000_000u + it.toUInt() },
        )
        for ((label, ids) in bad) assertEquals(HttpStatusCode.BadRequest, manager.putTeamOrder(t.teamId, revision, ids).status, label)
        val otherTeam = manager.putTeamOrder(t.teamId, revision, listOf(a, foreign))
        assertEquals(HttpStatusCode.BadRequest, otherTeam.status, "a milestone of another team in the list is 400 after the guard")
        assertTrue(otherTeam.body<ProblemDetail>().detail!!.contains("$foreign"))
        val outsider = t.otherManager.client.putTeamOrder(t.teamId, revision, listOf(a, foreign))
        assertEquals(forbidden, outsider.status, "the guard outranks the ids")
        assertEquals("milestoneIds must be distinct", manager.putTeamOrder(t.teamId, revision, listOf(a, a)).body<ProblemDetail>().detail)
        assertEquals(HttpStatusCode.BadRequest, manager.putTeamOrder(t.teamId, -1, listOf(a)).status, "a negative revision")
        assertEquals(HttpStatusCode.BadRequest, manager.rawOrder(t.teamId, """{"expectedRevision":$revision,"milestoneIds":[-1]}""").status)
        assertEquals(HttpStatusCode.BadRequest, manager.rawOrder(t.teamId, """{"milestoneIds":[]}""").status, "the revision is required")
        assertEquals(listOf(a), TestPlan.teamOrderIds(t.teamId))
        assertEquals(revision, TestPlan.revision(), "a rejected PUT never moves the revision")
        assertEquals(emptyList(), TestPlan.teamOrderIds(t.otherTeamId))
    }

    @Test
    fun `a stale expectedRevision is 409 with the stale-revision type in both directions, and a first write needs only a valid one`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tostale", teams = true)
            val t = w.requireTeams()
            val (a, b, c) = w.milestones(t.teamId, 3)
            val manager = t.manager.client
            assertNull(TestPlan.teamOrderRevision(t.teamId))
            // A team never written has no revision of its own: ANY expectedRevision up to the plan revision passes.
            val first = manager.putTeamOrder(t.teamId, 0, listOf(a, b)).body<TeamOrderResponse>().revision
            assertEquals(first, TestPlan.teamOrderRevision(t.teamId))
            // The revision the PUT answered is current: chained saves with it work.
            val second = manager.putTeamOrder(t.teamId, first, listOf(b, a)).body<TeamOrderResponse>().revision
            assertEquals(first + 1, second)

            val behind = manager.putTeamOrder(t.teamId, first, listOf(a, b, c))
            assertEquals(HttpStatusCode.Conflict, behind.status)
            assertEquals(STALE_REVISION_PROBLEM, behind.body<ProblemDetail>().type)
            for (future in listOf(TestPlan.revision() + 1, Long.MAX_VALUE)) {
                val ahead = manager.putTeamOrder(t.teamId, future, listOf(a, b, c))
                assertEquals(HttpStatusCode.Conflict, ahead.status, "a view from the future: $future")
                assertEquals(STALE_REVISION_PROBLEM, ahead.body<ProblemDetail>().type)
            }
            // Stale is checked before the ids, so a stale list naming a since-deleted milestone is the reload signal, not a 400.
            assertEquals(HttpStatusCode.Conflict, manager.putTeamOrder(t.teamId, first, listOf(999_999u)).status)
            assertEquals(listOf(b, a), TestPlan.teamOrderIds(t.teamId))
            assertEquals(second, TestPlan.teamOrderRevision(t.teamId), "a rejected PUT leaves the order revision alone")
        }

    @Test
    fun `the revision is the team's own - another team's reorder, a schedule write and any plan write never stale it, nor it them`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("torev", teams = true)
            val t = w.requireTeams()
            val (a, b) = w.milestones(t.teamId, 2)
            val (x, y) = w.milestones(t.otherTeamId, 2)
            val mine = t.manager.client.putTeamOrder(t.teamId, TestPlan.revision(), listOf(a, b)).body<TeamOrderResponse>().revision

            // Other writes move the plan revision, but not this team's order revision.
            assertEquals(ok, t.otherManager.client.putTeamOrder(t.otherTeamId, TestPlan.revision(), listOf(y, x)).status)
            TestPlan.schedule(x, "2027-02-01", "2027-02-05")
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/${y}").status)
            assertEquals(ok, t.manager.client.putTeamOrder(t.teamId, mine, listOf(b, a)).status, "the held revision is still current")

            // And the reorder never stales a schedule PUT carrying a view read before it.
            val seen = TestPlan.revision()
            assertEquals(ok, t.manager.client.putTeamOrder(t.teamId, seen, listOf(a, b)).status)
            val schedule = ch.nokillswit.planning.MilestoneScheduleRequest(seen, "2027-03-01", "2027-03-05")
            assertEquals(ok, t.manager.client.putJson("/api/v1/milestones/$a/schedule", schedule).status)
        }

    @Test
    fun `a partial list stores the listed milestones only and an empty list is the reset, both bumping`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("topart", teams = true)
        val t = w.requireTeams()
        val (a, b, c) = w.milestones(t.teamId, 3)
        val manager = t.manager.client

        val before = TestPlan.revision()
        assertEquals(ok, manager.putTeamOrder(t.teamId, before, listOf(c, a)).status)
        assertEquals(listOf(1 to c, 2 to a), TestPlan.teamOrderRows(t.teamId), "b is unlisted: it has no row and follows c, a")
        assertEquals(before + 1, TestPlan.revision())

        assertEquals(ok, manager.putTeamOrder(t.teamId, before + 1, listOf(b, c, a)).status)
        assertEquals(listOf(1 to b, 2 to c, 3 to a), TestPlan.teamOrderRows(t.teamId))

        val reset = manager.putTeamOrder(t.teamId, before + 2, emptyList())
        assertEquals(ok, reset.status)
        assertEquals(emptyList(), TestPlan.teamOrderRows(t.teamId), "[] removes every row")
        assertEquals(before + 3, TestPlan.revision(), "the reset is a plan write")
        assertEquals(before + 3, reset.body<TeamOrderResponse>().revision)
        assertEquals(before + 3, TestPlan.teamOrderRevision(t.teamId), "and the team's order revision, so a stale list cannot undo it")
        assertEquals(HttpStatusCode.Conflict, manager.putTeamOrder(t.teamId, before + 2, listOf(a)).status)
    }

    @Test
    fun `a ranking PUT after an override leaves the override as it is - positions and order revision do not move`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("toA", teams = true)
        val t = w.requireTeams()
        val second = secondProject(w)
        val (h1, h2) = w.milestones(t.teamId, 2)
        val low = TestPlan.milestone(second.projectId, t.teamId)
        val newcomer = TestPlan.milestone(w.projectId, t.teamId)
        // The project rank puts w.projectId first; the manager executes the lower-ranked project's milestone first.
        fun ranking(projects: List<UInt>) = RankingUpdateRequest(TestPlan.revision(), projects)
        assertEquals(ok, w.admin.client.putJson("/api/v1/roadmap/ranking", ranking(listOf(w.projectId, second.projectId))).status)
        assertEquals(ok, t.manager.client.putTeamOrder(t.teamId, TestPlan.revision(), listOf(low, h2, h1)).status)
        val rows = TestPlan.teamOrderRows(t.teamId)
        val revision = TestPlan.teamOrderRevision(t.teamId)

        assertEquals(ok, w.admin.client.putJson("/api/v1/roadmap/ranking", ranking(listOf(second.projectId, w.projectId))).status)
        assertEquals(ok, w.admin.client.putJson("/api/v1/roadmap/ranking", ranking(emptyList())).status, "even unranking everything")
        assertEquals(rows, TestPlan.teamOrderRows(t.teamId), "a rank change never rewrites, renumbers or reorders the team's positions")
        assertEquals(revision, TestPlan.teamOrderRevision(t.teamId), "nor stamps the team's order revision")
        assertEquals(listOf(low, h2, h1), TestPlan.teamOrderIds(t.teamId))
        assertEquals(emptyList(), TestPlan.teamOrderRows(t.teamId).filter { it.second == newcomer }, "the unlisted newcomer has no row")
    }

    @Test
    fun `team_milestone_order_changed is audited on every accepted PUT, a no-op and a reset included - and on nothing else`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("toaudit", teams = true)
            val t = w.requireTeams()
            val (a, b) = w.milestones(t.teamId, 2)
            withAuditCapture { capture ->
                val first = TestPlan.revision()
                assertEquals(ok, t.manager.client.putTeamOrder(t.teamId, first, listOf(a, b)).status)
                val created = capture.awaitEvent { it.message == "team.milestone_order_changed" && it.hasKeyValue("orderTo", "$a,$b") }
                assertNotNull(created)
                assertTrue(created.hasKeyValue("byUserId", t.manager.userId.toLong()))
                assertTrue(created.hasKeyValue("teamId", t.teamId.toLong()))
                assertTrue(created.hasKeyValue("revisionFrom", first))
                assertTrue(created.hasKeyValue("revisionTo", first + 1))
                assertTrue(created.hasKeyValue("orderFrom", ""), "the default order is the empty text")

                // The same list again changes nothing and is still a plan write, so it is still on the trail.
                assertEquals(ok, w.admin.client.putTeamOrder(t.teamId, first + 1, listOf(a, b)).status)
                val noop = capture.awaitEvent { it.message == "team.milestone_order_changed" && it.hasKeyValue("orderFrom", "$a,$b") &&
                    it.hasKeyValue("orderTo", "$a,$b") }
                assertNotNull(noop)
                assertTrue(noop.hasKeyValue("byUserId", w.admin.userId.toLong()))

                assertEquals(ok, t.manager.client.putTeamOrder(t.teamId, first + 2, emptyList()).status)
                assertNotNull(capture.awaitEvent { it.message == "team.milestone_order_changed" && it.hasKeyValue("orderTo", "") })

                assertEquals(HttpStatusCode.Conflict, t.manager.client.putTeamOrder(t.teamId, first, listOf(a)).status)
                assertEquals(HttpStatusCode.BadRequest, t.manager.client.putTeamOrder(t.teamId, first + 3, listOf(a, a)).status)
                assertEquals(forbidden, w.stranger.client.putTeamOrder(t.teamId, first + 3, listOf(a)).status)
                assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", w.stranger.userId.toLong()) })
                val team = t.teamId.toLong()
                assertEquals(3, capture.events.count { it.message == "team.milestone_order_changed" && it.hasKeyValue("teamId", team) })
            }
        }
}
