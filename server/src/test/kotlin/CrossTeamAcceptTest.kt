package ch.nokillswit

import ch.nokillswit.infra.json.sha256Hex
import ch.nokillswit.planning.CrossTeamAcceptRequest
import ch.nokillswit.planning.CrossTeamProposal
import ch.nokillswit.planning.CrossTeamProposalRequest
import ch.nokillswit.planning.MAX_RUN_SCHEDULE_ITEMS
import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.planning.STALE_REVISION_PROBLEM
import ch.nokillswit.planning.STALE_SCOPE_PROBLEM
import ch.nokillswit.planning.ScheduleProposalRequest
import ch.nokillswit.planning.SkippedSchedule
import ch.nokillswit.planning.SkippedScheduleReason.GONE
import ch.nokillswit.planning.SkippedScheduleReason.NOT_ON_TEAM
import ch.nokillswit.planning.SkippedScheduleReason.NO_WORKING_DAY
import ch.nokillswit.planning.SkippedScheduleReason.STALE
import ch.nokillswit.planning.ScheduleProposal
import ch.nokillswit.planning.TeamScheduleBatchItem
import ch.nokillswit.planning.TeamScheduleBatchRequest
import ch.nokillswit.planning.TeamScheduleBatchResponse
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.teams.TeamUpdateRequest
import ch.nokillswit.users.UserRole
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
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * `POST /schedule-proposals/accept` (1.8.0): the accept of a cross-team run over the wire - N teams' schedule PUTs in ONE plan write,
 * ONE bump, under a run-level `scopeHash`. The kernel is `CrossTeamKernelsTest`, the run is `CrossTeamProposalTest`; these tests pin the
 * order of the checks over a body-listed team SET (body, shape 400 of the run and of `acceptTeamIds` (1.33.0: the teams written, absent
 * = the run's), every RUN team active else 404, every ACCEPT team managed else 403, the rest of the shape 400, then under the lock every
 * run team locked and every accept team re-guarded, the two 409s over the whole run, the per-item rules), the sweep over EVERY run
 * team, the cross-refusal of the per-team and the run hash, and the audit. 2027-01-31 is a Sunday (`asOf`); 10 MD a week is 2 MD a day.
 */
class CrossTeamAcceptTest {
    private val ok = HttpStatusCode.OK
    private val forbidden = HttpStatusCode.Forbidden
    private val notFound = HttpStatusCode.NotFound
    private val badRequest = HttpStatusCode.BadRequest
    private val conflict = HttpStatusCode.Conflict
    private val asOf = "2027-01-31"
    private val runPath = "/api/v1/schedule-proposals"
    private val acceptPath = "/api/v1/schedule-proposals/accept"

    private suspend fun HttpClient.run(teamIds: List<UInt>): CrossTeamProposal {
        val response = postJson(runPath, CrossTeamProposalRequest(asOf, teamIds))
        assertEquals(ok, response.status)
        return response.body()
    }

    /** Every move of the run as a batch item, in the run's placement order. */
    private fun CrossTeamProposal.items() = teams.flatMap { it.moves }.map { TeamScheduleBatchItem(it.milestoneId, it.to.start, it.to.end) }

    private suspend fun HttpClient.accept(
        run: CrossTeamProposal,
        teamIds: List<UInt>,
        items: List<TeamScheduleBatchItem> = run.items(),
        hash: String = run.scopeHash,
        revision: Long = run.revision,
        acceptTeamIds: List<UInt>? = null,
    ): HttpResponse = postJson(acceptPath, CrossTeamAcceptRequest(revision, hash, teamIds, items, acceptTeamIds))

    /** The moves of ONE run team as batch items: what a viewer who may accept only that team ticks. */
    private fun CrossTeamProposal.itemsOf(teamId: UInt) =
        teams.single { it.teamId == teamId }.moves.map { TeamScheduleBatchItem(it.milestoneId, it.to.start, it.to.end) }

    private suspend fun HttpResponse.result(): TeamScheduleBatchResponse = body()

    private suspend fun HttpResponse.assertConflict(type: String) {
        assertEquals(conflict, status)
        assertEquals(type, body<ProblemDetail>().type)
    }

    private fun datesOf(id: UInt): Pair<String?, String?> =
        TestPlan.scalar("SELECT start_date::text, end_date::text FROM milestones WHERE id = $id") { it.getString(1) to it.getString(2) }

    private fun scheduleRevisionOf(id: UInt): Long =
        TestPlan.scalar("SELECT schedule_revision FROM milestones WHERE id = $id") { it.getLong(1) }

    private fun item(id: UInt, start: String?, end: String?) = TeamScheduleBatchItem(id, start, end)

    /**
     * The run's world: team A (`t.teamId`) holds a1 (4 MD, stored late 03-01..03-02); team B (`t.otherTeamId`) holds b1 (2 MD,
     * unscheduled, `a1 -> b1` FS), b2 (movable, 04-05..04-06), b3 (in progress, FIXED, 01-11..01-15) and b4 (PINNED, 03-08..03-09); a team
     * OUTSIDE the run holds c1 (02-01..02-05). Both run teams have 10 MD a week from 2027-01-04.
     */
    private class RunWorld(
        val w: PlanWorld,
        val t: PlanTeams,
        val outside: UInt,
        val a1: UInt,
        val b1: UInt,
        val b2: UInt,
        val b3: UInt,
        val b4: UInt,
        val c1: UInt,
    ) {
        val both = listOf(t.teamId, t.otherTeamId)
    }

    private suspend fun ApplicationTestBuilder.runWorld(prefix: String): RunWorld {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        val t = w.requireTeams()
        val outside = TestTeams.seed(planName("$prefix-out"), null)
        TestPlan.capacityPeriod(t.teamId, "2027-01-04", 10.0)
        TestPlan.capacityPeriod(t.otherTeamId, "2027-01-04", 10.0)
        val a1 = TestPlan.milestone(w.projectId, t.teamId, planName("a1"), 4.0)
        TestPlan.schedule(a1, "2027-03-01", "2027-03-02")
        val b1 = TestPlan.milestone(w.projectId, t.otherTeamId, planName("b1"), 2.0)
        val b2 = TestPlan.milestone(w.projectId, t.otherTeamId, planName("b2"), 2.0)
        TestPlan.schedule(b2, "2027-04-05", "2027-04-06")
        val b3 = TestPlan.milestone(w.projectId, t.otherTeamId, planName("b3"), 2.0)
        TestPlan.schedule(b3, "2027-01-11", "2027-01-15")
        val b4 = TestPlan.milestone(w.projectId, t.otherTeamId, planName("b4"), 2.0)
        TestPlan.schedule(b4, "2027-03-08", "2027-03-09")
        TestPlan.pin(b4)
        val c1 = TestPlan.milestone(w.projectId, outside, planName("c1"), 2.0)
        TestPlan.schedule(c1, "2027-02-01", "2027-02-05")
        TestPlan.dependency(milestoneRef(a1), milestoneRef(b1))
        return RunWorld(w, t, outside, a1, b1, b2, b3, b4, c1)
    }

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
    fun `one accept over two teams writes both teams' items under ONE bump - the second team follows the first team's PROPOSED date`() =
        testApplication {
            val r = runWorld("cta")
            val run = r.w.admin.client.run(r.both)
            val before = TestPlan.revision()
            assertEquals(before, run.revision)
            assertEquals(listOf(r.t.teamId, r.t.otherTeamId), run.teams.map { it.teamId }, "A holds the predecessor")

            val response = r.w.admin.client.accept(run, r.both)
            assertEquals(ok, response.status)
            val body = response.result()
            assertEquals(before + 1, body.revision, "ONE bump for the whole accept")
            assertEquals(TestPlan.revision(), body.revision)
            assertEquals(run.items().map { it.milestoneId }, body.accepted, "the written ids in body order, both teams'")
            assertEquals(emptyList(), body.skipped)
            assertEquals("2027-02-01" to "2027-02-02", datesOf(r.a1), "a1: the run's date, not the stored 03-01")
            assertEquals("2027-02-03" to "2027-02-03", datesOf(r.b1), "b1: the day after a1's PROPOSED end")
            for (id in body.accepted) assertEquals(body.revision, scheduleRevisionOf(id), "stamped with the one new revision, id $id")
            assertTrue(r.b4 !in body.accepted, "a pinned milestone is in no placement list")
            assertEquals("2027-03-08" to "2027-03-09", datesOf(r.b4))
            assertEquals("2027-02-01" to "2027-02-05", datesOf(r.c1), "the team outside the run is untouched")
        }

    @Test
    fun `the manager of both teams and ADMIN accept - one team short, the project owner and every other caller get 403, nothing written`() =
        testApplication {
            val r = runWorld("ctag")
            val both = twoTeamManager("ctag")
            val mine1 = TestPlan.milestone(r.w.projectId, both.first)
            val mine2 = TestPlan.milestone(r.w.projectId, both.second)
            val admin = r.w.admin.client

            val mineRun = both.caller.client.run(listOf(both.first, both.second))
            assertEquals(ok, both.caller.client.accept(mineRun, listOf(both.first, both.second)).status, "the manager of both")
            assertTrue(datesOf(mine1).first != null && datesOf(mine2).first != null)
            assertEquals(ok, admin.accept(admin.run(r.both), r.both).status, "ADMIN accepts teams it manages none of")

            val run = admin.run(r.both + both.first)
            val b5 = TestPlan.milestone(r.w.projectId, r.t.otherTeamId)
            val revision = TestPlan.revision()
            val denied = listOf(
                "the manager of one of the set" to r.t.manager,
                "the other team's manager" to r.t.otherManager,
                "project owner" to r.w.projectOwner, "program owner" to r.w.programOwner, "stream owner" to r.w.streamOwner,
                "stranger" to r.w.stranger, "personless" to r.w.personless, "roadmap editor" to r.w.editor,
                "the two-team manager with a third team of the set" to both.caller,
            )
            for ((label, caller) in denied) {
                val response = caller.client.accept(run, r.both + both.first, items = listOf(item(b5, "2027-05-03", "2027-05-04")))
                assertEquals(forbidden, response.status, label)
            }
            assertEquals(forbidden, r.t.manager.client.accept(run, r.both, run.items()).status, "one of the pair, even for a smaller set")
            assertEquals(null to null, datesOf(b5), "the refused accepts wrote nothing")
            assertEquals(revision, TestPlan.revision(), "nor moved the plan revision")
            val anonymous = jsonClient().postJson(acceptPath, CrossTeamAcceptRequest(0, "0".repeat(64), r.both, emptyList()))
            assertEquals(HttpStatusCode.Unauthorized, anonymous.status)
        }

    @Test
    fun `a missing or deleted team is 404 for every caller - before the guard - and 403 never leaks which exist`() = testApplication {
        val r = runWorld("ct404")
        val gone = TestTeams.seed(planName("ct404-gone"), null)
        assertEquals(HttpStatusCode.NoContent, r.w.admin.client.delete("/api/v1/teams/$gone").status)
        val run = r.w.admin.client.run(r.both)
        val callers = listOf(
            "stranger" to r.w.stranger, "project owner" to r.w.projectOwner, "manager" to r.t.manager, "admin" to r.w.admin,
        )
        val revision = TestPlan.revision()
        for ((label, caller) in callers) {
            assertEquals(notFound, caller.client.accept(run, listOf(999999u)).status, "unknown: $label")
            assertEquals(notFound, caller.client.accept(run, listOf(gone)).status, "deleted: $label")
            assertEquals(notFound, caller.client.accept(run, listOf(r.t.teamId, gone)).status, "a good team and a deleted one: $label")
        }
        val detail = r.w.stranger.client.accept(run, listOf(r.t.teamId, gone, 999999u)).bodyAsText()
        assertTrue("Team not found: $gone, 999999" in detail, "the 404 names exactly the missing ids: $detail")
        assertEquals(forbidden, r.w.stranger.client.accept(run, r.both).status, "all active: 403")
        assertEquals(revision, TestPlan.revision())
    }

    @Test
    fun `the body decodes first, the team set is validated before the guard and the rest of the shape after it - nothing is written`() =
        testApplication {
            val r = runWorld("ct400")
            val run = r.w.admin.client.run(r.both)
            val manager = twoTeamManager("ct400")
            val stranger = r.w.stranger.client
            val mgr = manager.caller.client
            val pair = listOf(manager.first, manager.second)
            val mine = mgr.run(pair)
            val revision = TestPlan.revision()
            val hash = "0".repeat(64)

            // Malformed bodies and team sets are 400 even for a caller the guard would refuse.
            for (client in listOf(mgr, stranger)) {
                assertEquals(badRequest, client.postJson(acceptPath, "{ not json").status)
                val items = """[{"milestoneId":1,"startDate":"2027-02-01","endDate":"2027-02-02"}]"""
                val noHash = """{"expectedRevision":0,"teamIds":[1],"items":$items}"""
                assertEquals(badRequest, client.postJson(acceptPath, noHash).status, "no hash")
                val noTeams = """{"expectedRevision":0,"scopeHash":"$hash","items":$items}"""
                assertEquals(badRequest, client.postJson(acceptPath, noTeams).status)
                assertEquals(badRequest, client.postJson(acceptPath, """{"expectedRevision":0,"scopeHash":"$hash","teamIds":[1]}""").status)
                assertEquals(badRequest, client.accept(run, emptyList()).status, "no team")
                assertEquals(badRequest, client.accept(run, listOf(r.t.teamId, r.t.teamId)).status, "a team twice")
                assertEquals(badRequest, client.accept(run, (1u..51u).toList()).status, "51 teams: shape first")
            }

            // The rest of the shape is checked AFTER the guard: the stranger's bad items are still 403, the manager's are 400.
            val one = listOf(item(1u, "2027-02-01", "2027-02-02"))
            val bad = mapOf<String, suspend () -> HttpResponse>(
                "negative expectedRevision" to { mgr.accept(mine, pair, one, revision = -1) },
                "uppercase hash" to { mgr.accept(mine, pair, one, hash = "A".repeat(64)) },
                "short hash" to { mgr.accept(mine, pair, one, hash = "nope") },
                "no items" to { mgr.accept(mine, pair, emptyList()) },
                "an id twice" to { mgr.accept(mine, pair, listOf(one.single(), one.single())) },
                "2001 items" to {
                    mgr.accept(mine, pair, (1u..(MAX_RUN_SCHEDULE_ITEMS + 1).toUInt()).map { item(it, "2027-02-01", "2027-02-02") })
                },
                "one date only" to { mgr.accept(mine, pair, listOf(item(1u, "2027-02-01", null))) },
                "end before start" to { mgr.accept(mine, pair, listOf(item(1u, "2027-02-05", "2027-02-01"))) },
                "weekend only" to { mgr.accept(mine, pair, listOf(item(1u, "2027-02-06", "2027-02-07"))) },
            )
            for ((label, call) in bad) assertEquals(badRequest, call().status, label)
            val forbiddenItems = r.w.stranger.client.accept(run, r.both, emptyList())
            assertEquals(forbidden, forbiddenItems.status, "a forbidden caller's bad items stay 403")
            assertEquals(forbidden, stranger.accept(run, r.both, revision = -1).status)
            assertEquals(revision, TestPlan.revision(), "no 400 or 403 moved the revision")
        }

    @Test
    fun `an item is decided on its own with the set as the team - gone, outside it, no working day and stale skip, the rest land`() =
        testApplication {
            val r = runWorld("ctp")
            val b5 = TestPlan.milestone(r.w.projectId, r.t.otherTeamId, planName("b5"), 2.0)
            TestHolidays.with("2027-04-14") {
                val run = r.w.admin.client.run(r.both)
                // After the run a colleague drags the ITEM a1: it is skipped STALE (its own revision), the run is not refused.
                TestPlan.schedule(r.a1, "2027-03-08", "2027-03-09")
                val before = TestPlan.revision()
                val items = listOf(
                    item(r.a1, "2027-02-01", "2027-02-02"),
                    item(r.b1, "2027-02-03", "2027-02-03"),
                    item(999_999u, "2027-02-01", "2027-02-02"),
                    item(r.c1, "2027-02-08", "2027-02-09"),
                    item(b5, "2027-04-14", "2027-04-14"),
                )
                val response = r.w.admin.client.accept(run, r.both, items)
                assertEquals(ok, response.status)
                val body = response.result()
                assertEquals(listOf(r.b1), body.accepted)
                assertEquals(
                    listOf(
                        SkippedSchedule(r.a1, STALE), SkippedSchedule(999_999u, GONE), SkippedSchedule(r.c1, NOT_ON_TEAM),
                        SkippedSchedule(b5, NO_WORKING_DAY),
                    ),
                    body.skipped,
                )
                assertEquals(before + 1, body.revision, "ONE bump")
                assertEquals("2027-02-03" to "2027-02-03", datesOf(r.b1))
                assertEquals("2027-03-08" to "2027-03-09", datesOf(r.a1), "the colleague's dates stand")
                assertEquals("2027-02-01" to "2027-02-05", datesOf(r.c1), "a milestone of a team outside the set is not the run's to move")
                assertEquals(null to null, datesOf(b5))
            }
        }

    @Test
    fun `an all-skipped accept is still a 200 and bumps once, a refused one does not`() = testApplication {
        val r = runWorld("ctsk")
        val run = r.w.admin.client.run(r.both)
        val before = TestPlan.revision()
        val response = r.w.admin.client.accept(run, r.both, listOf(item(r.c1, "2027-02-08", "2027-02-09")))
        assertEquals(ok, response.status)
        assertEquals(listOf(SkippedSchedule(r.c1, NOT_ON_TEAM)), response.result().skipped)
        assertEquals(before + 1, TestPlan.revision(), "the lock was taken and the write ran: the batch's conservative rule")
    }

    @Test
    fun `an expectedRevision above the plan is a 409 stale-revision, a wrong hash a 409 stale-scope - after the guard, nothing written`() =
        testApplication {
            val r = runWorld("ct409")
            val run = r.w.admin.client.run(r.both)
            val current = TestPlan.revision()
            for (future in listOf(current + 1, current + 1000, Long.MAX_VALUE)) {
                r.w.admin.client.accept(run, r.both, revision = future).assertConflict(STALE_REVISION_PROBLEM)
            }
            r.w.admin.client.accept(run, r.both, hash = "0".repeat(64)).assertConflict(STALE_SCOPE_PROBLEM)
            assertEquals(forbidden, r.w.stranger.client.accept(run, r.both, revision = current + 1).status, "403 first")
            assertEquals(forbidden, r.w.stranger.client.accept(run, r.both, hash = "0".repeat(64)).status, "403 first")
            assertEquals(null to null, datesOf(r.b1))
            assertEquals(current, TestPlan.revision())
            assertEquals(ok, r.w.admin.client.accept(run, r.both, revision = current).status, "the current revision and hash pass")
        }

    @Test
    fun `any change to a run team that is not an item refuses the whole accept - the sweep covers both teams, fixed and pinned ones too`() =
        testApplication {
            val r = runWorld("ctw")
            val admin = r.w.admin.client
            val a1Only = listOf(item(r.a1, "2027-02-01", "2027-02-02"))
            var cases = 0

            // Each case: a fresh run, ONE change by somebody else, then an accept of a1 alone (team B has NO item): 409 stale-scope.
            // A login of its own per case: one login's run + accept pairs would pass the 30 a minute of the run bucket.
            suspend fun refused(label: String, change: suspend () -> Unit) {
                val caller = seededClient("ctw-${cases++}", UserRole.ADMIN)
                val run = caller.run(r.both)
                change()
                val revision = TestPlan.revision()
                caller.accept(run, r.both, a1Only).assertConflict(STALE_SCOPE_PROBLEM)
                assertEquals("2027-03-01" to "2027-03-02", datesOf(r.a1), "$label: nothing written")
                assertEquals(revision, TestPlan.revision(), "$label: no bump")
            }

            // Spans of run-team milestones are NOT in the hash: the schedule_revision sweep is what notices them, for EVERY team.
            refused("an unticked movable milestone of the OTHER run team dragged") { TestPlan.schedule(r.b2, "2027-04-12", "2027-04-13") }
            refused("a FIXED (started) milestone of the other run team moved") { TestPlan.schedule(r.b3, "2027-01-12", "2027-01-14") }
            refused("a PINNED milestone of the other run team moved") { TestPlan.schedule(r.b4, "2027-03-09", "2027-03-10") }
            val aSecond = TestPlan.milestone(r.w.projectId, r.t.teamId, planName("a2"))
            refused("an unticked unscheduled milestone of the FIRST team scheduled") {
                TestPlan.schedule(aSecond, "2027-05-03", "2027-05-04")
            }
            // The structure digest sees what the spans are not: pins, sets, order, capacity, links, names (holidays: the test below).
            refused("a pin released") { TestPlan.pin(r.b4, pinned = false) }
            refused("a pin set") { TestPlan.pin(r.b2) }
            refused("a milestone added to a run team") { TestPlan.milestone(r.w.projectId, r.t.otherTeamId) }
            val away = MilestoneUpdateRequest(planName("a2-moved"), null, r.outside, 2.0)
            refused("a milestone moved to a team outside the set") {
                assertEquals(HttpStatusCode.NoContent, admin.putJson("/api/v1/milestones/$aSecond", away).status)
            }
            refused("a capacity period of the second team") { TestPlan.capacityPeriod(r.t.otherTeamId, "2027-06-07", 20.0) }
            refused("a capacity period of the first team") { TestPlan.capacityPeriod(r.t.teamId, "2027-06-07", 20.0) }
            refused("a team's execution order") { TestPlan.teamOrder(r.t.otherTeamId, listOf(r.b2, r.b1)) }
            refused("a link between the run's milestones") { TestPlan.dependency(milestoneRef(r.b2), milestoneRef(r.b1)) }
            TestPlan.dependency(milestoneRef(r.c1), milestoneRef(r.b2)) // before the run: now c1 is a foreign end the hash reads
            refused("an outside milestone that a link of the run binds, dated") { TestPlan.schedule(r.c1, "2027-02-08", "2027-02-12") }
            val name = TestPlan.scalar("SELECT name FROM teams WHERE id = ${r.t.otherTeamId}") { it.getString(1) }
            fun milestoneName(id: UInt) = TestPlan.scalar("SELECT name FROM milestones WHERE id = $id") { it.getString(1) }
            suspend fun update(id: UInt, teamId: UInt, estimate: Double) {
                val request = MilestoneUpdateRequest(milestoneName(id), null, teamId, estimate)
                assertEquals(HttpStatusCode.NoContent, admin.putJson("/api/v1/milestones/$id", request).status)
            }
            refused("a team renamed (the team order's tiebreak reads the name)") {
                val renamed = TeamUpdateRequest(name = "$name-renamed", managerPersonId = r.t.otherManager.personId)
                TestTeams.service.update(r.t.otherTeamId, renamed)
            }
            refused("an estimate changed (the capacity the placement spent)") { update(r.b2, r.t.otherTeamId, 5.0) }
            refused("a milestone moved INTO the set from a team outside it") { update(r.c1, r.t.teamId, 2.0) }
            refused("a milestone moved between two run teams") { update(r.b3, r.t.teamId, 2.0) }
        }

    @Test
    fun `a holiday changes the accept only when it changes an accepted date - far off or unused it is accepted, inside a span it is not`() =
        testApplication {
            val r = runWorld("cthol")
            val admin = r.w.admin.client
            val run = admin.run(r.both)
            val items = run.items()
            assertTrue(items.size >= 3, "a1, b1 and b2 move: ${items.map { it.milestoneId }}")
            val stored = items.map { datesOf(it.milestoneId) }

            // A holiday on the first day of ANY accepted span gives that item (at least) another date: refused whole, nothing written.
            for (item in items) {
                TestHolidays.with(requireNotNull(item.startDate)) {
                    val revision = TestPlan.revision() // a holiday write bumps the plan revision
                    admin.accept(run, r.both).assertConflict(STALE_SCOPE_PROBLEM)
                    assertEquals(revision, TestPlan.revision(), "${item.milestoneId}: no bump")
                    assertEquals(stored, items.map { datesOf(it.milestoneId) }, "${item.milestoneId}: nothing written")
                }
            }
            // A far-off holiday, and a near one on a day nobody (moved, fixed or pinned) holds, change no accepted date: accepted.
            val near = "2027-03-03"
            assertTrue(items.none { near >= requireNotNull(it.startDate) && near <= requireNotNull(it.endDate) }, "$near is nobody's day")
            TestHolidays.with("2028-08-16") {
                TestHolidays.with(near) {
                    val revision = TestPlan.revision() // two holiday writes have bumped it
                    val response = admin.accept(run, r.both)
                    assertEquals(ok, response.status)
                    assertEquals(items.map { it.milestoneId }, response.result().accepted)
                    assertEquals(revision + 1, response.result().revision)
                    for (item in items) assertEquals(item.startDate to item.endDate, datesOf(item.milestoneId))
                }
            }
        }

    @Test
    fun `a holiday removed again leaves the run's proposal standing, and an old-layout hash is refused`() = testApplication {
        val r = runWorld("cthol2")
        val admin = r.w.admin.client
        val run = admin.run(r.both)
        TestHolidays.with("2027-02-01") { admin.accept(run, r.both).assertConflict(STALE_SCOPE_PROBLEM) }
        admin.accept(run, r.both, hash = sha256Hex("the 1.13 token")).assertConflict(STALE_SCOPE_PROBLEM)
        assertEquals(ok, admin.accept(run, r.both).status, "the holiday removed again, the proposal stands")
    }

    @Test
    fun `a change outside the run that no link of the run touches is accepted`() = testApplication {
        val r = runWorld("ctok")
        val run = r.w.admin.client.run(r.both)
        TestPlan.schedule(r.c1, "2027-06-07", "2027-06-08") // outside team, no link of the run
        TestPlan.schedule(TestPlan.milestone(r.w.projectId, r.outside), "2027-06-09", "2027-06-10")
        val response = r.w.admin.client.accept(run, r.both)
        assertEquals(ok, response.status)
        assertTrue(r.a1 in response.result().accepted && r.b1 in response.result().accepted)
    }

    @Test
    fun `the per-team batch's hash is refused by the run accept and the run's hash by the per-team batch`() = testApplication {
        val r = runWorld("ctx")
        val admin = r.w.admin.client
        val run = admin.run(r.both)
        val soloRun = admin.run(listOf(r.t.teamId))
        val teamPath = "/api/v1/teams/${r.t.teamId}"
        val perTeam: ScheduleProposal = admin.postJson("$teamPath/schedule-proposal", ScheduleProposalRequest(asOf)).body()
        val revision = TestPlan.revision()
        val a1 = listOf(item(r.a1, "2027-02-01", "2027-02-02"))

        admin.accept(run, r.both, a1, hash = perTeam.scopeHash).assertConflict(STALE_SCOPE_PROBLEM)
        admin.accept(soloRun, listOf(r.t.teamId), a1, hash = perTeam.scopeHash).assertConflict(STALE_SCOPE_PROBLEM)
        for (hash in listOf(run.scopeHash, soloRun.scopeHash)) {
            val response = admin.postJson("/api/v1/teams/${r.t.teamId}/milestone-schedules", TeamScheduleBatchRequest(revision, a1, hash))
            response.assertConflict(STALE_SCOPE_PROBLEM)
        }
        assertEquals("2027-03-01" to "2027-03-02", datesOf(r.a1), "nothing was written")
        assertEquals(revision, TestPlan.revision())
        // Each hash is accepted by its own endpoint.
        val own = admin.postJson("$teamPath/milestone-schedules", TeamScheduleBatchRequest(revision, a1, perTeam.scopeHash))
        assertEquals(ok, own.status)
        assertEquals(ok, admin.accept(admin.run(r.both), r.both).status)
    }

    @Test
    fun `the audit has milestone_scheduled with the item's own team, a line per run team with runTeamIds, a zero line, none on a 409`() =
        testApplication {
            val r = runWorld("ctu")
            val idle = TestTeams.seed(planName("ctu-idle"), null)
            TestPlan.capacityPeriod(idle, "2027-01-04", 10.0)
            TestPlan.schedule(TestPlan.milestone(r.w.projectId, idle), "2027-02-01", "2027-02-05")
            val teams = r.both + idle
            val admin = r.w.admin.client
            val b5 = TestPlan.milestone(r.w.projectId, r.t.otherTeamId, planName("b5"))
            val run = admin.run(teams)
            TestPlan.schedule(b5, "2027-05-03", "2027-05-04") // an item dragged after the run: STALE, attributed to team B
            val items = listOf(
                item(r.a1, "2027-02-01", "2027-02-02"), item(r.b1, "2027-02-03", "2027-02-03"), item(r.b4, null, null),
                item(b5, "2027-02-08", "2027-02-09"), item(999_999u, "2027-02-08", "2027-02-09"), item(r.c1, "2027-02-08", "2027-02-09"),
            )
            val aTeam = r.t.teamId.toLong()
            val bTeam = r.t.otherTeamId.toLong()
            val runTeamIds = teams.sorted().joinToString(",")
            withAuditCapture { capture ->
                val body = admin.accept(run, teams, items).result()
                assertEquals(listOf(r.a1, r.b1, r.b4), body.accepted)
                val scheduled = capture.events.filter { it.message == "milestone.scheduled" }
                assertEquals(setOf(r.a1.toLong(), r.b1.toLong(), r.b4.toLong()), scheduled.map { e ->
                    e.keyValuePairs.single { it.key == "milestoneId" }.value as Long
                }.toSet())
                assertTrue(scheduled.single { it.hasKeyValue("milestoneId", r.a1.toLong()) }.hasKeyValue("teamId", aTeam), "a1: team A")
                assertTrue(scheduled.single { it.hasKeyValue("milestoneId", r.b1.toLong()) }.hasKeyValue("teamId", bTeam), "b1: team B")
                val unpinned = assertNotNull(capture.awaitEvent { it.message == "milestone.unpinned" })
                assertTrue(unpinned.hasKeyValue("milestoneId", r.b4.toLong()) && unpinned.hasKeyValue("teamId", bTeam))
                assertTrue(unpinned.hasKeyValue("reason", "UNSCHEDULED") && unpinned.hasKeyValue("revisionTo", body.revision))

                val lines = capture.events.filter { it.message == "team.schedule_batch_applied" }
                val lineTeams = lines.map { l -> l.keyValuePairs.single { it.key == "teamId" }.value }
                assertEquals(teams.sorted().map { it.toLong() }, lineTeams, "one per team, ascending")
                assertTrue(lines.all { it.hasKeyValue("runTeamIds", runTeamIds) && it.hasKeyValue("byUserId", r.w.admin.userId.toLong()) })
                assertTrue(lines.all { it.hasKeyValue("revisionTo", body.revision) })
                val a = lines.single { it.hasKeyValue("teamId", aTeam) }
                assertTrue(a.hasKeyValue("acceptedCount", 1) && a.hasKeyValue("acceptedIds", "${r.a1}") && a.hasKeyValue("skippedCount", 0))
                val b = lines.single { it.hasKeyValue("teamId", bTeam) }
                assertTrue(b.hasKeyValue("acceptedCount", 2) && b.hasKeyValue("acceptedIds", listOf(r.b1, r.b4).sorted().joinToString(",")))
                assertTrue(b.hasKeyValue("skippedCount", 1) && b.hasKeyValue("skippedIds", "$b5"), "the STALE item is team B's")
                val zero = lines.single { it.hasKeyValue("teamId", idle.toLong()) }
                assertTrue(zero.hasKeyValue("acceptedCount", 0) && zero.hasKeyValue("skippedCount", 0), "a zero line")
                assertTrue(zero.hasKeyValue("acceptedIds", "") && zero.hasKeyValue("skippedIds", ""))

                // A GONE and a NOT_ON_TEAM item are in no line; a 409 and a 403 add none.
                val count = capture.events.count { it.message == "team.schedule_batch_applied" }
                admin.accept(run, teams, items, revision = TestPlan.revision() + 1).assertConflict(STALE_REVISION_PROBLEM)
                admin.accept(run, teams, items, hash = "1".repeat(64)).assertConflict(STALE_SCOPE_PROBLEM)
                assertEquals(ok, admin.accept(admin.run(r.both), r.both).status, "an ordinary accept still audits")
                assertEquals(HttpStatusCode.Forbidden, r.w.stranger.client.accept(run, teams, items).status)
                val strangerId = r.w.stranger.userId.toLong()
                assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", strangerId) })
                val applied = capture.events.count { it.message == "team.schedule_batch_applied" }
                assertEquals(count + 2, applied, "the fresh accept of two teams only")
            }
        }

    @Test
    fun `a manager cleared from the SECOND team while the accept was held is refused - 403, no write, no bump`() = testApplication {
        val r = runWorld("cth1")
        val both = twoTeamManager("cth1")
        val mine = TestPlan.milestone(r.w.projectId, both.second)
        val run = both.caller.client.run(listOf(both.first, both.second))
        val revision = TestPlan.revision()
        assertTrue(run.teams.any { team -> team.moves.any { it.milestoneId == mine } })
        val response = requestHeldAtPlanLock(
            { both.caller.client.accept(run, listOf(both.first, both.second)) },
            { it.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", both.second.toInt()) },
        )
        assertEquals(forbidden, response.status, "every team is re-guarded under the lock, the later one too")
        assertEquals(revision, TestPlan.revision())
        assertEquals(null to null, datesOf(mine))
    }

    @Test
    fun `a run team deleted while the accept was held is 404, even for ADMIN - no write, no bump`() = testApplication {
        val r = runWorld("cth2")
        val run = r.w.admin.client.run(r.both)
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { r.w.admin.client.accept(run, r.both) },
            { it.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", r.t.otherTeamId.toInt()) },
        )
        assertEquals(notFound, response.status, "every team is re-read and locked under the plan lock")
        assertEquals(revision, TestPlan.revision())
        assertEquals("2027-03-01" to "2027-03-02", datesOf(r.a1))
    }

    @Test
    fun `an absent acceptTeamIds is the whole run, the 1_8 contract - a manager of one run team is refused, the full set is the same`() =
        testApplication {
            val r = runWorld("ctz")
            val admin = r.w.admin.client
            val run = admin.run(r.both)
            val revision = TestPlan.revision()
            assertEquals(forbidden, r.t.manager.client.accept(run, r.both).status, "absent: every run team must be managed")
            assertEquals(forbidden, r.t.manager.client.accept(run, r.both, acceptTeamIds = r.both).status, "naming the set is the same")
            assertEquals(revision, TestPlan.revision())

            val response = admin.accept(run, r.both, acceptTeamIds = r.both.reversed())
            assertEquals(ok, response.status)
            assertEquals(run.items().map { it.milestoneId }, response.result().accepted, "the full set writes every team's items")
            assertEquals("2027-02-03" to "2027-02-03", datesOf(r.b1))
        }

    @Test
    fun `the manager of one run team accepts only their own rows - one bump, one audit line, the other team's items are NOT_ON_TEAM`() =
        testApplication {
            val r = runWorld("ctm1")
            val run = r.t.manager.client.run(r.both) // anyone may run any teams since 1.33.0
            val before = TestPlan.revision()
            val b2Before = datesOf(r.b2)
            assertTrue(run.itemsOf(r.t.otherTeamId).isNotEmpty() && r.a1 in run.itemsOf(r.t.teamId).map { it.milestoneId })
            withAuditCapture { capture ->
                val response = r.t.manager.client.accept(run, r.both, acceptTeamIds = listOf(r.t.teamId))
                assertEquals(ok, response.status)
                val body = response.result()
                assertEquals(before + 1, body.revision, "ONE bump")
                assertEquals(run.itemsOf(r.t.teamId).map { it.milestoneId }, body.accepted, "only team A's rows")
                val others = run.items().map { it.milestoneId }.filter { it !in body.accepted }
                assertEquals(others.map { SkippedSchedule(it, NOT_ON_TEAM) }, body.skipped, "team B's rows are not this caller's to move")
                assertEquals("2027-02-01" to "2027-02-02", datesOf(r.a1))
                assertEquals(null to null, datesOf(r.b1), "B's b1 is untouched")
                assertEquals(b2Before, datesOf(r.b2))

                val lines = capture.events.filter { it.message == "team.schedule_batch_applied" }
                val line = lines.single()
                assertTrue(line.hasKeyValue("teamId", r.t.teamId.toLong()) && line.hasKeyValue("revisionTo", body.revision))
                assertTrue(line.hasKeyValue("runTeamIds", r.both.sorted().joinToString(",")), "the run's whole sorted set")
                assertTrue(line.hasKeyValue("acceptedIds", "${r.a1}") && line.hasKeyValue("skippedCount", 0), "A's own rows only")
                val scheduled = capture.events.filter { it.message == "milestone.scheduled" }
                assertEquals(listOf(r.a1.toLong()), scheduled.map { e -> e.keyValuePairs.single { it.key == "milestoneId" }.value })
            }
        }

    @Test
    fun `the accept lines are one per ACCEPT team in ascending order - the run's other teams have none`() = testApplication {
        val r = runWorld("ctm2")
        val idle = TestTeams.seed(planName("ctm2-idle"), null)
        TestPlan.capacityPeriod(idle, "2027-01-04", 10.0)
        TestPlan.schedule(TestPlan.milestone(r.w.projectId, idle), "2027-02-01", "2027-02-05")
        val teams = r.both + idle
        val admin = r.w.admin.client
        val run = admin.run(teams)
        val accept = listOf(r.t.otherTeamId, r.t.teamId) // not ascending on purpose
        withAuditCapture { capture ->
            assertEquals(ok, admin.accept(run, teams, acceptTeamIds = accept).status)
            val lines = capture.events.filter { it.message == "team.schedule_batch_applied" }
            assertEquals(accept.sorted().map { it.toLong() }, lines.map { l -> l.keyValuePairs.single { it.key == "teamId" }.value })
            assertTrue(lines.all { it.hasKeyValue("runTeamIds", teams.sorted().joinToString(",")) })
        }
    }

    @Test
    fun `an acceptTeamIds naming a team the caller does not manage is 403 and nothing is written, a stranger gets 403 for any`() =
        testApplication {
            val r = runWorld("ctm3")
            val run = r.w.admin.client.run(r.both)
            val revision = TestPlan.revision()
            val own = listOf(r.t.teamId)
            assertEquals(forbidden, r.t.manager.client.accept(run, r.both, acceptTeamIds = r.both).status, "one managed, one not")
            assertEquals(forbidden, r.t.manager.client.accept(run, r.both, acceptTeamIds = listOf(r.t.otherTeamId)).status, "the other")
            assertEquals(forbidden, r.t.otherManager.client.accept(run, r.both, acceptTeamIds = own).status)
            for (caller in listOf(r.w.stranger, r.w.projectOwner, r.w.personless, r.w.editor)) {
                assertEquals(forbidden, caller.client.accept(run, r.both, acceptTeamIds = own).status)
            }
            assertEquals(null to null, datesOf(r.b1))
            assertEquals("2027-03-01" to "2027-03-02", datesOf(r.a1))
            assertEquals(revision, TestPlan.revision(), "nothing written, no bump")
        }

    @Test
    fun `a malformed acceptTeamIds is 400 before the guard - empty, twice, outside the run, over 50 - a stranger's bad items stay 403`() =
        testApplication {
            val r = runWorld("ctm4")
            val run = r.w.admin.client.run(r.both)
            val revision = TestPlan.revision()
            for ((label, client) in listOf("manager" to r.t.manager.client, "stranger" to r.w.stranger.client)) {
                val ids = mapOf<String, List<UInt>>(
                    "empty" to emptyList(), "a team twice" to listOf(r.t.teamId, r.t.teamId), "outside the run" to listOf(r.outside),
                    "one of the run and one outside" to listOf(r.t.teamId, r.outside), "unknown" to listOf(999999u),
                    "51 teams" to (1u..51u).toList(),
                )
                for ((what, accept) in ids) {
                    assertEquals(badRequest, client.accept(run, r.both, acceptTeamIds = accept).status, "$what: $label")
                }
            }
            assertEquals(forbidden, r.w.stranger.client.accept(run, r.both, emptyList(), acceptTeamIds = listOf(r.t.teamId)).status)
            assertEquals(badRequest, r.t.manager.client.accept(run, r.both, emptyList(), acceptTeamIds = listOf(r.t.teamId)).status)
            assertEquals(notFound, r.w.admin.client.accept(run, r.both + 999999u, acceptTeamIds = r.both).status, "a missing RUN team")
            assertEquals(revision, TestPlan.revision())
        }

    @Test
    fun `after one manager accepts their part another open copy of the run is a 409 stale-scope - a fresh run then lands`() =
        testApplication {
            val r = runWorld("ctm5")
            val run = r.w.admin.client.run(r.both)
            val a = r.t.manager.client.accept(run, r.both, run.itemsOf(r.t.teamId), acceptTeamIds = listOf(r.t.teamId))
            assertEquals(ok, a.status)
            val revision = TestPlan.revision()
            val stale = r.t.otherManager.client.accept(run, r.both, run.itemsOf(r.t.otherTeamId), acceptTeamIds = listOf(r.t.otherTeamId))
            stale.assertConflict(STALE_SCOPE_PROBLEM)
            assertEquals(null to null, datesOf(r.b1))
            assertEquals(revision, TestPlan.revision(), "refused, nothing written")

            val fresh = r.t.otherManager.client.run(r.both)
            val b = r.t.otherManager.client.accept(fresh, r.both, fresh.itemsOf(r.t.otherTeamId), acceptTeamIds = listOf(r.t.otherTeamId))
            assertEquals(ok, b.status)
            assertTrue(datesOf(r.b1).first != null, "b1 now follows a1's accepted date")
            assertEquals(datesOf(r.a1), "2027-02-01" to "2027-02-02")
        }

    @Test
    fun `a rescheduled row of a run team outside the accept set is 409 stale-scope even when the caller lists it`() = testApplication {
        val r = runWorld("ctm6")
        val run = r.w.admin.client.run(r.both)
        assertTrue(r.b1 in run.itemsOf(r.t.otherTeamId).map { it.milestoneId }, "b1 is a move of team B")
        TestPlan.schedule(r.b1, "2027-02-03", "2027-02-03") // team B's manager drags it after the run
        val revision = TestPlan.revision()

        val listed = r.t.manager.client.accept(run, r.both, run.items(), acceptTeamIds = listOf(r.t.teamId))
        listed.assertConflict(STALE_SCOPE_PROBLEM)
        r.t.manager.client.accept(run, r.both, run.itemsOf(r.t.teamId), acceptTeamIds = listOf(r.t.teamId))
            .assertConflict(STALE_SCOPE_PROBLEM)
        assertEquals(revision, TestPlan.revision(), "refused, nothing written")
        assertEquals("2027-03-01" to "2027-03-02", datesOf(r.a1))

        // The whole-run accept still treats a dragged ITEM as the per-item STALE, not as a refusal.
        val whole = r.w.admin.client.accept(run, r.both)
        assertEquals(ok, whole.status)
        assertTrue(whole.result().skipped.any { it.milestoneId == r.b1 && it.reason == STALE })
    }

    @Test
    fun `a manager cleared from an ACCEPT team while held is 403 - re-guarded under the lock, nothing written`() = testApplication {
        val r = runWorld("cth3")
        val both = twoTeamManager("cth3")
        val first = TestPlan.milestone(r.w.projectId, both.first)
        TestPlan.milestone(r.w.projectId, both.second)
        val teams = listOf(both.first, both.second)
        val run = both.caller.client.run(teams)
        val revision = TestPlan.revision()

        val refused = requestHeldAtPlanLock(
            { both.caller.client.accept(run, teams, run.itemsOf(both.first), acceptTeamIds = listOf(both.first)) },
            { it.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", both.first.toInt()) },
        )
        assertEquals(forbidden, refused.status, "the accept team is re-guarded under the lock")
        assertEquals(revision, TestPlan.revision())
        assertEquals(null to null, datesOf(first))
    }

    @Test
    fun `a manager cleared from a run team OUTSIDE the accept set while held still lands - a premise`() = testApplication {
        val r = runWorld("cth5")
        val both = twoTeamManager("cth5")
        TestPlan.milestone(r.w.projectId, both.first)
        val second = TestPlan.milestone(r.w.projectId, both.second)
        val teams = listOf(both.first, both.second)
        val run = both.caller.client.run(teams)
        val revision = TestPlan.revision()

        // Both teams are managed when the request starts; the held mutation is the ONLY thing that clears the first team's manager.
        val landed = requestHeldAtPlanLock(
            { both.caller.client.accept(run, teams, run.itemsOf(both.second), acceptTeamIds = listOf(both.second)) },
            { it.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", both.first.toInt()) },
        )
        assertEquals(ok, landed.status, "the first team is a premise: its manager no longer matters")
        assertEquals(revision + 1, TestPlan.revision())
        assertTrue(datesOf(second).first != null)
    }

    @Test
    fun `a run team outside the accept set deleted while held is 404 - it is still locked and checked active`() = testApplication {
        val r = runWorld("cth4")
        val both = twoTeamManager("cth4")
        val first = TestPlan.milestone(r.w.projectId, both.first)
        TestPlan.milestone(r.w.projectId, both.second)
        val teams = listOf(both.first, both.second)
        val run = both.caller.client.run(teams)
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { both.caller.client.accept(run, teams, run.itemsOf(both.first), acceptTeamIds = listOf(both.first)) },
            { it.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", both.second.toInt()) },
        )
        assertEquals(notFound, response.status)
        assertEquals(revision, TestPlan.revision())
        assertEquals(null to null, datesOf(first))
    }
}
