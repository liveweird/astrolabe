package ch.nokillswit

import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.ScheduleProposal
import ch.nokillswit.planning.ScheduleProposalEnd
import ch.nokillswit.planning.ScheduleProposalMove
import ch.nokillswit.planning.ScheduleProposalRequest
import ch.nokillswit.planning.TeamView
import ch.nokillswit.planning.UnplacedReason
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST /teams/{id}/schedule-proposal` (v0.8.0): the auto-proposal, a computation. The team's manager or ADMIN, nobody else (above all
 * not the project owner); read-before-guard (404, 403, the body, `asOf` 400); nothing is written. The kernel's own arithmetic is pinned
 * by `ScheduleKernelsTest`; these tests pin the wire, the loading of the rows (order, capacity, holidays, other teams, links) and the
 * assembly of the document. Every date is explicit (2027-01-31 is a Sunday, so the first candidate day is Monday 2027-02-01).
 */
class ScheduleProposalTest {
    private val ok = HttpStatusCode.OK
    private val forbidden = HttpStatusCode.Forbidden
    private val asOf = "2027-01-31"

    private suspend fun HttpClient.propose(teamId: UInt, asOfDay: String = asOf): HttpResponse =
        postJson("/api/v1/teams/$teamId/schedule-proposal", ScheduleProposalRequest(asOfDay))

    private suspend fun HttpClient.proposal(teamId: UInt, asOfDay: String = asOf): ScheduleProposal {
        val response = propose(teamId, asOfDay)
        assertEquals(ok, response.status)
        return response.body()
    }

    private fun ScheduleProposal.move(id: UInt): ScheduleProposalMove = moves.single { it.milestoneId == id }

    private fun ScheduleProposalMove.span(): String = "${to.start}..${to.end}"

    private fun datesOf(id: UInt): Pair<String?, String?> =
        TestPlan.scalar("SELECT start_date::text, end_date::text FROM milestones WHERE id = $id") { it.getString(1) to it.getString(2) }

    private fun scheduleRevisionOf(id: UInt): Long =
        TestPlan.scalar("SELECT schedule_revision FROM milestones WHERE id = $id") { it.getLong(1) }

    @Test
    fun `the team's manager and ADMIN get a proposal - the project owner and every other caller get 403, whatever they own`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("spg", teams = true)
            val t = w.requireTeams()
            TestPlan.milestone(w.projectId, t.teamId)
            assertEquals(ok, t.manager.client.propose(t.teamId).status)
            assertEquals(ok, w.admin.client.propose(t.teamId).status)
            val denied = listOf(
                "project owner" to w.projectOwner, "program owner" to w.programOwner, "stream owner" to w.streamOwner,
                "stranger" to w.stranger, "personless" to w.personless, "roadmap editor" to w.editor,
                "the other team's manager" to t.otherManager,
            )
            for ((label, caller) in denied) assertEquals(forbidden, caller.client.propose(t.teamId).status, label)
            // The manager of ANOTHER team proposes for that team, not for this one.
            assertEquals(ok, t.otherManager.client.propose(t.otherTeamId).status)
        }

    @Test
    fun `an unknown or deleted team is 404 for every caller, a malformed id is 400 and a forbidden caller's malformed body stays 403`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("spg404", teams = true)
            val t = w.requireTeams()
            val gone = TestTeams.seed(planName("spg404-gone"), null)
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$gone").status)
            val callers = listOf("stranger" to w.stranger, "project owner" to w.projectOwner, "manager" to t.manager, "admin" to w.admin)
            for ((label, caller) in callers) {
                assertEquals(HttpStatusCode.NotFound, caller.client.propose(999999u).status, "unknown: $label")
                assertEquals(HttpStatusCode.NotFound, caller.client.propose(gone).status, "deleted: $label")
            }
            assertEquals(HttpStatusCode.BadRequest, t.manager.client.postJson("/api/v1/teams/abc/schedule-proposal", "{}").status)
            withAuditCapture { capture ->
                assertEquals(forbidden, w.projectOwner.client.postJson("/api/v1/teams/${t.teamId}/schedule-proposal", "{ not json").status)
                val path = "/api/v1/teams/${t.teamId}/schedule-proposal"
                assertEquals(forbidden, t.otherManager.client.postJson(path, """{"asOf":5}""").status)
                assertEquals(forbidden, w.stranger.client.propose(t.teamId, "nonsense").status, "the guard outranks a bad date")
                val ownerId = w.projectOwner.userId.toLong()
                val denied = capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", ownerId) }
                assertTrue(denied != null)
            }
        }

    @Test
    fun `asOf must be a real ISO date in the planning calendar - anything else is a 400 for the manager`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("spg400", teams = true)
        val t = w.requireTeams()
        val manager = t.manager.client
        val malformed = listOf("", "2027-1-1", "2027-02-30", "27-02-01", "2027-02-01T00:00:00Z", "+2027-02-01")
        for (bad in malformed + listOf("1899-12-31", "3000-01-01", "2999-12-31", "2990-01-06")) {
            assertEquals(HttpStatusCode.BadRequest, manager.propose(t.teamId, bad).status, "asOf '$bad'")
        }
        val path = "/api/v1/teams/${t.teamId}/schedule-proposal"
        assertEquals(HttpStatusCode.BadRequest, manager.postJson(path, "{}").status, "asOf missing")
        assertEquals(HttpStatusCode.BadRequest, manager.postJson(path, """{"asOf":5}""").status)
        assertEquals(ok, manager.propose(t.teamId, "1900-01-01").status, "the lower bound itself is fine")
        assertEquals(ok, manager.propose(t.teamId, "2990-01-05").status, "the latest asOf: 521 weeks before the last plannable day")
    }

    @Test
    fun `the three-milestone world - the predecessor is hoisted, the parallel one shares the capacity, and the figures add up`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("spw", teams = true)
            val t = w.requireTeams()
            TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0, wipLimit = 2)
            // c is scheduled late (Mon 04-05..Tue 04-06) and needs b (FS); a and b are unscheduled. Share = 10 / 5 / 2 = 1 MD a day.
            val a = TestPlan.milestone(w.projectId, t.teamId, planName("a"), 4.0)
            val b = TestPlan.milestone(w.projectId, t.teamId, planName("b"), 6.0)
            val c = TestPlan.milestone(w.projectId, t.teamId, planName("c"), 2.0)
            TestPlan.schedule(c, "2027-04-05", "2027-04-06")
            TestPlan.dependency(milestoneRef(b), milestoneRef(c))

            val proposal = t.manager.client.proposal(t.teamId)
            assertEquals(t.teamId, proposal.teamId)
            assertEquals(asOf, proposal.asOf)
            assertEquals("2027-02-01..2027-02-08", proposal.move(b).span(), "b: 6 working days, Monday to the next Monday")
            assertEquals("2027-02-09..2027-02-10", proposal.move(c).span(), "c: right after b (FS), 2 working days")
            assertEquals("2027-02-01..2027-02-04", proposal.move(a).span(), "a: parallel with b (WIP 2, 2 MD a day = the daily capacity)")
            assertEquals(listOf(c, a, b), proposal.moves.map { it.milestoneId }, "moves follow the team's order, not the placement order")
            assertEquals(listOf(6, 2, 4), listOf(b, c, a).map { proposal.move(it).workingDays })
            val before = listOf(b, c, a).map { proposal.move(it).from?.let { s -> "${s.start}..${s.end}" } }
            assertEquals(listOf(null, "2027-04-05..2027-04-06", null), before)
            assertEquals(-39, proposal.move(c).shiftDays, "39 working days earlier: Tue 02-09 against Mon 04-05")
            assertNull(proposal.move(a).shiftDays, "newly scheduled")
            assertEquals(6.0, proposal.move(b).estimateMd)
            assertEquals(emptyList(), proposal.unchanged)
            assertEquals(emptyList(), proposal.unplaced)

            assertEquals(listOf("2027-02-01", "2027-02-08"), proposal.weeks.map { it.weekStart })
            assertEquals(listOf(9.0, 3.0), proposal.weeks.map { it.load }, "5 of b + 4 of a, then 1 of b + 2 of c")
            assertEquals(listOf(10.0, 10.0), proposal.weeks.map { it.capacity })
            assertEquals(listOf(false, false), proposal.weeks.map { it.overloaded or it.wipExceeded })
            assertEquals(listOf(2, 1), proposal.weeks.map { it.maxWip }, "a and b overlap in week one; b ends Monday, c starts Tuesday")

            assertEquals(emptyList(), proposal.dependencies, "b -> c is unscheduled, then fine: only violated links are reported")

            val view: TeamView = t.manager.client.get("/api/v1/views/team/${t.teamId}").body()
            assertEquals(view.revision, proposal.revision, "the proposal's revision is the team view's: the batch's expectedRevision")
            assertEquals(listOf(c), view.scheduled.map { it.id }, "the view still shows the stored plan, untouched")
            assertEquals("2027-04-05", view.scheduled.single().startDate)
            assertEquals(setOf(a, b), view.unscheduled.map { it.id }.toSet())
        }

    @Test
    fun `a movable milestone that already sits on its earliest dates is unchanged, not a move`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("spu", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        // 10 MD at 2 MD a day is exactly the week.
        val same = TestPlan.milestone(w.projectId, t.teamId, planName("same"), 10.0)
        TestPlan.schedule(same, "2027-02-01", "2027-02-05")
        val late = TestPlan.milestone(w.projectId, t.teamId, planName("late"), 2.0)
        TestPlan.schedule(late, "2027-03-01", "2027-03-02")

        val proposal = t.manager.client.proposal(t.teamId)
        assertEquals(listOf(same), proposal.unchanged)
        assertEquals(listOf(late), proposal.moves.map { it.milestoneId })
        assertEquals("2027-02-08..2027-02-08", proposal.move(late).span(), "one day, behind the week the first one fills")
    }

    @Test
    fun `asOf splits fixed from movable - a milestone that has started stays and books its days`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("spf", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        val y = TestPlan.milestone(w.projectId, t.teamId, planName("y"), 5.0)
        TestPlan.schedule(y, "2027-02-01", "2027-02-05")
        val z = TestPlan.milestone(w.projectId, t.teamId, planName("z"), 4.0)

        val everythingMovable = t.manager.client.proposal(t.teamId, "2027-01-31")
        assertEquals("2027-02-01..2027-02-03", everythingMovable.move(y).span(), "y is re-planned at 2 MD a day: 3 days")
        assertEquals("2027-02-04..2027-02-05", everythingMovable.move(z).span())

        val started = t.manager.client.proposal(t.teamId, "2027-02-01")
        assertEquals(emptyList(), started.moves.filter { it.milestoneId == y }, "y started on asOf: fixed, not a move")
        assertTrue(y !in started.unchanged && started.unplaced.none { it.milestoneId == y })
        assertEquals("2027-02-08..2027-02-09", started.move(z).span(), "y books 1 MD a day until Friday, so z (2 MD a day) waits")
    }

    @Test
    fun `a team with no capacity period places nothing - the scheduled milestone keeps its dates and both are reported NO_CAPACITY`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("spc", teams = true)
            val t = w.requireTeams()
            val open = TestPlan.milestone(w.projectId, t.teamId, planName("open"))
            val dated = TestPlan.milestone(w.projectId, t.teamId, planName("dated"))
            TestPlan.schedule(dated, "2027-03-01", "2027-03-05")

            val proposal = t.manager.client.proposal(t.teamId)
            assertEquals(emptyList(), proposal.moves)
            assertEquals(emptyList(), proposal.unchanged)
            assertEquals(setOf(open, dated), proposal.unplaced.map { it.milestoneId }.toSet())
            assertEquals(setOf(UnplacedReason.NO_CAPACITY), proposal.unplaced.map { it.reason }.toSet())
            assertTrue(proposal.unplaced.all { it.name.isNotBlank() && it.projectName.isNotBlank() && it.projectId == w.projectId })
            assertEquals(listOf("2027-03-01"), proposal.weeks.map { it.weekStart }, "the pinned milestone's week is still reported")
            assertEquals("2027-03-01" to "2027-03-05", datesOf(dated), "and its stored dates stand")
        }

    @Test
    fun `the team's custom order drives the placement, and a capacity change changes the next answer`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("spo", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0, wipLimit = 1)
        val first = TestPlan.milestone(w.projectId, t.teamId, "alpha-${planName("m")}", 2.0)
        val second = TestPlan.milestone(w.projectId, t.teamId, "bravo-${planName("m")}", 2.0)

        val byName = t.manager.client.proposal(t.teamId)
        assertEquals("2027-02-01..2027-02-01", byName.move(first).span(), "the default order puts the lower name first")
        assertEquals("2027-02-02..2027-02-02", byName.move(second).span())

        TestPlan.teamOrder(t.teamId, listOf(second, first))
        val custom = t.manager.client.proposal(t.teamId)
        assertEquals(listOf(second, first), custom.moves.map { it.milestoneId })
        assertEquals("2027-02-01..2027-02-01", custom.move(second).span())
        assertEquals("2027-02-02..2027-02-02", custom.move(first).span())

        // No caching: a later, slower period changes the share (1 MD a day from 02-01, so 2 MD take two days).
        TestPlan.capacityPeriod(t.teamId, "2027-02-01", 5.0, wipLimit = 1)
        val slower = t.manager.client.proposal(t.teamId)
        assertEquals("2027-02-01..2027-02-02", slower.move(second).span())
        assertEquals("2027-02-03..2027-02-04", slower.move(first).span())
    }

    @Test
    fun `the holiday calendar of the day shifts a span - a holiday inside costs a calendar day, not a working day`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("sph", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0, wipLimit = 2)
        val m = TestPlan.milestone(w.projectId, t.teamId, planName("m"), 4.0)

        val plain = t.manager.client.proposal(t.teamId)
        assertEquals("2027-02-01..2027-02-04", plain.move(m).span())
        TestHolidays.with("2027-02-03") {
            val withHoliday = t.manager.client.proposal(t.teamId)
            assertEquals("2027-02-01..2027-02-05", withHoliday.move(m).span(), "4 working days skip Wednesday")
            assertEquals(4, withHoliday.move(m).workingDays)
        }
        TestHolidays.with("2027-02-01") {
            val shifted = t.manager.client.proposal(t.teamId).move(m)
            assertEquals("2027-02-02..2027-02-05", shifted.span(), "a holiday on day one moves the start")
        }
        // shiftDays counts WORKING days between the effective starts: a Monday four weeks later is 20, a holiday between makes it 19, and
        // a stored start on a Saturday counts from the Monday after it.
        val cases = listOf(scheduledAlone("shw", "2027-03-01", "2027-03-02"), scheduledAlone("shs", "2027-02-27", "2027-03-02"))
        for ((manager, team, id) in cases) {
            assertEquals("2027-02-01..2027-02-01", manager.proposal(team).move(id).span())
            assertEquals(-20, manager.proposal(team).move(id).shiftDays)
        }
        TestHolidays.with("2027-02-10") {
            for ((manager, team, id) in cases) assertEquals(-19, manager.proposal(team).move(id).shiftDays)
        }
    }

    /** A team with a flat 10 MD a week and one 2 MD milestone scheduled on the given dates: (manager client, team id, milestone id). */
    private suspend fun ApplicationTestBuilder.scheduledAlone(prefix: String, start: String, end: String): Triple<HttpClient, UInt, UInt> {
        val w = planWorld(prefix, teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        val id = TestPlan.milestone(w.projectId, t.teamId, planName("s"), 2.0)
        TestPlan.schedule(id, start, end)
        return Triple(t.manager.client, t.teamId, id)
    }

    @Test
    fun `a project end of a reported link is named by its project, its verdict reads the derived span AFTER`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("spp", teams = true)
        val t = w.requireTeams()
        val second = secondProject(w)
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        // Project P holds x (this team, unscheduled, moves to 02-01) and y (the other team, fixed 01-18..01-22): stored span 01-18..01-22.
        val x = TestPlan.milestone(w.projectId, t.teamId, planName("x"), 2.0)
        val y = TestPlan.milestone(w.projectId, t.otherTeamId, planName("y"))
        TestPlan.schedule(y, "2027-01-18", "2027-01-22")
        // P must finish before z (another project, the other team, fixed 02-01..02-05) starts: fine as stored, broken once x lands.
        val z = TestPlan.milestone(second.projectId, t.otherTeamId, planName("z"))
        TestPlan.schedule(z, "2027-02-01", "2027-02-05")
        val link = TestPlan.dependency(projectRef(w.projectId), milestoneRef(z))

        val proposal = t.manager.client.proposal(t.teamId)
        assertEquals("2027-02-01..2027-02-01", proposal.move(x).span())
        val reported = proposal.dependencies.single { it.id == link }
        assertEquals(DependencyStatus.OK, reported.before)
        assertEquals(DependencyStatus.VIOLATED, reported.check.status)
        assertEquals("2027-02-02", reported.check.requiredDate, "P's derived end after the moves is 02-01, not the stored 01-22")
        val projectEnd = ScheduleProposalEnd(EndpointKind.PROJECT, w.projectId, projectNameOf(w.projectId), null)
        assertEquals(projectEnd, reported.predecessor, "a project end: its own name, no project")
        assertEquals(EndpointKind.MILESTONE, reported.successor.kind)
        assertEquals(z, reported.successor.id)
        assertEquals(projectNameOf(second.projectId), reported.successor.projectName, "a milestone end names its project")
    }

    private fun projectNameOf(id: UInt): String = TestPlan.scalar("SELECT name FROM projects WHERE id = $id") { it.getString(1) }

    @Test
    fun `only links violated before or after are reported - a mended one carries its before, a fine one is absent`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("spl", teams = true)
            val t = w.requireTeams()
            TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
            val theirs = TestPlan.milestone(w.projectId, t.otherTeamId, planName("theirs"))
            TestPlan.schedule(theirs, "2027-02-22", "2027-02-26")
            // mended: m starts 03-01, after theirs starts 02-22 (FS m -> theirs is violated as stored); the proposal moves m to 02-01.
            val mended = TestPlan.milestone(w.projectId, t.teamId, planName("mended"), 2.0)
            TestPlan.schedule(mended, "2027-03-01", "2027-03-02")
            val mendedLink = TestPlan.dependency(milestoneRef(mended), milestoneRef(theirs))
            // fine: moves from 02-15 to 02-02..02-03 and stays before theirs (OK -> OK).
            val fine = TestPlan.milestone(w.projectId, t.teamId, planName("fine"), 2.0)
            TestPlan.schedule(fine, "2027-02-15", "2027-02-16")
            TestPlan.dependency(milestoneRef(fine), milestoneRef(theirs))
            // fresh: unscheduled, placed before theirs (UNSCHEDULED -> OK).
            val fresh = TestPlan.milestone(w.projectId, t.teamId, planName("fresh"), 2.0)
            TestPlan.dependency(milestoneRef(fresh), milestoneRef(theirs))

            val proposal = t.manager.client.proposal(t.teamId)
            assertEquals(listOf(mended, fine, fresh).toSet(), proposal.moves.map { it.milestoneId }.toSet(), "all three move")
            val reported = proposal.dependencies.single()
            assertEquals(mendedLink, reported.id)
            assertEquals(DependencyStatus.VIOLATED, reported.before)
            assertEquals(DependencyStatus.OK, reported.check.status)
            assertEquals(EndpointKind.MILESTONE, reported.predecessor.kind)
            assertEquals(mended, reported.predecessor.id)
            assertEquals(projectNameOf(w.projectId), reported.predecessor.projectName)
            assertEquals(theirs, reported.successor.id)
        }

    @Test
    fun `a link into another team's fixed milestone that the placement breaks is reported VIOLATED, before OK, and nothing is reordered`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("spd", teams = true)
            val t = w.requireTeams()
            TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0, wipLimit = 1)
            val blocker = TestPlan.milestone(w.projectId, t.teamId, planName("blocker"), 20.0)
            val m = TestPlan.milestone(w.projectId, t.teamId, planName("m"), 3.0)
            TestPlan.schedule(m, "2027-02-02", "2027-02-03")
            val theirs = TestPlan.milestone(w.projectId, t.otherTeamId, planName("theirs"))
            TestPlan.schedule(theirs, "2027-02-08", "2027-02-12")
            // m must finish before theirs starts: true on the stored dates (02-03 < 02-08).
            val link = TestPlan.dependency(milestoneRef(m), milestoneRef(theirs))
            TestPlan.teamOrder(t.teamId, listOf(blocker, m))

            val proposal = t.manager.client.proposal(t.teamId)
            assertEquals("2027-02-01..2027-02-12", proposal.move(blocker).span(), "20 MD at 2 MD a day, WIP 1: ten days")
            assertEquals("2027-02-15..2027-02-16", proposal.move(m).span(), "m waits for the blocker; the link is not avoided")
            val reported = proposal.dependencies.single { it.id == link }
            assertEquals(DependencyStatus.OK, reported.before)
            assertEquals(DependencyStatus.VIOLATED, reported.check.status)
            assertEquals(7, reported.check.shortfallDays, "theirs starts 02-08, the link needs 02-17: seven working days short")
            assertEquals("2027-02-17", reported.check.requiredDate)
            assertEquals("2027-02-08", reported.check.actualDate, "the fixed end keeps its dates")
            val moved = proposal.move(m)
            assertEquals(ScheduleProposalEnd(EndpointKind.MILESTONE, m, moved.name, moved.projectName), reported.predecessor)
            assertEquals(theirs, reported.successor.id)
            assertEquals(link, proposal.dependencies.first().id, "violated-after links come first")
            assertEquals("2027-02-08" to "2027-02-12", datesOf(theirs), "the other team's milestone is never touched")
        }

    @Test
    fun `a proposal writes nothing - no revision bump, no schedule stamp, no stored dates, no audit event`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("spn", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        val open = TestPlan.milestone(w.projectId, t.teamId)
        val dated = TestPlan.milestone(w.projectId, t.teamId)
        TestPlan.schedule(dated, "2027-05-03", "2027-05-04")
        val revision = TestPlan.revision()
        val stamp = scheduleRevisionOf(dated)
        withAuditCapture { capture ->
            val proposal = t.manager.client.proposal(t.teamId)
            assertEquals(2, proposal.moves.size)
            assertEquals(revision, proposal.revision)
            assertTrue(
                capture.events.none { it.message.startsWith("milestone.") || it.message.startsWith("team.") },
                "a computation audits nothing: ${capture.events.map { it.message }}",
            )
        }
        assertEquals(revision, TestPlan.revision())
        assertEquals(stamp, scheduleRevisionOf(dated))
        assertEquals("2027-05-03" to "2027-05-04", datesOf(dated))
        assertEquals(null to null, datesOf(open))
    }

    @Test
    fun `a dense team's proposal stays small - one hundred moves fit well under the budget`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("spz", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 50.0, wipLimit = 10)
        repeat(100) { TestPlan.milestone(w.projectId, t.teamId, "dense-${it.toString().padStart(3, '0')}-${planName("m")}", 2.0) }

        val response = t.manager.client.propose(t.teamId)
        assertEquals(ok, response.status)
        val text = response.bodyAsText()
        assertContains(text, "\"moves\"")
        assertTrue(text.length < 30_000, "the wire is ${text.length} bytes for 100 moves (about 200 each)")
    }
}
