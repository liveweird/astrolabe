package ch.nokillswit

import ch.nokillswit.infra.json.sha256Hex
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.STALE_SCOPE_PROBLEM
import ch.nokillswit.planning.ScheduleProposal
import ch.nokillswit.planning.ScheduleProposalRequest
import ch.nokillswit.planning.SkippedSchedule
import ch.nokillswit.planning.SkippedScheduleReason
import ch.nokillswit.planning.TeamScheduleBatchItem
import ch.nokillswit.planning.TeamScheduleBatchRequest
import ch.nokillswit.planning.TeamScheduleBatchResponse
import ch.nokillswit.plugins.ProblemDetail
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The scope check of the batch accept (v0.9.0): `POST /teams/{id}/milestone-schedules` with the proposal's `scopeHash` is refused whole
 * (409 `stale-scope`, nothing written, no bump) when the team's plan changed since the proposal beyond the batch's own milestones; a
 * dragged BATCH item stays the per-item STALE; an absent hash is the v0.8 contract. The pure fingerprint is `ScheduleScopeTest`; here
 * is the wire, with every input kind changed after a real proposal. 2027-01-31 is a Sunday (the proposal's `asOf`).
 */
class TeamScheduleScopeTest {
    private val asOf = "2027-01-31"

    /** The world: P holds the team's x1, x2, x3 (unscheduled), p (in progress, fixed) and the foreign f2, f3; Q holds the foreign g, h. */
    private class Scope(
        val w: PlanWorld,
        val t: PlanTeams,
        val q: UInt,
        val x1: UInt,
        val x2: UInt,
        val x3: UInt,
        val p: UInt,
        val f2: UInt,
        val f3: UInt,
        val g: UInt,
        val h: UInt,
        val link: UInt,
    ) {
        val x1Name = "scope-a"
        val teamIds = listOf(x1, x2, x3, p)
    }

    private suspend fun ApplicationTestBuilder.scopeWorld(prefix: String): Scope {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        val t = w.requireTeams()
        val q = secondProject(w).projectId
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        // Names order the default effective order a < b < c.
        val x1 = TestPlan.milestone(w.projectId, t.teamId, "scope-a", 2.0)
        val x2 = TestPlan.milestone(w.projectId, t.teamId, "scope-b", 2.0)
        val x3 = TestPlan.milestone(w.projectId, t.teamId, "scope-c", 2.0)
        val p = TestPlan.milestone(w.projectId, t.teamId, "scope-p", 2.0)
        TestPlan.schedule(p, "2027-01-25", "2027-01-29")
        val f2 = TestPlan.milestone(w.projectId, t.otherTeamId, "scope-f2")
        TestPlan.schedule(f2, "2027-02-15", "2027-02-19")
        val f3 = TestPlan.milestone(w.projectId, t.otherTeamId, "scope-f3")
        TestPlan.schedule(f3, "2027-04-05", "2027-04-09")
        val g = TestPlan.milestone(q, t.otherTeamId, "scope-g")
        TestPlan.schedule(g, "2027-03-01", "2027-03-05")
        val h = TestPlan.milestone(q, t.otherTeamId, "scope-h")
        TestPlan.schedule(h, "2027-03-08", "2027-03-12")
        // A foreign PROJECT binds x1 (its derived span is g..h), a foreign MILESTONE binds x2.
        val link = TestPlan.dependency(projectRef(q), milestoneRef(x1))
        TestPlan.dependency(milestoneRef(f2), milestoneRef(x2))
        return Scope(w, t, q, x1, x2, x3, p, f2, f3, g, h, link)
    }

    private suspend fun HttpClient.proposal(teamId: UInt): ScheduleProposal =
        postJson("/api/v1/teams/$teamId/schedule-proposal", ScheduleProposalRequest(asOf)).body()

    private fun ScheduleProposal.items() = moves.map { TeamScheduleBatchItem(it.milestoneId, it.to.start, it.to.end) }

    private suspend fun HttpClient.accept(
        teamId: UInt,
        proposal: ScheduleProposal,
        hash: String? = proposal.scopeHash,
        items: List<TeamScheduleBatchItem> = proposal.items(),
    ): HttpResponse = postJson("/api/v1/teams/$teamId/milestone-schedules", TeamScheduleBatchRequest(proposal.revision, items, hash))

    private fun datesOf(id: UInt): Pair<String?, String?> =
        TestPlan.scalar("SELECT start_date::text, end_date::text FROM milestones WHERE id = $id") { it.getString(1) to it.getString(2) }

    private suspend fun HttpResponse.assertStaleScope() {
        assertEquals(HttpStatusCode.Conflict, status)
        assertEquals(STALE_SCOPE_PROBLEM, body<ProblemDetail>().type)
    }

    @Test
    fun `an untouched scope accepts the whole proposal, whatever else the plan did meanwhile`() = testApplication {
        val s = scopeWorld("tss1")
        val manager = s.t.manager.client
        val proposal = manager.proposal(s.t.teamId)
        assertTrue(proposal.moves.size >= 3, "x1, x2 and x3 all move: ${proposal.moves.map { it.milestoneId }}")

        // Unrelated writes after the proposal: another team's milestone nobody links to, a rename, a far foreign reschedule.
        val stray = TestPlan.milestone(s.w.projectId, s.t.otherTeamId, planName("stray"))
        TestPlan.schedule(stray, "2027-09-06", "2027-09-10")
        assertTrue(TestPlan.revision() > proposal.revision)

        val response = manager.accept(s.t.teamId, proposal)
        assertEquals(HttpStatusCode.OK, response.status)
        val body: TeamScheduleBatchResponse = response.body()
        assertEquals(proposal.moves.map { it.milestoneId }, body.accepted)
        assertEquals(emptyList(), body.skipped)
        for (move in proposal.moves) assertEquals(move.to.start to move.to.end, datesOf(move.milestoneId))

        // The team's own accepted moves do not stale a LATER proposal's accept: the new hash is computed on the moved spans.
        TestPlan.milestone(s.w.projectId, s.t.teamId, "scope-late", 2.0)
        val next = manager.proposal(s.t.teamId)
        assertEquals(listOf("scope-late"), next.moves.map { it.name }, "only the new one still moves")
        assertEquals(HttpStatusCode.OK, manager.accept(s.t.teamId, next).status)
    }

    @Test
    fun `every kind of change to the team's plan refuses the whole batch - nothing written, no bump`() = testApplication {
        val s = scopeWorld("tss2")
        val manager = s.t.manager.client
        val admin = s.w.admin.client
        val estimate = MilestoneUpdateRequest(s.x1Name, null, s.t.teamId, 6.0)
        var linkId = s.link
        val changes: List<Pair<String, suspend () -> Any?>> = listOf(
            "a capacity period is added" to { TestPlan.capacityPeriod(s.t.teamId, "2027-06-07", 4.0) },
            "an estimate is edited" to {
                assertEquals(HttpStatusCode.NoContent, admin.putJson("/api/v1/milestones/${s.x1}", estimate).status)
            },
            "a link is added" to { linkId = TestPlan.dependency(milestoneRef(s.x3), milestoneRef(s.f3)) },
            "a link's lag is edited" to {
                assertEquals(HttpStatusCode.NoContent, admin.putDependency(linkId, DependencyType.FS, 4).status)
            },
            "a foreign predecessor milestone is rescheduled" to { TestPlan.schedule(s.f2, "2027-02-22", "2027-02-26") },
            "a foreign milestone of the predecessor project is rescheduled" to { TestPlan.schedule(s.h, "2027-03-15", "2027-03-19") },
            "the team's own order is rewritten" to { TestPlan.teamOrder(s.t.teamId, listOf(s.x3, s.x2, s.x1)) },
            "a milestone joins the team" to { TestPlan.milestone(s.w.projectId, s.t.teamId, "scope-new", 1.0) },
            "a milestone leaves the team" to {
                val away = MilestoneUpdateRequest("scope-c", null, s.t.otherTeamId, 2.0)
                assertEquals(HttpStatusCode.NoContent, admin.putJson("/api/v1/milestones/${s.x3}", away).status)
            },
            "an in-progress milestone of the team is pinned" to { TestPlan.pin(s.p) },
            "an in-progress milestone of the team, not in the batch, is dragged" to { TestPlan.schedule(s.p, "2027-01-26", "2027-01-30") },
        )
        for ((label, change) in changes) {
            val proposal = manager.proposal(s.t.teamId)
            assertTrue(proposal.moves.isNotEmpty(), "$label: there is something to accept")
            change()
            val revision = TestPlan.revision()
            val moved = proposal.moves.map { datesOf(it.milestoneId) }
            manager.accept(s.t.teamId, proposal).assertStaleScope()
            assertEquals(revision, TestPlan.revision(), "$label: a refusal bumps nothing")
            assertEquals(moved, proposal.moves.map { datesOf(it.milestoneId) }, "$label: and writes nothing")
        }
        // The first proposal after the last change is accepted.
        val fresh = manager.proposal(s.t.teamId)
        assertEquals(HttpStatusCode.OK, manager.accept(s.t.teamId, fresh).status)
    }

    @Test
    fun `a pin flipped after the proposal refuses the batch, and a proposal read with the pin in force is accepted`() = testApplication {
        val s = scopeWorld("tss8")
        val manager = s.t.manager.client
        val keep = TestPlan.milestone(s.w.projectId, s.t.teamId, "scope-keep", 2.0)
        TestPlan.schedule(keep, "2027-03-22", "2027-03-23")
        val kept = datesOf(keep)

        // Pinned AFTER the proposal: the kernel read an unpinned `keep` (it moves), so the accept is a stale-scope.
        val unpinned = manager.proposal(s.t.teamId)
        assertTrue(unpinned.moves.any { it.milestoneId == keep }, "unpinned, the proposal re-plans it")
        TestPlan.pin(keep)
        val revision = TestPlan.revision()
        manager.accept(s.t.teamId, unpinned).assertStaleScope()
        assertEquals(revision, TestPlan.revision())
        assertEquals(kept, datesOf(keep))

        // Proposed with the pin in force: `keep` is held, in `pinned`, in no other list - and the accept goes through.
        val pinned = manager.proposal(s.t.teamId)
        assertEquals(listOf(keep), pinned.pinned)
        assertTrue(pinned.moves.none { it.milestoneId == keep } && keep !in pinned.unchanged)
        assertTrue(pinned.unplaced.none { it.milestoneId == keep })
        assertEquals(HttpStatusCode.OK, manager.accept(s.t.teamId, pinned).status)
        assertEquals(kept, datesOf(keep), "the pinned dates stood")

        // Unpinned AFTER a proposal: stale again (a fresh unscheduled milestone keeps something to accept).
        TestPlan.milestone(s.w.projectId, s.t.teamId, "scope-late", 2.0)
        val again = manager.proposal(s.t.teamId)
        assertTrue(again.moves.isNotEmpty())
        TestPlan.pin(keep, pinned = false)
        manager.accept(s.t.teamId, again).assertStaleScope()
    }

    @Test
    fun `a holiday that changes no accepted date is accepted and the dates are written - a far-off one and a near one`() = testApplication {
        val s = scopeWorld("tss3")
        val manager = s.t.manager.client
        // Far off: a year after everything the proposal placed. Near: a free Wednesday between the last two placements (nobody's day).
        for (holiday in listOf("2028-08-16", "2027-03-03")) {
            val proposal = manager.proposal(s.t.teamId)
            assertTrue(proposal.moves.size >= 3, "x1, x2 and x3 all move: ${proposal.moves.map { it.milestoneId }}")
            assertTrue(proposal.moves.none { holiday >= it.to.start && holiday <= it.to.end }, "$holiday is nobody's day")
            TestHolidays.with(holiday) {
                val revision = TestPlan.revision() // a holiday write bumps the plan revision
                val response = manager.accept(s.t.teamId, proposal)
                assertEquals(HttpStatusCode.OK, response.status, holiday)
                val body: TeamScheduleBatchResponse = response.body()
                assertEquals(proposal.moves.map { it.milestoneId }, body.accepted, holiday)
                assertEquals(emptyList(), body.skipped, holiday)
                assertEquals(revision + 1, body.revision, "$holiday: the one bump of the batch")
                for (move in proposal.moves) assertEquals(move.to.start to move.to.end, datesOf(move.milestoneId), holiday)
            }
            // Back to the premise of the next round: the written spans leave the structure alone, but the milestones are unscheduled.
            for (move in proposal.moves) TestPlan.schedule(move.milestoneId, null, null)
        }
    }

    @Test
    fun `a holiday inside an accepted span refuses the batch - for every item of it - nothing written, no bump`() = testApplication {
        val s = scopeWorld("tss9")
        val manager = s.t.manager.client
        val proposal = manager.proposal(s.t.teamId)
        assertTrue(proposal.moves.size >= 3, "x1, x2 and x3 all move: ${proposal.moves.map { it.milestoneId }}")
        // One holiday per accepted item, on its first day: the look-again gives THAT item (at least) another date, whichever it is.
        for (move in proposal.moves) {
            TestHolidays.with(move.to.start) {
                val revision = TestPlan.revision() // a holiday write bumps the plan revision
                manager.accept(s.t.teamId, proposal).assertStaleScope()
                assertEquals(revision, TestPlan.revision(), "${move.name}: a refusal bumps nothing")
                assertEquals(proposal.moves.map { null to null }, proposal.moves.map { datesOf(it.milestoneId) }, "${move.name}: no write")
            }
        }
        assertEquals(HttpStatusCode.OK, manager.accept(s.t.teamId, proposal).status, "the holidays removed again, the proposal stands")
    }

    @Test
    fun `a holiday that moves only an unticked move is accepted for the ticked ones`() = testApplication {
        val s = scopeWorld("tss10")
        val manager = s.t.manager.client
        val proposal = manager.proposal(s.t.teamId)
        val unticked = proposal.moves.single { it.milestoneId == s.x1 }
        val ticked = proposal.moves.filter { it.milestoneId != s.x1 }
        assertTrue(ticked.size >= 2, "x2 and x3 stay: ${ticked.map { it.milestoneId }}")
        TestHolidays.with(unticked.to.start) {
            val items = ticked.map { TeamScheduleBatchItem(it.milestoneId, it.to.start, it.to.end) }
            val response = manager.accept(s.t.teamId, proposal, items = items)
            assertEquals(HttpStatusCode.OK, response.status)
            assertEquals(ticked.map { it.milestoneId }, response.body<TeamScheduleBatchResponse>().accepted)
            for (move in ticked) assertEquals(move.to.start to move.to.end, datesOf(move.milestoneId))
            assertEquals(null to null, datesOf(s.x1), "the unticked one stays where it was")
        }
    }

    @Test
    fun `an old-layout hash is 409, and the asOf part is read only when the holidays changed`() = testApplication {
        val s = scopeWorld("tss11")
        val manager = s.t.manager.client
        val proposal = manager.proposal(s.t.teamId)
        val revision = TestPlan.revision()
        // The 1.13 layout was one digest of everything: any other 64 hex differs in the structure part.
        manager.accept(s.t.teamId, proposal, sha256Hex("the 1.13 token")).assertStaleScope()
        // No code path accepts a token whose structure part differs, whatever its other parts say (the holidays part here is the real one).
        val flipped = (if (proposal.scopeHash.first() == '0') "1" else "0") + proposal.scopeHash.drop(1)
        manager.accept(s.t.teamId, proposal, flipped).assertStaleScope()
        assertEquals(revision, TestPlan.revision())
        TestHolidays.with("2028-08-16") {
            val held = TestPlan.revision()
            manager.accept(s.t.teamId, proposal, flipped).assertStaleScope()
            assertEquals(held, TestPlan.revision())
        }

        // A token whose asOf part is no plan day: with the holidays unchanged it is never decoded (no kernel runs) ...
        val badAsOf = proposal.scopeHash.take(56) + "ffffffff"
        val ok = manager.accept(s.t.teamId, proposal, badAsOf)
        assertEquals(HttpStatusCode.OK, ok.status, "an unchanged dictionary is the normal path")
        for (move in proposal.moves) TestPlan.schedule(move.milestoneId, null, null)
        // ... and with the holidays changed the look-again cannot decode it: 409, nothing written.
        TestHolidays.with("2028-08-16") {
            val before = TestPlan.revision()
            manager.accept(s.t.teamId, proposal, badAsOf).assertStaleScope()
            assertEquals(before, TestPlan.revision())
            assertEquals(null to null, datesOf(s.x1))
        }
    }

    @Test
    fun `a rank change that reorders the team's unlisted milestones refuses the batch, one that does not is fine`() = testApplication {
        val s = scopeWorld("tss4")
        val manager = s.t.manager.client
        val admin = s.w.admin.client
        val y = TestPlan.milestone(s.q, s.t.teamId, "scope-y", 2.0)
        suspend fun rank(ids: List<UInt>) = assertEquals(
            HttpStatusCode.OK, admin.putJson("/api/v1/roadmap/ranking", RankingUpdateRequest(TestPlan.revision(), ids)).status,
        )
        rank(listOf(s.w.projectId, s.q))
        val proposal = manager.proposal(s.t.teamId)
        rank(listOf(s.q, s.w.projectId))
        manager.accept(s.t.teamId, proposal).assertStaleScope()
        assertEquals(null to null, datesOf(y))

        // With the order written down the rank no longer decides: swapping it again changes nothing the kernel reads.
        TestPlan.teamOrder(s.t.teamId, s.teamIds + y)
        val listed = manager.proposal(s.t.teamId)
        rank(listOf(s.w.projectId, s.q))
        assertEquals(HttpStatusCode.OK, manager.accept(s.t.teamId, listed).status)
    }

    @Test
    fun `a dragged batch item is skipped STALE and the rest land - the fingerprint does not see the team's own spans`() = testApplication {
        val s = scopeWorld("tss5")
        val manager = s.t.manager.client
        val proposal = manager.proposal(s.t.teamId)
        // x3 sorts last by name; dated, it would sort FIRST in the dates tiebreak - the order the fingerprint ignores.
        TestPlan.schedule(s.x3, "2027-05-03", "2027-05-04")
        val response = manager.accept(s.t.teamId, proposal)
        assertEquals(HttpStatusCode.OK, response.status)
        val body: TeamScheduleBatchResponse = response.body()
        assertEquals(listOf(SkippedSchedule(s.x3, SkippedScheduleReason.STALE)), body.skipped)
        assertEquals(proposal.moves.map { it.milestoneId } - s.x3, body.accepted)
        assertEquals("2027-05-03" to "2027-05-04", datesOf(s.x3), "the colleague's dates stand")
    }

    @Test
    fun `without a scopeHash the batch is the v0_8 contract - no scope check, whatever changed`() = testApplication {
        val s = scopeWorld("tss6")
        val manager = s.t.manager.client
        val proposal = manager.proposal(s.t.teamId)
        TestPlan.capacityPeriod(s.t.teamId, "2027-06-07", 4.0)
        TestPlan.schedule(s.p, "2027-01-26", "2027-01-30")
        val response = manager.accept(s.t.teamId, proposal, hash = null)
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(proposal.moves.map { it.milestoneId }, response.body<TeamScheduleBatchResponse>().accepted)
    }

    @Test
    fun `a well-formed but wrong hash is 409, a malformed one is 400 before the lock, and the guard still comes first`() = testApplication {
        val s = scopeWorld("tss7")
        val manager = s.t.manager.client
        val proposal = manager.proposal(s.t.teamId)
        val revision = TestPlan.revision()
        manager.accept(s.t.teamId, proposal, "0".repeat(64)).assertStaleScope()
        for (bad in listOf("", "abc", "G".repeat(64), "A".repeat(64), "0".repeat(63), "0".repeat(65))) {
            assertEquals(HttpStatusCode.BadRequest, manager.accept(s.t.teamId, proposal, bad).status, "hash '$bad'")
        }
        assertEquals(HttpStatusCode.Forbidden, s.w.stranger.client.accept(s.t.teamId, proposal, "nonsense").status)
        assertEquals(revision, TestPlan.revision())
        assertEquals(HttpStatusCode.OK, manager.accept(s.t.teamId, proposal).status, "the real hash is accepted")
    }
}
