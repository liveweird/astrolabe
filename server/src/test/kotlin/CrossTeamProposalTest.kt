package ch.nokillswit

import ch.nokillswit.planning.CrossTeamProposal
import ch.nokillswit.planning.CrossTeamProposalRequest
import ch.nokillswit.planning.CrossTeamProposalTeam
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.ProposalTeamList
import ch.nokillswit.planning.ScheduleProposal
import ch.nokillswit.planning.ScheduleProposalRequest
import ch.nokillswit.teams.TeamUpdateRequest
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
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * `POST /schedule-proposals` and `GET /schedule-proposals/teams` (1.8.0): the cross-team run over the wire. The kernel's arithmetic is
 * pinned by `CrossTeamKernelsTest`; these tests pin the guard over a body-listed team SET (body, shape 400, every team active else 404,
 * every team managed else 403, `asOf` 400), the loading of the rows into ONE snapshot, the document and the run-level `scopeHash`. The
 * size gate is `CrossTeamProposalSizeTest`. Every date is explicit (2027-01-31 is a Sunday, so the first candidate day is Monday
 * 2027-02-01; 10 MD a week is 2 MD a day).
 */
class CrossTeamProposalTest {
    private val ok = HttpStatusCode.OK
    private val forbidden = HttpStatusCode.Forbidden
    private val notFound = HttpStatusCode.NotFound
    private val badRequest = HttpStatusCode.BadRequest
    private val asOf = "2027-01-31"
    private val path = "/api/v1/schedule-proposals"

    private suspend fun HttpClient.propose(teamIds: List<UInt>, asOfDay: String = asOf): HttpResponse =
        postJson(path, CrossTeamProposalRequest(asOfDay, teamIds))

    private suspend fun HttpClient.run(teamIds: List<UInt>, asOfDay: String = asOf): CrossTeamProposal {
        val response = propose(teamIds, asOfDay = asOfDay)
        assertEquals(ok, response.status)
        return response.body()
    }

    private suspend fun HttpClient.perTeam(teamId: UInt): ScheduleProposal {
        val response = postJson("/api/v1/teams/$teamId/schedule-proposal", ScheduleProposalRequest(asOf))
        assertEquals(ok, response.status)
        return response.body()
    }

    private fun CrossTeamProposalTeam.span(id: UInt): String = moves.single { it.milestoneId == id }.to.let { "${it.start}..${it.end}" }

    /** A login that manages TWO teams (one person, both teams), each with the usual 10 MD a week from 2027-01-04. */
    private class TwoTeamManager(val caller: PlanCaller, val first: UInt, val second: UInt)

    private suspend fun ApplicationTestBuilder.twoTeamManager(prefix: String): TwoTeamManager {
        val caller = planCaller("$prefix-both")
        val first = TestTeams.seed(planName("$prefix-first"), caller.personId)
        val second = TestTeams.seed(planName("$prefix-second"), caller.personId)
        TestPlan.capacityPeriod(first, "2027-01-04", 10.0)
        TestPlan.capacityPeriod(second, "2027-01-04", 10.0)
        return TwoTeamManager(caller, first, second)
    }

    @Test
    fun `ADMIN runs any set, a manager of every listed team runs it - one team short, the project owner and every other caller get 403`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("ctg", teams = true)
            val t = w.requireTeams()
            val both = twoTeamManager("ctg")
            TestPlan.milestone(w.projectId, both.first)
            TestPlan.milestone(w.projectId, both.second)
            TestPlan.milestone(w.projectId, t.teamId)

            assertEquals(2, w.admin.client.run(listOf(t.teamId, t.otherTeamId)).teams.size, "ADMIN runs teams it manages none of")
            assertEquals(2, both.caller.client.run(listOf(both.first, both.second)).teams.size, "the manager of both runs both")
            assertEquals(1, both.caller.client.run(listOf(both.second)).teams.size, "and either one alone")
            assertEquals(forbidden, both.caller.client.propose(listOf(both.first, t.teamId)).status, "one team of the set is not theirs")
            assertEquals(forbidden, both.caller.client.propose(listOf(t.teamId, both.first)).status, "whatever the order of the set")
            assertEquals(forbidden, both.caller.client.propose(listOf(both.first, both.second, t.teamId)).status)

            assertEquals(1, t.manager.client.run(listOf(t.teamId)).teams.size)
            assertEquals(forbidden, t.manager.client.propose(listOf(t.teamId, t.otherTeamId)).status, "one of the two: 403 on the pair")
            assertEquals(forbidden, t.manager.client.propose(listOf(t.otherTeamId)).status, "and the other team alone")
            assertEquals(1, t.otherManager.client.run(listOf(t.otherTeamId)).teams.size)

