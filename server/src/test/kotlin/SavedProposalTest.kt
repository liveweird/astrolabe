package ch.nokillswit

import ch.nokillswit.planning.SavedProposalList
import ch.nokillswit.planning.SavedProposalRecord
import ch.nokillswit.planning.SavedProposalState
import ch.nokillswit.planning.SavedProposalSummary
import ch.nokillswit.planning.STALE_REVISION_PROBLEM
import ch.nokillswit.planning.STALE_SCOPE_PROBLEM
import ch.nokillswit.planning.STORED_PROPOSAL_FORMAT
import ch.nokillswit.planning.ScheduleCheckRequest
import ch.nokillswit.planning.ScheduleCheckResponse
import ch.nokillswit.planning.TeamScheduleBatchItem
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.users.UserRole
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST|GET /saved-schedule-proposals` and `GET|DELETE /saved-schedule-proposals/{id}` (1.26.0) over the wire: what a save stores
 * (the server's own re-computation), the order of its checks over a body-listed team set, the two `409`s, every guard, the delete's
 * read-before-guard order and the audit. The state is `SavedProposalStateTest`, the retention and the table lock
 * `SavedProposalRetentionTest`.
 */
class SavedProposalTest {
    private val created = HttpStatusCode.Created
    private val forbidden = HttpStatusCode.Forbidden
    private val notFound = HttpStatusCode.NotFound
    private val badRequest = HttpStatusCode.BadRequest
    private val conflict = HttpStatusCode.Conflict

    private suspend fun HttpResponse.assertConflict(type: String) {
        assertEquals(conflict, status)
        assertEquals(type, body<ProblemDetail>().type)
    }

    @Test
    fun `a save stores the server's own run - the summary, the record and the unmoved plan revision`() = testApplication {
        val s = savedWorld("sv")
        val run = s.both.client.savedRun(s.pair)
        assertEquals(3, run.moveIds().size, "a1, b1 and b2 move")
        val before = TestPlan.revision()

        val response = s.both.client.saveProposal(run, s.pair, name = "  Spring run  ")
        assertEquals(created, response.status)
        val summary = response.body<SavedProposalSummary>()
        assertEquals(before, TestPlan.revision(), "a save is not plan state: no bump")
        assertEquals("$SAVED_PATH/${summary.id}", response.headers[HttpHeaders.Location])
        assertEquals("Spring run", summary.name, "trimmed")
        assertEquals(SAVED_AS_OF, summary.asOf)
        assertEquals(run.revision, summary.planRevision)
        assertEquals(s.pair.sorted(), summary.teams.map { it.id })
        assertEquals(3, summary.moveCount)
        assertEquals(3, summary.selectedCount)
        assertEquals(run.passes, summary.passes)
        assertEquals(run.settled, summary.settled)
        assertEquals(s.both.userId, summary.createdBy?.userId)
        assertTrue(summary.can.delete)

        val record = s.both.client.get("$SAVED_PATH/${summary.id}").also { assertEquals(HttpStatusCode.OK, it.status) }
            .body<SavedProposalRecord>()
        assertEquals(SavedProposalState.CURRENT, record.state)
        assertEquals(run, record.proposal, "the stored document IS the server's run, scopeHash and revision included")
        assertNull(record.check, "every move ticked: the proposal's own post-check applies")
        assertEquals(run.moveIds().sorted(), record.selectedMilestoneIds)
        assertTrue(record.can.accept && record.can.delete)
        assertEquals(STORED_PROPOSAL_FORMAT.toInt(), TestSavedProposals.scalar(summary.id, "format") { it.getInt(1) })
    }

    @Test
    fun `a partial selection stores the check of exactly the ticked moves - the check endpoint's own answer`() = testApplication {
        val s = savedWorld("svp")
        val run = s.both.client.savedRun(s.pair)
        val ticked = listOf(s.a1, s.b1)
        assertTrue(s.b2 in run.moveIds())
        val summary = s.both.client.saveProposal(run, s.pair, selected = ticked).also { assertEquals(created, it.status) }
            .body<SavedProposalSummary>()
        assertEquals(2, summary.selectedCount)
        assertEquals(3, summary.moveCount)

        val items = run.teams.flatMap { it.moves }.filter { it.milestoneId in ticked }
            .map { TeamScheduleBatchItem(it.milestoneId, it.to.start, it.to.end) }
        val expected = s.both.client.postJson("/api/v1/schedule-proposals/check", ScheduleCheckRequest(s.pair, items))
            .body<ScheduleCheckResponse>()
        val record = s.both.client.get("$SAVED_PATH/${summary.id}").body<SavedProposalRecord>()
        assertEquals(expected, record.check)
        assertEquals(expected.projects, record.check?.projects, "the stored check carries the ticked subset's project spans")
        assertNotEquals(run.projects, record.check?.projects, "b2 stays unticked, so the project's end is not the run's")
        assertEquals(ticked.sorted(), record.selectedMilestoneIds)
    }

    @Test
    fun `only ADMIN and the manager of every listed team save - everyone else gets 403 and nothing is stored`() = testApplication {
        val s = savedWorld("svg")
        val run = s.w.admin.client.savedRun(s.pair)
        val mixed = listOf(s.t1, s.t3)
        val mixedRun = s.w.admin.client.savedRun(mixed)
        val before = TestSavedProposals.count()
        val denied = listOf(
            "the manager of the outside team" to s.m3, "a stranger" to s.w.stranger,
            "project owner" to s.w.projectOwner, "program owner" to s.w.programOwner, "stream owner" to s.w.streamOwner,
            "personless" to s.w.personless, "roadmap editor" to s.w.editor,
        )
        for ((label, caller) in denied) assertEquals(forbidden, caller.client.saveProposal(run, s.pair).status, label)
        assertEquals(forbidden, s.both.client.saveProposal(mixedRun, mixed).status, "one team short of the set")
        assertEquals(before, TestSavedProposals.count())

        assertEquals(created, s.w.admin.client.saveProposal(run, s.pair).status, "ADMIN saves any set")
        assertEquals(created, s.w.admin.client.saveProposal(mixedRun, mixed).status)
        assertEquals(created, s.both.client.saveProposal(run, s.pair).status, "the manager of both")
        val anonymous = jsonClient().postJson(SAVED_PATH, "{}")
        assertEquals(HttpStatusCode.Unauthorized, anonymous.status)
    }

    @Test
    fun `the order of checks - the body first, the team set shape, every team active, the guard, then the rest of the shape`() =
        testApplication {
            val s = savedWorld("svo")
            val run = s.both.client.savedRun(s.pair)
            // 10 requests a minute a login: ADMIN logins stand for "the guard passes", USER logins with a person for "it does not".
            val allowed = callerPool("svo-ok", UserRole.ADMIN)
            val refused = callerPool("svo-no", UserRole.USER)
            val before = TestSavedProposals.count()

            // Malformed bodies and team sets are 400 even for a caller the guard would refuse.
            for (pool in listOf(allowed, refused)) {
                assertEquals(badRequest, pool.next().client.postJson(SAVED_PATH, "{ not json").status)
                val hash = "0".repeat(64)
                val noRevision = """{"name":"n","asOf":"$SAVED_AS_OF","teamIds":[1],"scopeHash":"$hash","selectedMilestoneIds":[1]}"""
                assertEquals(badRequest, pool.next().client.postJson(SAVED_PATH, noRevision).status, "a missing field")
                assertEquals(badRequest, pool.next().client.saveProposal(run, emptyList()).status, "no team")
                assertEquals(badRequest, pool.next().client.saveProposal(run, listOf(s.t1, s.t1)).status, "a team twice")
                assertEquals(badRequest, pool.next().client.saveProposal(run, (1u..51u).toList()).status, "51 teams")
            }
            // Missing teams are 404 for every caller (naming them), before the guard.
            for (pool in listOf(allowed, refused)) {
                assertEquals(notFound, pool.next().client.saveProposal(run, listOf(s.t1, 999_999u)).status)
            }
            val named = refused.next().client.saveProposal(run, listOf(s.t1, 999_999u)).bodyAsText()
            assertTrue("Team not found: 999999" in named)
            // The rest of the shape comes AFTER the guard: a refused caller's bad name is still 403, an allowed caller's is 400.
            val bad = mapOf<String, suspend (io.ktor.client.HttpClient) -> HttpResponse>(
                "blank name" to { it.saveProposal(run, s.pair, name = "   ") },
                "name of 101 characters" to { it.saveProposal(run, s.pair, name = "x".repeat(101)) },
                "control character in the name" to { it.saveProposal(run, s.pair, name = "a\u0007b") },
                "negative revision" to { it.saveProposal(run, s.pair, revision = -1) },
                "uppercase hash" to { it.saveProposal(run, s.pair, hash = "A".repeat(64)) },
                "short hash" to { it.saveProposal(run, s.pair, hash = "nope") },
                "asOf not a date" to { it.saveProposal(run, s.pair, asOf = "yesterday") },
                "asOf past the horizon" to { it.saveProposal(run, s.pair, asOf = "2990-01-06") },
                "nothing ticked" to { it.saveProposal(run, s.pair, selected = emptyList()) },
                "a tick twice" to { it.saveProposal(run, s.pair, selected = listOf(s.a1, s.a1)) },
                "2001 ticks" to { it.saveProposal(run, s.pair, selected = (1u..2001u).toList()) },
            )
            for ((label, send) in bad) {
                assertEquals(forbidden, send(refused.next().client).status, "forbidden first: $label")
                assertEquals(badRequest, send(allowed.next().client).status, label)
            }
            assertEquals(before, TestSavedProposals.count(), "nothing was stored")
        }

    @Test
    fun `the 11th save request of a minute is 429 - spent before the guard and the body, another login is not affected`() =
        testApplication {
            val s = savedWorld("sv429")
            val spender = planCaller("sv429-spender", UserRole.ADMIN, withPerson = false)
            val other = planCaller("sv429-other", UserRole.ADMIN, withPerson = false)
            TestSavedProposals.clear() // below the cap, so the count is exact
            repeat(10) { assertEquals(badRequest, spender.client.postJson(SAVED_PATH, "{ not json").status, "request ${it + 1}") }
            val limited = spender.client.postJson(SAVED_PATH, "{ not json")
            assertEquals(HttpStatusCode.TooManyRequests, limited.status, "the limiter runs before the body is read")
            assertTrue(limited.headers[HttpHeaders.RetryAfter]?.toLongOrNull()?.let { it in 1L..60L } == true, "Retry-After")
            val run = s.w.admin.client.savedRun(s.pair)
            assertEquals(HttpStatusCode.TooManyRequests, spender.client.saveProposal(run, s.pair).status, "a valid save is refused too")
            assertEquals(badRequest, other.client.postJson(SAVED_PATH, "{ not json").status, "another login's bucket")
            assertEquals(created, other.client.saveProposal(run, s.pair).status)
            assertEquals(1, TestSavedProposals.count(), "only the other login's save was stored")
        }

    @Test
    fun `a stale view is 409 for the whole save - the revision from the future, a changed scope, a colleague's drag - nothing stored`() =
        testApplication {
            val s = savedWorld("sv409")
            TestSavedProposals.clear() // below the cap: a save prunes nothing, so the counts are exact
            val client = s.both.client
            val run = client.savedRun(s.pair)
            val before = TestSavedProposals.count()
            val revision = TestPlan.revision()

            client.saveProposal(run, s.pair, revision = revision + 1).assertConflict(STALE_REVISION_PROBLEM)
            client.saveProposal(run, s.pair, hash = "1".repeat(64)).assertConflict(STALE_SCOPE_PROBLEM)
            // The token carries asOf: the hash of one day is not the run of another.
            client.saveProposal(run, s.pair, asOf = "2027-02-07").assertConflict(STALE_SCOPE_PROBLEM)
            TestHolidays.with("2027-02-03") { client.saveProposal(run, s.pair).assertConflict(STALE_SCOPE_PROBLEM) }
            assertEquals(created, client.saveProposal(run, s.pair).status, "the holiday removed again, the run stands")

            // A colleague drags a milestone of a run team (it is in no digest: its own schedule revision is what notices).
            val fresh = client.savedRun(s.pair)
            TestPlan.schedule(s.b2, "2027-04-07", "2027-04-08")
            client.saveProposal(fresh, s.pair).assertConflict(STALE_SCOPE_PROBLEM)
            assertEquals(before + 1, TestSavedProposals.count(), "only the one clean save was stored")
            assertTrue(TestPlan.revision() > revision, "the drag and the holiday moved the plan; the saves did not")
        }

    @Test
    fun `a ticked id that is not a move of the run is 400 naming it - after the 409s, nothing stored`() = testApplication {
        val s = savedWorld("sv400")
        val client = s.both.client
        val run = client.savedRun(s.pair)
        val before = TestSavedProposals.count()
        val response = client.saveProposal(run, s.pair, selected = listOf(s.a1, s.c1, 999_999u))
        assertEquals(badRequest, response.status)
        val missing = listOf(s.c1, 999_999u).sorted().joinToString(", ")
        assertTrue("not moves of the run: $missing\"" in response.bodyAsText(), "names exactly the ticked ids that are no move")
        client.saveProposal(run, s.pair, selected = listOf(s.c1), hash = "1".repeat(64)).assertConflict(STALE_SCOPE_PROBLEM)
        assertEquals(before, TestSavedProposals.count())
    }

    @Test
    fun `any signed-in user lists and reads a saved proposal - the flags follow who may delete or accept it`() = testApplication {
        val s = savedWorld("svr")
        val run = s.both.client.savedRun(s.pair)
        val id = s.both.client.saveProposal(run, s.pair).body<SavedProposalSummary>().id

        val flags = listOf(
            "the two-team manager" to (s.both to true), "ADMIN" to (s.w.admin to true),
            "the manager of an outside team" to (s.m3 to false), "a stranger" to (s.w.stranger to false),
            "a person-less login" to (s.w.personless to false), "a project owner" to (s.w.projectOwner to false),
        )
        for ((label, entry) in flags) {
            val (caller, mayAct) = entry
            // Accept is wider than delete (1.33): the manager of ONE stored team accepts their part; see the single-team test below.
            val listed = caller.client.get(SAVED_PATH).also { assertEquals(HttpStatusCode.OK, it.status, label) }
                .body<SavedProposalList>().items
            assertEquals(mayAct, listed.single { it.id == id }.can.delete, "list can.delete: $label")
            assertEquals(s.both.personId, listed.single { it.id == id }.createdBy?.personId, "list createdBy.personId: $label")
            val record = caller.client.get("$SAVED_PATH/$id").also { assertEquals(HttpStatusCode.OK, it.status, label) }
                .body<SavedProposalRecord>()
            assertEquals(mayAct, record.can.delete, "can.delete: $label")
            assertEquals(mayAct, record.can.accept, "can.accept: $label")
            assertEquals(run, record.proposal, "everyone reads the same document: $label")
        }
        assertEquals(notFound, s.w.stranger.client.get("$SAVED_PATH/999999").status)
        assertEquals(notFound, s.w.admin.client.get("$SAVED_PATH/999999").status)
        assertEquals(badRequest, s.w.admin.client.get("$SAVED_PATH/not-a-number").status)
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get("$SAVED_PATH/$id").status)
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(SAVED_PATH).status)
    }

    @Test
    fun `the manager of ONE stored team may accept a saved proposal but not delete it`() = testApplication {
        val s = savedWorld("svo")
        val one = planCaller("svo-one")
        val t4 = TestTeams.seed(planName("svo-t4"), one.personId)
        TestPlan.capacityPeriod(t4, "2027-01-04", 10.0)
        val pair = listOf(s.t1, t4)
        val run = s.w.admin.client.savedRun(pair)
        val id = s.w.admin.client.saveProposal(run, pair).body<SavedProposalSummary>().id

        val callers = listOf(
            Triple("ADMIN", s.w.admin, true),
            Triple("the manager of the second team", one, true),
            Triple("the manager of the first team", s.both, true),
            Triple("the manager of an outside team", s.m3, false),
            Triple("a stranger", s.w.stranger, false),
        )
        for ((label, caller, mayAccept) in callers) {
            val record = caller.client.get("$SAVED_PATH/$id").body<SavedProposalRecord>()
            assertEquals(mayAccept, record.can.accept, "can.accept: $label")
            assertEquals(caller === s.w.admin, record.can.delete, "can.delete stays the manager of EVERY team: $label")
        }
    }

    @Test
    fun `delete is read-before-guard - 404 for every caller, then 403 unless ADMIN or the manager of every team`() = testApplication {
        val s = savedWorld("svd")
        val run = s.both.client.savedRun(s.pair)
        val id = s.both.client.saveProposal(run, s.pair).body<SavedProposalSummary>().id

        for (caller in listOf(s.w.stranger, s.m3, s.w.admin, s.both)) {
            assertEquals(notFound, caller.client.delete("$SAVED_PATH/999999").status, "unknown id is 404 for everyone")
        }
        for (caller in listOf(s.w.stranger, s.m3, s.w.projectOwner, s.w.personless, s.w.editor)) {
            assertEquals(forbidden, caller.client.delete("$SAVED_PATH/$id").status)
        }
        assertTrue(TestSavedProposals.exists(id), "refused deletes removed nothing")
        withAuditCapture { capture ->
            assertEquals(HttpStatusCode.NoContent, s.both.client.delete("$SAVED_PATH/$id").status)
            assertFalse(TestSavedProposals.exists(id))
            val line = assertNotNull(capture.awaitEvent { it.message == "schedule_proposal.deleted" })
            assertTrue(line.hasKeyValue("byUserId", s.both.userId.toLong()) && line.hasKeyValue("savedProposalId", id.toLong()))
            assertTrue(line.hasKeyValue("name", "Saved 3"))
            assertEquals(notFound, s.both.client.delete("$SAVED_PATH/$id").status, "already gone")
            assertEquals(notFound, s.both.client.get("$SAVED_PATH/$id").status)
        }
        val second = s.both.client.saveProposal(run, s.pair).body<SavedProposalSummary>().id
        assertEquals(HttpStatusCode.NoContent, s.w.admin.client.delete("$SAVED_PATH/$second").status, "ADMIN deletes any")
    }

    @Test
    fun `a stored team that was deleted since leaves the delete to ADMIN - the manager no longer manages it`() = testApplication {
        val s = savedWorld("svdt")
        val empty = TestTeams.seed(planName("svdt-empty"), s.both.personId)
        val pair = listOf(s.t1, empty)
        val run = s.both.client.savedRun(pair)
        val id = s.both.client.saveProposal(run, pair, selected = run.moveIds().take(1)).body<SavedProposalSummary>().id
        assertEquals(HttpStatusCode.NoContent, s.w.admin.client.delete("/api/v1/teams/$empty").status)

        val record = s.both.client.get("$SAVED_PATH/$id").body<SavedProposalRecord>()
        assertEquals(SavedProposalState.CHANGED, record.state, "a team of the run is gone")
        assertFalse(record.can.delete || record.can.accept)
        assertEquals(forbidden, s.both.client.delete("$SAVED_PATH/$id").status)
        assertEquals(HttpStatusCode.NoContent, s.w.admin.client.delete("$SAVED_PATH/$id").status)
    }

    @Test
    fun `the audit - saved carries the plan's fields, a read and a rejected save emit none`() = testApplication {
        val s = savedWorld("sva")
        TestSavedProposals.clear() // below the cap: nothing is pruned
        val run = s.both.client.savedRun(s.pair)
        withAuditCapture { capture ->
            s.both.client.get(SAVED_PATH)
            s.both.client.saveProposal(run, s.pair, hash = "1".repeat(64)).assertConflict(STALE_SCOPE_PROBLEM)
            val summary = s.both.client.saveProposal(run, s.pair, selected = listOf(s.a1), name = "Audit run").body<SavedProposalSummary>()
            val line = assertNotNull(capture.awaitEvent { it.message == "schedule_proposal.saved" })
            assertTrue(line.hasKeyValue("byUserId", s.both.userId.toLong()) && line.hasKeyValue("savedProposalId", summary.id.toLong()))
            assertTrue(line.hasKeyValue("name", "Audit run") && line.hasKeyValue("asOf", SAVED_AS_OF))
            assertTrue(line.hasKeyValue("teamIds", s.pair.sorted().joinToString(",")))
            assertTrue(line.hasKeyValue("revision", run.revision) && line.hasKeyValue("moveCount", 3))
            assertTrue(line.hasKeyValue("selectedCount", 1))
            assertTrue(line.hasKeyValue("prunedIds", ""))
            assertEquals(1, capture.events.count { it.message == "schedule_proposal.saved" }, "the 409 audited nothing")
            assertEquals(forbidden, s.w.stranger.client.saveProposal(run, s.pair).status)
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", s.w.stranger.userId.toLong()) })
        }
    }
}
