package ch.nokillswit

import ch.nokillswit.planning.CrossTeamAcceptRequest
import ch.nokillswit.planning.CrossTeamProposal
import ch.nokillswit.planning.CrossTeamProposalRequest
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.MAX_RUN_SCHEDULE_ITEMS
import ch.nokillswit.planning.ScheduleCheckRequest
import ch.nokillswit.planning.ScheduleCheckResponse
import ch.nokillswit.planning.ScheduleProposal
import ch.nokillswit.planning.ScheduleProposalRequest
import ch.nokillswit.planning.SkippedSchedule
import ch.nokillswit.planning.SkippedScheduleReason.STALE
import ch.nokillswit.planning.TeamScheduleBatchItem
import ch.nokillswit.planning.TeamScheduleBatchResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * `POST /schedule-proposals/check` (1.8.0): the link verdicts and the weekly load for the dates a TICKED SUBSET of a proposal would give
 * the run teams. The kernel (`checkMany`) is pinned by `CrossTeamKernelsTest`; these tests pin the guard over a body-listed team SET
 * (the run's order: body, shape 400, every team active else 404, every team managed else 403, the rest of the shape 400), the overlay
 * of the items on the STORED spans (an unticked move keeps its stored dates), the equivalence with the proposals' own post-checks, and
 * that it is a computation. 2027-01-31 is a Sunday (`asOf` of the proposals used here); 10 MD a week is 2 MD a day.
 */
class ScheduleCheckTest {
    private val ok = HttpStatusCode.OK
    private val forbidden = HttpStatusCode.Forbidden
    private val notFound = HttpStatusCode.NotFound
    private val badRequest = HttpStatusCode.BadRequest
    private val asOf = "2027-01-31"
    private val path = "/api/v1/schedule-proposals/check"

    private fun item(id: UInt, start: String?, end: String?) = TeamScheduleBatchItem(id, start, end)

    private suspend fun HttpClient.check(teamIds: List<UInt>, items: List<TeamScheduleBatchItem>): HttpResponse =
        postJson(path, ScheduleCheckRequest(teamIds, items))

    private suspend fun HttpClient.verdicts(teamIds: List<UInt>, items: List<TeamScheduleBatchItem>): ScheduleCheckResponse {
        val response = check(teamIds, items)
        assertEquals(ok, response.status, response.bodyAsText())
        return response.body()
    }

    private suspend fun HttpClient.run(teamIds: List<UInt>): CrossTeamProposal {
        val response = postJson("/api/v1/schedule-proposals", CrossTeamProposalRequest(asOf, teamIds))
        assertEquals(ok, response.status)
        return response.body()
    }

    private fun CrossTeamProposal.items() = teams.flatMap { it.moves }.map { item(it.milestoneId, it.to.start, it.to.end) }

    /**
     * Team A (`t.teamId`) holds a1 (4 MD, stored late 03-01..03-02); team B (`t.otherTeamId`) holds b1 (2 MD, unscheduled);
     * `a1 -> b1` FS. Both teams have 10 MD a week from 2027-01-04. The run puts a1 on 02-01..02-02 and b1 on 02-03.
     */
    private class PairWorld(val w: PlanWorld, val t: PlanTeams, val a1: UInt, val b1: UInt, val link: UInt) {
        val both = listOf(t.teamId, t.otherTeamId)
    }

    private suspend fun ApplicationTestBuilder.pairWorld(prefix: String): PairWorld {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        TestPlan.capacityPeriod(t.otherTeamId, "2027-01-04", 10.0)
        val a1 = TestPlan.milestone(w.projectId, t.teamId, planName("a1"), 4.0)
        TestPlan.schedule(a1, "2027-03-01", "2027-03-02")
        val b1 = TestPlan.milestone(w.projectId, t.otherTeamId, planName("b1"), 2.0)
        val link = TestPlan.dependency(milestoneRef(a1), milestoneRef(b1))
        return PairWorld(w, t, a1, b1, link)
    }

    @Test
    fun `ADMIN checks any set, a manager of every listed team checks it - one short, the project owner and others get 403`() =
        testApplication {
            val r = pairWorld("scg")
            val w = r.w
            val t = r.t
            val items = listOf(item(r.a1, "2027-02-01", "2027-02-02"))
            val both = planCaller("scg-both")
            val first = TestTeams.seed(planName("scg-first"), both.personId)
            val second = TestTeams.seed(planName("scg-second"), both.personId)
            val m1 = TestPlan.milestone(w.projectId, first)

            assertEquals(2, w.admin.client.verdicts(r.both, items).teams.size, "ADMIN checks teams it manages none of")
            val swapped = listOf(t.otherTeamId, t.teamId)
            assertEquals(swapped, w.admin.client.verdicts(swapped, items).teams.map { it.teamId })
            assertEquals(1, t.manager.client.verdicts(listOf(t.teamId), items).teams.size, "a manager of ONE team checks that team")
            assertEquals(2, both.client.verdicts(listOf(first, second), listOf(item(m1, "2027-02-01", "2027-02-02"))).teams.size)
            assertEquals(forbidden, both.client.check(listOf(first, t.teamId), items).status, "one team of the set is not theirs")
            assertEquals(forbidden, both.client.check(listOf(t.teamId, first), items).status, "whatever the order")
            assertEquals(forbidden, t.manager.client.check(r.both, items).status, "a manager of one of the two: 403 on the pair")
            assertEquals(forbidden, t.manager.client.check(listOf(t.otherTeamId), items).status)
            val denied = listOf(
                "project owner" to w.projectOwner, "program owner" to w.programOwner, "stream owner" to w.streamOwner,
                "stranger" to w.stranger, "personless" to w.personless, "roadmap editor" to w.editor,
            )
            for ((label, caller) in denied) {
                assertEquals(forbidden, caller.client.check(listOf(t.teamId), items).status, label)
                assertEquals(forbidden, caller.client.check(r.both, items).status, "$label on the pair")
            }
            assertEquals(HttpStatusCode.Unauthorized, jsonClient().check(listOf(t.teamId), items).status)
        }

    @Test
    fun `a missing or deleted team is 404 for every caller - before the guard, naming the ids`() = testApplication {
        val r = pairWorld("sc404")
        val gone = TestTeams.seed(planName("sc404-gone"), null)
        assertEquals(HttpStatusCode.NoContent, r.w.admin.client.delete("/api/v1/teams/$gone").status)
        val items = listOf(item(r.a1, "2027-02-01", "2027-02-02"))
        val callers = listOf(
            "stranger" to r.w.stranger, "project owner" to r.w.projectOwner, "manager" to r.t.manager, "admin" to r.w.admin,
        )
        for ((label, caller) in callers) {
            assertEquals(notFound, caller.client.check(listOf(999999u), items).status, "unknown: $label")
            assertEquals(notFound, caller.client.check(listOf(r.t.teamId, gone), items).status, "a good team and a deleted one: $label")
        }
        val detail = r.w.stranger.client.check(listOf(r.t.teamId, gone, 999999u), items).bodyAsText()
        val named = Regex("Team not found: ([0-9]+(?:, [0-9]+)*)").find(detail)?.groupValues?.get(1)?.split(", ")
        assertEquals(listOf("$gone", "999999"), named, detail)
    }

    @Test
    fun `the body decodes first, the team set is validated before the guard, the items' shape after it - bad items stay 403`() =
        testApplication {
            val r = pairWorld("sc400")
            val manager = r.t.manager.client
            val stranger = r.w.stranger.client
            val one = listOf(item(r.a1, "2027-02-01", "2027-02-02"))
            val mine = listOf(r.t.teamId)
            for (client in listOf(manager, stranger)) {
                assertEquals(badRequest, client.postJson(path, "{ not json").status)
                assertEquals(badRequest, client.postJson(path, """{"items":[]}""").status, "teamIds missing")
                assertEquals(badRequest, client.postJson(path, """{"teamIds":[${r.t.teamId}]}""").status, "items missing")
                assertEquals(badRequest, client.check(emptyList(), one).status, "no team")
                assertEquals(badRequest, client.check(listOf(r.t.teamId, r.t.teamId), one).status, "a team twice")
                assertEquals(badRequest, client.check((1u..51u).toList(), one).status, "51 teams: shape before the 404")
            }

            val bad = mapOf<String, List<TeamScheduleBatchItem>>(
                "no items" to emptyList(),
                "2001 items" to (1u..(MAX_RUN_SCHEDULE_ITEMS + 1).toUInt()).map { item(it, "2027-02-01", "2027-02-02") },
                "a milestone twice" to listOf(one.single(), item(r.a1, "2027-02-03", "2027-02-04")),
                "one date only" to listOf(item(r.a1, "2027-02-01", null)),
                "a bad date" to listOf(item(r.a1, "2027-02-30", "2027-03-01")),
                "end before start" to listOf(item(r.a1, "2027-02-05", "2027-02-01")),
                "weekend only" to listOf(item(r.a1, "2027-02-06", "2027-02-07")),
            )
            for ((label, items) in bad) {
                assertEquals(badRequest, manager.check(mine, items).status, label)
                assertEquals(forbidden, stranger.check(mine, items).status, "a forbidden caller's '$label' stays 403")
            }
            assertTrue(manager.check(mine, bad.getValue("one date only")).bodyAsText().contains("items[0]"), "the 400 names the item")
        }

    @Test
    fun `the ticked subset's verdicts - an FS pair ticked is fine, the successor alone is judged against the STORED predecessor`() =
        testApplication {
            val r = pairWorld("scv")
            val admin = r.w.admin.client
            val a1Move = item(r.a1, "2027-02-01", "2027-02-02")
            val b1Move = item(r.b1, "2027-02-03", "2027-02-03")

            val bothTicked = admin.verdicts(r.both, listOf(a1Move, b1Move))
            assertEquals(r.both, bothTicked.teams.map { it.teamId }, "in the request's order")
            assertEquals(emptyList(), bothTicked.teams.flatMap { it.dependencies }, "a1 -> b1 holds after: not reported")

            // b1 ticked, a1 NOT (stored late, 03-01..03-02): the link breaks - in BOTH teams' lists, with the date it needs.
            val successorOnly = admin.verdicts(r.both, listOf(b1Move))
            for (team in successorOnly.teams) {
                val violated = team.dependencies.single()
                assertEquals(r.link, violated.id)
                assertEquals(DependencyStatus.UNSCHEDULED, violated.before)
                assertEquals(DependencyStatus.VIOLATED, violated.check.status)
                assertEquals("2027-02-03", violated.check.actualDate)
                assertEquals("2027-03-03", violated.check.requiredDate, "the day after a1's STORED end")
            }

            // a1 ticked alone: b1 is unscheduled, so there is nothing to violate.
            assertEquals(emptyList(), admin.verdicts(r.both, listOf(a1Move)).teams.flatMap { it.dependencies })

            // The same set of teams is not needed for a team's own verdict: checking only B still judges the link against A's stored dates.
            val bOnly = admin.verdicts(listOf(r.t.otherTeamId), listOf(b1Move)).teams.single()
            assertEquals(DependencyStatus.VIOLATED, bOnly.dependencies.single().check.status)
        }

    @Test
    fun `a STALE-skipped predecessor leaves its ticked successor violating - the check says so, and the accept agrees`() =
        testApplication {
            val r = pairWorld("scs")
            val admin = r.w.admin.client
            val run = admin.run(r.both)
            val items = run.items()
            assertEquals(setOf(r.a1, r.b1), items.map { it.milestoneId }.toSet())
            val everything = admin.verdicts(r.both, items)
            assertEquals(emptyList(), everything.teams.flatMap { it.dependencies }, "with every move ticked the run's lists are exact")

            // A colleague drags a1 after the run: the accept will skip it STALE, but b1 (ticked) still lands.
            TestPlan.schedule(r.a1, "2027-02-15", "2027-02-16")
            val b1Only = items.filter { it.milestoneId == r.b1 }
            val predicted = admin.verdicts(r.both, b1Only)
            val violated = predicted.teams.first().dependencies.single()
            assertEquals(DependencyStatus.VIOLATED, violated.check.status, "b1 starts 02-03, before the colleague's a1 ends")
            assertEquals("2027-02-17", violated.check.requiredDate, "the check reads a1's CURRENT dates, not the proposal's")

            val accept = CrossTeamAcceptRequest(run.revision, run.scopeHash, r.both, items)
            val response = admin.postJson("/api/v1/schedule-proposals/accept", accept)
            assertEquals(ok, response.status, response.bodyAsText())
            val result = response.body<TeamScheduleBatchResponse>()
            assertEquals(listOf(r.b1), result.accepted)
            assertEquals(listOf(SkippedSchedule(r.a1, STALE)), result.skipped)

            // What the plan now holds is what the check had predicted for the ticked subset: the same violation.
            val now = admin.verdicts(r.both, listOf(item(r.b1, "2027-02-03", "2027-02-03")))
            val landed = now.teams.first().dependencies.single()
            assertEquals(violated.check, landed.check)
            assertEquals(DependencyStatus.VIOLATED, landed.before, "now the stored plan itself holds the violation")
            assertEquals(predicted.teams.map { it.weeks }, now.teams.map { it.weeks })
        }

    @Test
    fun `the strip follows the ticked spans - a week counts the ticked moves and the stored dates of the rest`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("scw", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        val a1 = TestPlan.milestone(w.projectId, t.teamId, planName("a1"), 4.0)
        val a2 = TestPlan.milestone(w.projectId, t.teamId, planName("a2"), 6.0)
        val kept = TestPlan.milestone(w.projectId, t.teamId, planName("kept"), 2.0)
        TestPlan.schedule(kept, "2027-03-01", "2027-03-02")
        val admin = w.admin.client
        fun loads(response: ScheduleCheckResponse) = response.teams.single().weeks.associate { it.weekStart to it.load }

        val none = loads(admin.verdicts(listOf(t.teamId), listOf(item(a1, null, null))))
        assertEquals(mapOf("2027-03-01" to 2.0), none, "only the stored milestone: unscheduling an unscheduled one is a no-op")
        val firstOnly = loads(admin.verdicts(listOf(t.teamId), listOf(item(a1, "2027-02-01", "2027-02-02"))))
        assertEquals(mapOf("2027-02-01" to 4.0, "2027-03-01" to 2.0), firstOnly.filterKeys { it in setOf("2027-02-01", "2027-03-01") })
        val both = loads(
            admin.verdicts(listOf(t.teamId), listOf(item(a1, "2027-02-01", "2027-02-02"), item(a2, "2027-02-03", "2027-02-05"))),
        )
        assertEquals(10.0, both.getValue("2027-02-01"), "4 + 6 MD in the week of 02-01")
        val secondOnly = admin.verdicts(listOf(t.teamId), listOf(item(a2, "2027-02-03", "2027-02-05"))).teams.single()
        assertEquals(6.0, secondOnly.weeks.first { it.weekStart == "2027-02-01" }.load)
        assertEquals(10.0, secondOnly.weeks.first { it.weekStart == "2027-02-01" }.capacity)
    }

    @Test
    fun `a hypothetical span beyond the 520-week window truncates the weeks - weeksTruncated is true, the window is cut at 520`() =
        testApplication {
            val r = pairWorld("sct")
            val admin = r.w.admin.client
            val near = admin.verdicts(listOf(r.t.teamId), listOf(item(r.a1, "2027-02-01", "2027-02-02"))).teams.single()
            assertEquals(false, near.weeksTruncated)
            val far = admin.verdicts(listOf(r.t.teamId), listOf(item(r.a1, "2027-02-01", "2040-12-31"))).teams.single()
            assertTrue(far.weeksTruncated, "an 11-year span exceeds the 520-week horizon")
            assertEquals(520, far.weeks.size)
        }

    @Test
    fun `an unschedule pair removes the span - the link reads UNSCHEDULED after, an earlier predecessor repairs it`() = testApplication {
        val r = pairWorld("scu")
        val admin = r.w.admin.client
        TestPlan.schedule(r.b1, "2027-02-03", "2027-02-03") // before a1's stored end: violated before any move
        val stored = admin.verdicts(r.both, listOf(item(r.b1, "2027-02-03", "2027-02-03"))).teams.first().dependencies.single()
        assertEquals(DependencyStatus.VIOLATED, stored.before)

        val unscheduled = admin.verdicts(r.both, listOf(item(r.b1, null, null)))
        for (team in unscheduled.teams) {
            val link = team.dependencies.single()
            assertEquals(DependencyStatus.VIOLATED, link.before)
            assertEquals(DependencyStatus.UNSCHEDULED, link.check.status)
        }
        assertEquals(emptyList(), unscheduled.teams.last().weeks, "B has nothing scheduled any more")

        val repaired = admin.verdicts(r.both, listOf(item(r.a1, "2027-01-18", "2027-01-19"))).teams
        for (team in repaired) {
            val link = team.dependencies.single()
            assertEquals(DependencyStatus.VIOLATED, link.before, "still listed: it WAS violated")
            assertEquals(DependencyStatus.OK, link.check.status)
        }
    }

    @Test
    fun `a milestone outside the listed teams is 400 after the guard - another team's, unknown or deleted`() = testApplication {
        val r = pairWorld("scx")
        val admin = r.w.admin.client
        val mine = listOf(r.t.teamId)
        val response = admin.check(mine, listOf(item(r.b1, "2027-02-03", "2027-02-03")))
        assertEquals(badRequest, response.status, "b1 is on team B, the check lists only A")
        assertTrue(response.bodyAsText().contains("${r.b1}"), "the 400 names the id")
        assertEquals(badRequest, admin.check(mine, listOf(item(999_999u, "2027-02-03", "2027-02-03"))).status)
        val oneBadOfTwo = listOf(item(r.a1, "2027-02-01", "2027-02-02"), item(r.b1, null, null))
        assertEquals(badRequest, admin.check(mine, oneBadOfTwo).status, "one bad of two")

        val doomed = TestPlan.milestone(r.w.projectId, r.t.teamId, planName("doomed"))
        assertEquals(ok, admin.check(mine, listOf(item(doomed, "2027-02-01", "2027-02-02"))).status)
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/$doomed").status)
        assertEquals(badRequest, admin.check(mine, listOf(item(doomed, "2027-02-01", "2027-02-02"))).status, "deleted since")
        assertEquals(forbidden, r.w.stranger.client.check(mine, listOf(item(r.b1, "2027-02-03", "2027-02-03"))).status, "403 outranks it")
    }

    @Test
    fun `the check over the spans of a proposal equals that proposal's own post-check - the per-team one, and every block of a run`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("sce", teams = true)
            val t = w.requireTeams()
            TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0, wipLimit = 2)
            TestPlan.capacityPeriod(t.otherTeamId, "2027-01-04", 10.0)
            val a = TestPlan.milestone(w.projectId, t.teamId, planName("a"), 4.0)
            val b = TestPlan.milestone(w.projectId, t.teamId, planName("b"), 6.0)
            val c = TestPlan.milestone(w.projectId, t.teamId, planName("c"), 2.0)
            TestPlan.schedule(c, "2027-04-05", "2027-04-06")
            TestPlan.dependency(milestoneRef(b), milestoneRef(c))
            val kept = TestPlan.milestone(w.projectId, t.teamId, planName("kept"), 2.0)
            TestPlan.schedule(kept, "2027-03-01", "2027-03-02")
            TestPlan.pin(kept)
            val theirs = TestPlan.milestone(w.projectId, t.otherTeamId, planName("theirs"))
            TestPlan.schedule(theirs, "2027-02-01", "2027-02-05")
            TestPlan.dependency(milestoneRef(a), milestoneRef(theirs)) // placed anyway, reported
            val other = TestPlan.milestone(w.projectId, t.otherTeamId, planName("other"), 4.0)
            TestPlan.dependency(milestoneRef(b), milestoneRef(other))

            val alone = t.manager.client.postJson("/api/v1/teams/${t.teamId}/schedule-proposal", ScheduleProposalRequest(asOf))
                .body<ScheduleProposal>()
            assertTrue(alone.moves.isNotEmpty() && alone.dependencies.isNotEmpty(), "the world moves things and reports a link")
            val perTeamItems = alone.moves.map { item(it.milestoneId, it.to.start, it.to.end) }
            val checked = t.manager.client.verdicts(listOf(t.teamId), perTeamItems).teams.single()
            assertEquals(alone.weeks, checked.weeks)
            assertEquals(alone.weeksTruncated, checked.weeksTruncated)
            assertEquals(alone.dependencies, checked.dependencies)

            val run = w.admin.client.run(listOf(t.otherTeamId, t.teamId))
            val answer = w.admin.client.verdicts(run.teams.map { it.teamId }, run.items())
            assertEquals(run.teams.map { it.teamId }, answer.teams.map { it.teamId })
            for ((block, verdict) in run.teams.zip(answer.teams)) {
                assertEquals(block.weeks, verdict.weeks, "weeks of ${block.teamId}")
                assertEquals(block.weeksTruncated, verdict.weeksTruncated)
                assertEquals(block.dependencies, verdict.dependencies, "dependencies of ${block.teamId}")
            }
        }

    @Test
    fun `a check is a computation - nothing is written, the revision stays, no audit event is emitted`() = testApplication {
        val r = pairWorld("scn")
        val revision = TestPlan.revision()
        val stamp = TestPlan.scalar("SELECT schedule_revision FROM milestones WHERE id = ${r.a1}") { it.getLong(1) }
        withAuditCapture { capture ->
            val ticked = listOf(item(r.a1, "2027-02-01", "2027-02-02"), item(r.b1, "2027-02-03", "2027-02-03"))
            val response = r.w.admin.client.verdicts(r.both, ticked)
            assertEquals(2, response.teams.size)
            assertTrue(
                capture.events.none { it.message.startsWith("milestone.") || it.message.startsWith("team.") },
                "a computation audits nothing: ${capture.events.map { it.message }}",
            )
        }
        assertEquals(revision, TestPlan.revision())
        assertEquals(stamp, TestPlan.scalar("SELECT schedule_revision FROM milestones WHERE id = ${r.a1}") { it.getLong(1) })
        assertEquals(
            "2027-03-01" to "2027-03-02",
            TestPlan.scalar("SELECT start_date::text, end_date::text FROM milestones WHERE id = ${r.a1}") {
                it.getString(1) to it.getString(2)
            },
        )
    }
}