            val denied = listOf(
                "project owner" to w.projectOwner, "program owner" to w.programOwner, "stream owner" to w.streamOwner,
                "stranger" to w.stranger, "personless" to w.personless, "roadmap editor" to w.editor,
            )
            for ((label, caller) in denied) {
                assertEquals(forbidden, caller.client.propose(listOf(t.teamId)).status, label)
                assertEquals(forbidden, caller.client.propose(listOf(t.teamId, t.otherTeamId)).status, "$label on the pair")
            }
        }

    @Test
    fun `a missing or deleted team is 404 for every caller - before the guard, naming the ids - and the 403 never leaks which exist`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("ct404", teams = true)
            val t = w.requireTeams()
            val gone = TestTeams.seed(planName("ct404-gone"), null)
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$gone").status)
            val callers = listOf("stranger" to w.stranger, "project owner" to w.projectOwner, "manager" to t.manager, "admin" to w.admin)
            for ((label, caller) in callers) {
                assertEquals(notFound, caller.client.propose(listOf(999999u)).status, "unknown: $label")
                assertEquals(notFound, caller.client.propose(listOf(gone)).status, "deleted: $label")
                assertEquals(notFound, caller.client.propose(listOf(t.teamId, gone)).status, "a good team and a deleted one: $label")
                assertEquals(notFound, caller.client.propose(listOf(t.otherTeamId, 999999u)).status, "foreign + unknown: $label")
            }
            val detail = w.stranger.client.propose(listOf(t.teamId, gone, 999999u)).bodyAsText()
            val named = Regex("Team not found: ([0-9]+(?:, [0-9]+)*)").find(detail)?.groupValues?.get(1)?.split(", ")
            assertEquals(listOf("$gone", "999999"), named, "the 404 names exactly the missing ids, in request order: $detail")
            assertEquals(forbidden, w.stranger.client.propose(listOf(t.teamId, t.otherTeamId)).status, "all active: 403")
        }

    @Test
    fun `the body decodes first and the team set is validated before the guard, asOf after it - a forbidden caller's bad asOf stays 403`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("ct400", teams = true)
            val t = w.requireTeams()
            val manager = w.requireTeams().manager.client
            val stranger = w.stranger.client

            // The team set is in the body, so a malformed body is a 400 even for a caller the guard would refuse.
            for (client in listOf(manager, stranger)) {
                assertEquals(badRequest, client.postJson(path, "{ not json").status)
                assertEquals(badRequest, client.postJson(path, """{"asOf":"$asOf"}""").status, "teamIds missing")
                assertEquals(badRequest, client.postJson(path, """{"asOf":"$asOf","teamIds":"7"}""").status)
                assertEquals(badRequest, client.postJson(path, """{"asOf":"$asOf","teamIds":[-1]}""").status)
                assertEquals(badRequest, client.postJson(path, """{"teamIds":[${t.teamId}]}""").status, "asOf missing")
                assertEquals(badRequest, client.propose(emptyList()).status, "no team")
                assertEquals(badRequest, client.propose(listOf(t.teamId, t.teamId)).status, "a team twice")
                val fiftyOne = (1u..51u).toList()
                assertEquals(badRequest, client.propose(fiftyOne).status, "51 teams, ids that do not even exist: shape first")
            }

            // asOf is checked AFTER the guard: the stranger's bad date is still 403, the manager's is 400.
            for (bad in listOf("nonsense", "2027-02-30", "2027-1-1", "3000-01-01", "2990-01-06", "1899-12-31")) {
                assertEquals(forbidden, stranger.propose(listOf(t.teamId), asOfDay = bad).status, "forbidden caller, asOf '$bad'")
                assertEquals(badRequest, manager.propose(listOf(t.teamId), asOfDay = bad).status, "manager, asOf '$bad'")
            }
            assertEquals(ok, manager.propose(listOf(t.teamId), asOfDay = "2990-01-05").status, "the latest asOf, as per team")
            assertEquals(ok, manager.propose(listOf(t.teamId), asOfDay = "1900-01-01").status)
        }

    @Test
    fun `the chain world - teams come back in placement order, the second team follows the first team's PROPOSED date`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ctc", teams = true)
        val t = w.requireTeams()
        val outside = TestTeams.seed(planName("ctc-out"), null)
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        TestPlan.capacityPeriod(t.otherTeamId, "2027-01-04", 10.0)
        // A (teamId): a1 4 MD stored late (03-01..03-02); B (otherTeamId): b1 2 MD unscheduled; a1 -> b1 (FS); b1 -> c1 where c1 is a
        // fixed milestone of a team OUTSIDE the run (02-01..02-05), which the run is not allowed to move.
        val a1 = TestPlan.milestone(w.projectId, t.teamId, planName("a1"), 4.0)
        TestPlan.schedule(a1, "2027-03-01", "2027-03-02")
        val b1 = TestPlan.milestone(w.projectId, t.otherTeamId, planName("b1"), 2.0)
        val c1 = TestPlan.milestone(w.projectId, outside, planName("c1"), 2.0)
        TestPlan.schedule(c1, "2027-02-01", "2027-02-05")
        TestPlan.dependency(milestoneRef(a1), milestoneRef(b1))
        val fixedLink = TestPlan.dependency(milestoneRef(b1), milestoneRef(c1))

        val run = w.admin.client.run(listOf(t.otherTeamId, t.teamId)) // the request order is irrelevant
        assertEquals(listOf(t.teamId, t.otherTeamId), run.teams.map { it.teamId }, "A holds the predecessor: placed first")
        assertEquals(1, run.passes)
        assertTrue(run.settled, "a team graph without a cycle settles in one pass")
        assertEquals(asOf, run.asOf)
        assertEquals(TestPlan.revision(), run.revision)
        val (a, b) = run.teams
        assertEquals("2027-02-01..2027-02-02", a.span(a1))
        assertEquals("2027-03-01", a.moves.single().from?.start, "a1's stored dates are the move's `from`")
        assertEquals("2027-02-03..2027-02-03", b.span(b1), "b1 follows a1's PROPOSED end, not its stored 03-02")
        assertTrue(a.name.isNotBlank() && b.name.isNotBlank() && a.name != b.name)
        assertEquals(emptyList(), a.dependencies, "a1 -> b1 is fine both times: not reported")
        val reported = b.dependencies.single()
        assertEquals(fixedLink, reported.id, "b1 now ends after the outside team's fixed c1 starts: reported, not avoided")
        assertEquals(DependencyStatus.UNSCHEDULED, reported.before)
        assertEquals(DependencyStatus.VIOLATED, reported.check.status)
        assertEquals(listOf("2027-02-01"), b.weeks.map { it.weekStart })
        assertEquals(2.0, b.weeks.single().load, "b1's 2 MD land in that week")

        // What the team alone would have answered: a1 is a fixed fact at 03-01..03-02, so b1 waits for it.
        val alone = w.requireTeams().otherManager.client.perTeam(t.otherTeamId)
        assertEquals("2027-03-03..2027-03-03", alone.moves.single { it.milestoneId == b1 }.to.let { "${it.start}..${it.end}" })
    }

    @Test
    fun `a team cycle takes several passes over the wire and still settles - the kernel's contended cycle`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ctx", teams = true)
        val t = w.requireTeams()
        val second = secondProject(w)
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        TestPlan.capacityPeriod(t.otherTeamId, "2027-01-04", 10.0)
        // a1 (A, 4 MD) -> b1 (B, 2 MD) -> a2 (A, 2 MD, first in A's order): A has two movables, B one, so A goes first.
        val a1 = TestPlan.milestone(w.projectId, t.teamId, planName("a1"), 4.0)
        val a2 = TestPlan.milestone(w.projectId, t.teamId, planName("a2"), 2.0)
        val b1 = TestPlan.milestone(second.projectId, t.otherTeamId, planName("b1"), 2.0)
        TestPlan.dependency(milestoneRef(a1), milestoneRef(b1))
        TestPlan.dependency(milestoneRef(b1), milestoneRef(a2))
        TestPlan.teamOrder(t.teamId, listOf(a2, a1))

        val run = w.admin.client.run(listOf(t.teamId, t.otherTeamId))
        assertEquals(listOf(t.teamId, t.otherTeamId), run.teams.map { it.teamId })
        assertEquals(3, run.passes, "pass 1 a2 02-01, a1 02-02..03, b1 02-04; pass 2 a2 02-05, a1 02-01..02; pass 3 a2 02-04")
        assertTrue(run.settled)
        val (a, b) = run.teams
        assertEquals("2027-02-04..2027-02-04", a.span(a2))
        assertEquals("2027-02-01..2027-02-02", a.span(a1))
        assertEquals("2027-02-03..2027-02-03", b.span(b1))
        assertEquals(emptyList(), a.dependencies + b.dependencies, "settled: every link of the cycle holds")
    }

    @Test
    fun `a run over one team equals that team's own proposal - moves, unplaced, pinned, weeks and links - except the scope hash`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("cts", teams = true)
            val t = w.requireTeams()
            TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0, wipLimit = 2)
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

            val alone = t.manager.client.perTeam(t.teamId)
            val run = t.manager.client.run(listOf(t.teamId))
            val team = run.teams.single()
            assertEquals(listOf(kept), alone.pinned)
            assertEquals(alone.moves, team.moves)
            assertEquals(alone.unchanged, team.unchanged)
            assertEquals(alone.unplaced, team.unplaced)
            assertEquals(alone.pinned, team.pinned)
            assertEquals(alone.weeks, team.weeks)
            assertEquals(alone.weeksTruncated, team.weeksTruncated)
            assertEquals(alone.dependencies, team.dependencies)
            assertTrue(team.dependencies.isNotEmpty(), "the world does report a link")
            assertEquals(alone.revision, run.revision)
            assertEquals(1, run.passes)
            assertNotEquals(alone.scopeHash, run.scopeHash, "the run's hash is over the set: another definition of foreign")
        }

    @Test
    fun `the scope hash is 64 hex digits, stable, and moves with a run team's inputs but not its own dates`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("cth", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        TestPlan.capacityPeriod(t.otherTeamId, "2027-01-04", 10.0)
        val a1 = TestPlan.milestone(w.projectId, t.teamId, planName("a1"), 4.0)
        val b1 = TestPlan.milestone(w.projectId, t.otherTeamId, planName("b1"), 2.0)
        TestPlan.dependency(milestoneRef(a1), milestoneRef(b1))
        val admin = w.admin.client

        val first = admin.run(listOf(t.teamId, t.otherTeamId)).scopeHash
        assertTrue(Regex("^[0-9a-f]{64}$").matches(first), first)
        assertEquals(first, admin.run(listOf(t.otherTeamId, t.teamId)).scopeHash, "stable, whatever the request order")
        val otherDay = admin.run(listOf(t.teamId, t.otherTeamId), "2027-01-30").scopeHash
        assertEquals(first.take(56), otherDay.take(56), "another asOf moves no digest ...")
        assertNotEquals(first.takeLast(8), otherDay.takeLast(8), "... only the last 8 characters")
        val soloFirst = admin.run(listOf(t.teamId)).scopeHash
        assertNotEquals(first, soloFirst, "a different team set is a different run")

        // A run team's OWN dates are covered by schedule_revision, not by the hash: moving b1 leaves the pair's hash alone ...
        TestPlan.schedule(b1, "2027-05-03", "2027-05-04")
        assertEquals(first, admin.run(listOf(t.teamId, t.otherTeamId)).scopeHash)
        // ... but for the run over A alone b1 is a FOREIGN end of the a1 -> b1 link, and its dates are in that hash.
        assertNotEquals(soloFirst, admin.run(listOf(t.teamId)).scopeHash)

        // An unrelated team's milestone changes nothing the run reads.
        val unrelated = TestTeams.seed(planName("cth-un"), null)
        TestPlan.schedule(TestPlan.milestone(w.projectId, unrelated), "2027-06-07", "2027-06-08")
        assertEquals(first, admin.run(listOf(t.teamId, t.otherTeamId)).scopeHash)

        // Capacity, a pin and a new link of a run team are inputs.
        TestPlan.capacityPeriod(t.otherTeamId, "2027-06-07", 20.0)
        val afterCapacity = admin.run(listOf(t.teamId, t.otherTeamId)).scopeHash
        assertNotEquals(first, afterCapacity)
        TestPlan.schedule(a1, "2027-03-01", "2027-03-02")
        TestPlan.pin(a1)
        val afterPin = admin.run(listOf(t.teamId, t.otherTeamId)).scopeHash
        assertNotEquals(afterCapacity, afterPin)
        val c1 = TestPlan.milestone(w.projectId, t.teamId, planName("c1"))
        TestPlan.dependency(milestoneRef(c1), milestoneRef(b1))
        val afterLink = admin.run(listOf(t.teamId, t.otherTeamId)).scopeHash
        assertNotEquals(afterPin, afterLink)

        // The team order breaks ties by team NAME, so a rename between the run and the accept can change the placement: it is an input.
        // The name is compared case-insensitively (the tiebreak is), so a case-only rename leaves the hash alone.
        val name = TestPlan.scalar("SELECT name FROM teams WHERE id = ${t.otherTeamId}") { it.getString(1) }
        suspend fun rename(to: String) =
            TestTeams.service.update(t.otherTeamId, TeamUpdateRequest(name = to, managerPersonId = t.otherManager.personId))
        rename(name.uppercase())
        assertEquals(afterLink, admin.run(listOf(t.teamId, t.otherTeamId)).scopeHash, "a case-only rename")
        rename("${name}-renamed")
        assertNotEquals(afterLink, admin.run(listOf(t.teamId, t.otherTeamId)).scopeHash, "a rename")
    }

    @Test
    fun `a run is a computation - nothing is written, the revision stays, no audit event is emitted`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ctn", teams = true)
        val t = w.requireTeams()
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        val open = TestPlan.milestone(w.projectId, t.teamId)
        val dated = TestPlan.milestone(w.projectId, t.otherTeamId)
        TestPlan.schedule(dated, "2027-05-03", "2027-05-04")
        val revision = TestPlan.revision()
        val stamp = TestPlan.scalar("SELECT schedule_revision FROM milestones WHERE id = $dated") { it.getLong(1) }
        withAuditCapture { capture ->
            val run = w.admin.client.run(listOf(t.teamId, t.otherTeamId))
            assertEquals(revision, run.revision)
            assertTrue(run.teams.sumOf { it.moves.size } >= 1)
            assertTrue(
                capture.events.none { it.message.startsWith("milestone.") || it.message.startsWith("team.") },
                "a computation audits nothing: ${capture.events.map { it.message }}",
            )
        }
        assertEquals(revision, TestPlan.revision())
        assertEquals(stamp, TestPlan.scalar("SELECT schedule_revision FROM milestones WHERE id = $dated") { it.getLong(1) })
        assertEquals(null to null, TestPlan.scalar("SELECT start_date::text, end_date::text FROM milestones WHERE id = $open") {
            it.getString(1) to it.getString(2)
        })
    }

    @Test
    fun `a manager whose person was deleted loses the run - 403 on the run, no team on the list`() = testApplication {
        usePostgresTestcontainer()
        val both = twoTeamManager("ctd")
        val listed = "/api/v1/schedule-proposals/teams"
        assertEquals(ok, both.caller.client.propose(listOf(both.first, both.second)).status)
        assertEquals(2, both.caller.client.get(listed).body<ProposalTeamList>().items.size)

        TestPeople.softDelete(checkNotNull(both.caller.personId)) // the grant is read per request, from the ACTIVE person
        assertEquals(forbidden, both.caller.client.propose(listOf(both.first)).status)
        assertEquals(forbidden, both.caller.client.propose(listOf(both.first, both.second)).status)
        assertEquals(emptyList(), both.caller.client.get(listed).body<ProposalTeamList>().items)
    }

    @Test
    fun `the runnable teams - ADMIN gets every active team by name, a manager exactly their own, a manager of nothing none`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("ctt", teams = true)
            val t = w.requireTeams()
            val both = twoTeamManager("ctt")
            val deleted = TestTeams.seed(planName("ctt-deleted"), both.caller.personId)
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$deleted").status)
            val listed = "/api/v1/schedule-proposals/teams"

            val admin: ProposalTeamList = w.admin.client.get(listed).body()
            val ids = admin.items.map { it.id }
            assertTrue(listOf(t.teamId, t.otherTeamId, both.first, both.second).all { it in ids }, "every active team")
            assertTrue(deleted !in ids, "a deleted team is not offered")
            assertEquals(admin.items.sortedWith(compareBy({ it.name.lowercase() }, { it.id })), admin.items, "by name, then id")
            assertEquals(ids.size, ids.toSet().size)

            assertEquals(listOf(t.teamId), t.manager.client.get(listed).body<ProposalTeamList>().items.map { it.id })
            val theirs = both.caller.client.get(listed).body<ProposalTeamList>().items
            assertEquals(setOf(both.first, both.second), theirs.map { it.id }.toSet(), "their two active teams, not the deleted one")
            assertEquals(theirs.sortedBy { it.name.lowercase() }, theirs)
            for (nobody in listOf(w.stranger, w.projectOwner, w.personless, w.editor)) {
                assertEquals(emptyList(), nobody.client.get(listed).body<ProposalTeamList>().items)
            }
            // What the list offers is what the run accepts.
            assertEquals(ok, both.caller.client.propose(theirs.map { it.id }).status)
            assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(listed).status)
        }
}
