package ch.nokillswit

import ch.nokillswit.planning.PlanOrderResponse
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.STALE_REVISION_PROBLEM
import ch.nokillswit.plugins.ProblemDetail
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
 * The shared plan order (V34) over HTTP: `PUT /work-stream-order` (ADMIN only, guard-before-read) and
 * `PUT /work-streams/{id}/program-order` (the stream's owner or ADMIN, read-before-guard). Each list is compared against ITS OWN
 * revision, a partial list leaves the rest unlisted and `[]` is the reset. The lifecycle half (the dense positions after a delete or a
 * move, the deferrable constraints, the races, the held-request re-guard, the stale-row repair) is `PlanOrderLifecycleTest`.
 * The work stream order is ONE global list: every test that writes it ends by emptying it.
 */
class PlanOrderTest {
    private val ok = HttpStatusCode.OK
    private val forbidden = HttpStatusCode.Forbidden
    private val badRequest = HttpStatusCode.BadRequest
    private val conflict = HttpStatusCode.Conflict

    private suspend fun HttpClient.rawStreamOrder(body: String): HttpResponse = put("/api/v1/work-stream-order") {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpClient.rawProgramOrder(streamId: UInt, body: String): HttpResponse =
        put("/api/v1/work-streams/$streamId/program-order") {
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    private suspend fun PlanWorld.programs(count: Int, streamId: UInt = this.streamId): List<UInt> =
        List(count) { TestPlan.program(streamId, programOwner.personId!!) }

    @Test
    fun `ADMIN alone orders the work streams - every owner and every other caller gets 403`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wsadm")
        val second = TestPlan.workStream(w.streamOwner.personId!!)
        try {
            val first = w.admin.client.putWorkStreamOrder(TestPlan.revision(), listOf(w.streamId, second))
            assertEquals(ok, first.status)
            assertEquals(listOf(1 to w.streamId, 2 to second), TestPlan.workStreamOrderRows())
            assertEquals(TestPlan.revision(), first.body<PlanOrderResponse>().revision, "the answer is the plan revision it left behind")
            val denied = listOf(
                "stream owner" to w.streamOwner, "program owner" to w.programOwner, "project owner" to w.projectOwner,
                "stranger" to w.stranger, "personless" to w.personless, "roadmap editor" to w.editor,
            )
            val revision = TestPlan.revision()
            for ((label, caller) in denied) {
                assertEquals(forbidden, caller.client.putWorkStreamOrder(revision, listOf(second, w.streamId)).status, label)
            }
            assertEquals(listOf(1 to w.streamId, 2 to second), TestPlan.workStreamOrderRows(), "the refused writes stored nothing")
            assertEquals(revision, TestPlan.revision(), "nor moved the plan revision")
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }

    @Test
    fun `a forbidden caller's malformed body stays 403 on both PUTs, and the refusal is audited centrally`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pord403")
        withAuditCapture { capture ->
            assertEquals(forbidden, w.streamOwner.client.rawStreamOrder("{ not json").status)
            assertEquals(forbidden, w.stranger.client.rawStreamOrder("""{"workStreamIds":"x"}""").status)
            assertEquals(forbidden, w.programOwner.client.rawProgramOrder(w.streamId, "{ not json").status)
            assertEquals(forbidden, w.stranger.client.rawProgramOrder(w.streamId, """{"programIds":"x"}""").status)
            val owner = w.programOwner.userId.toLong()
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", owner) })
            val stranger = w.stranger.userId.toLong()
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", stranger) })
        }
    }

    @Test
    fun `an unknown or deleted work stream is 404 for every caller before the 403, and a malformed body does not change that`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pord404")
            val gone = TestPlan.workStream(w.streamOwner.personId!!)
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/work-streams/$gone").status)
            val revision = TestPlan.revision()
            for ((label, caller) in listOf("stranger" to w.stranger, "stream owner" to w.streamOwner, "personless" to w.personless,
                "admin" to w.admin)) {
                val unknown = caller.client.putProgramOrder(999999u, revision, emptyList())
                assertEquals(HttpStatusCode.NotFound, unknown.status, "unknown: $label")
                assertEquals(HttpStatusCode.NotFound, caller.client.putProgramOrder(gone, revision, emptyList()).status, "deleted: $label")
            }
            assertEquals(HttpStatusCode.NotFound, w.stranger.client.rawProgramOrder(gone, "{ not json").status)
            assertEquals(revision, TestPlan.revision())
        }

    @Test
    fun `the stream's owner and ADMIN order its programs - the program owner and every other caller get 403`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pordwho")
        val (b, c) = w.programs(2)
        val a = w.programId
        assertEquals(ok, w.streamOwner.client.putProgramOrder(w.streamId, TestPlan.revision(), listOf(a, b, c)).status)
        assertEquals(listOf(1 to a, 2 to b, 3 to c), TestPlan.programOrderRows(w.streamId))
        val admin = w.admin.client.putProgramOrder(w.streamId, TestPlan.revision(), listOf(c, b, a))
        assertEquals(ok, admin.status)
        assertEquals(TestPlan.revision(), admin.body<PlanOrderResponse>().revision)
        val elsewhere = TestPlan.workStream(w.stranger.personId!!)
        val denied = listOf(
            "program owner" to w.programOwner, "project owner" to w.projectOwner, "stranger" to w.stranger,
            "personless" to w.personless, "roadmap editor" to w.editor,
        )
        val revision = TestPlan.revision()
        for ((label, caller) in denied) {
            assertEquals(forbidden, caller.client.putProgramOrder(w.streamId, revision, listOf(a)).status, label)
        }
        // The owner of ANOTHER stream owns nothing here, and ordering is a right of the stream, not of the programs in it.
        val own = w.stranger.client.putProgramOrder(elsewhere, TestPlan.revision(), emptyList())
        assertEquals(ok, own.status, "an owner orders its own stream")
        val before = TestPlan.revision()
        assertEquals(forbidden, w.stranger.client.putProgramOrder(w.streamId, before, listOf(a)).status)
        assertEquals(listOf(1 to c, 2 to b, 3 to a), TestPlan.programOrderRows(w.streamId), "the refused writes stored nothing")
        assertEquals(before, TestPlan.revision())
    }

    @Test
    fun `the 400s of the work stream order come after the guard and change nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wsbad")
        val kept = TestPlan.workStream(w.streamOwner.personId!!)
        val doomed = TestPlan.workStream(w.streamOwner.personId)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/work-streams/$doomed").status)
        try {
            TestPlan.workStreamOrder(listOf(kept))
            val revision = TestPlan.revision()
            val admin = w.admin.client
            val bad = mapOf(
                "duplicate" to listOf(kept, kept),
                "unknown" to listOf(kept, 999_999u),
                "deleted" to listOf(kept, doomed),
                "more than 1000" to List(1001) { 5_000_000u + it.toUInt() },
            )
            for ((label, ids) in bad) assertEquals(badRequest, admin.putWorkStreamOrder(revision, ids).status, label)
            val tooMany = admin.putWorkStreamOrder(revision, bad.getValue("more than 1000")).body<ProblemDetail>()
            assertEquals("workStreamIds must list at most 1000 ids", tooMany.detail, "the ceiling, not an unknown-id refusal")
            val twice = admin.putWorkStreamOrder(revision, listOf(kept, kept)).body<ProblemDetail>()
            assertEquals("workStreamIds must be distinct", twice.detail)
            val unknown = admin.putWorkStreamOrder(revision, listOf(kept, 999_999u)).body<ProblemDetail>()
            assertTrue(unknown.detail!!.contains("999999"), "the detail names the id")
            assertEquals(badRequest, admin.putWorkStreamOrder(-1, listOf(kept)).status, "a negative revision")
            assertEquals(badRequest, admin.rawStreamOrder("""{"expectedRevision":$revision,"workStreamIds":[-1]}""").status)
            assertEquals(badRequest, admin.rawStreamOrder("""{"workStreamIds":[]}""").status, "the revision is required")
            assertEquals(badRequest, admin.rawStreamOrder("""{"expectedRevision":$revision}""").status, "the list is required")
            val outsider = w.stranger.client.putWorkStreamOrder(revision, listOf(kept, 999_999u))
            assertEquals(forbidden, outsider.status, "the guard outranks the ids")
            assertEquals(listOf(1 to kept), TestPlan.workStreamOrderRows())
            assertEquals(revision, TestPlan.revision(), "a rejected PUT never moves the revision")
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }

    @Test
    fun `the 400s of the program order come after the guard - other-stream, deleted and unknown ids change nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pordbad")
        val (b, doomed) = w.programs(2)
        val a = w.programId
        val otherStream = TestPlan.workStream(w.streamOwner.personId!!)
        val (foreign) = w.programs(1, otherStream)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/programs/$doomed").status)
        TestPlan.programOrder(w.streamId, listOf(a))
        val revision = TestPlan.revision()
        val owner = w.streamOwner.client
        val bad = mapOf(
            "duplicate" to listOf(a, a),
            "unknown" to listOf(a, 999_999u),
            "deleted" to listOf(a, doomed),
            "more than 1000" to List(1001) { 5_000_000u + it.toUInt() },
        )
        for ((label, ids) in bad) assertEquals(badRequest, owner.putProgramOrder(w.streamId, revision, ids).status, label)
        val tooMany = owner.putProgramOrder(w.streamId, revision, bad.getValue("more than 1000")).body<ProblemDetail>()
        assertEquals("programIds must list at most 1000 ids", tooMany.detail, "the ceiling, not an unknown-id refusal")
        val otherList = owner.putProgramOrder(w.streamId, revision, listOf(a, foreign))
        assertEquals(badRequest, otherList.status, "a program of another work stream cannot enter this list")
        assertTrue(otherList.body<ProblemDetail>().detail!!.contains("$foreign"))
        assertEquals("programIds must be distinct", owner.putProgramOrder(w.streamId, revision, listOf(a, a)).body<ProblemDetail>().detail)
        val outsider = w.stranger.client.putProgramOrder(w.streamId, revision, listOf(a, foreign))
        assertEquals(forbidden, outsider.status, "the guard outranks the ids")
        assertEquals(badRequest, owner.putProgramOrder(w.streamId, -1, listOf(a, b)).status, "a negative revision")
        assertEquals(badRequest, owner.rawProgramOrder(w.streamId, """{"expectedRevision":$revision,"programIds":[-1]}""").status)
        assertEquals(badRequest, owner.rawProgramOrder(w.streamId, """{"programIds":[]}""").status, "the revision is required")
        assertEquals(listOf(1 to a), TestPlan.programOrderRows(w.streamId))
        assertEquals(emptyList(), TestPlan.programOrderRows(otherStream))
        assertEquals(revision, TestPlan.revision(), "a rejected PUT never moves the revision")
    }

    @Test
    fun `a stale expectedRevision is 409 with the stale-revision type in both directions, and a first write needs only a valid one`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pstale")
            val (b, c) = w.programs(2)
            val a = w.programId
            val admin = w.admin.client
            val owner = w.streamOwner.client
            assertNull(TestPlan.programOrderRevision(w.streamId))
            // A stream whose programs were never ordered has no revision of its own: ANY value up to the plan revision passes.
            for (future in listOf(TestPlan.revision() + 1, Long.MAX_VALUE)) {
                val ahead = owner.putProgramOrder(w.streamId, future, listOf(a, b))
                assertEquals(conflict, ahead.status, "a view from the future is stale even before the first write: $future")
                assertEquals(STALE_REVISION_PROBLEM, ahead.body<ProblemDetail>().type)
            }
            assertNull(TestPlan.programOrderRevision(w.streamId), "the refused writes stored nothing")
            val first = owner.putProgramOrder(w.streamId, 0, listOf(a, b)).body<PlanOrderResponse>().revision
            assertEquals(first, TestPlan.programOrderRevision(w.streamId))
            val second = owner.putProgramOrder(w.streamId, first, listOf(b, a)).body<PlanOrderResponse>().revision
            assertEquals(first + 1, second, "the revision a PUT answered is current: chained saves with it work")
            val behind = owner.putProgramOrder(w.streamId, first, listOf(a, b, c))
            assertEquals(conflict, behind.status)
            assertEquals(STALE_REVISION_PROBLEM, behind.body<ProblemDetail>().type)
            for (future in listOf(TestPlan.revision() + 1, Long.MAX_VALUE)) {
                val ahead = owner.putProgramOrder(w.streamId, future, listOf(a, b, c))
                assertEquals(conflict, ahead.status, "a view from the future: $future")
                assertEquals(STALE_REVISION_PROBLEM, ahead.body<ProblemDetail>().type)
            }
            // Stale is checked before the ids, so a stale list naming a since-deleted program is the reload signal, not a 400.
            assertEquals(conflict, owner.putProgramOrder(w.streamId, first, listOf(999_999u)).status)
            assertEquals(listOf(1 to b, 2 to a), TestPlan.programOrderRows(w.streamId))
            assertEquals(second, TestPlan.programOrderRevision(w.streamId), "a rejected PUT leaves the order revision alone")

            try {
                // The work stream order, the same two directions. A fresh install has revision 0 here; so does this assertion's start.
                TestPlan.scalar("UPDATE plan_state SET work_stream_order_revision = 0 WHERE id = 1 RETURNING 1") { it.getInt(1) }
                for (future in listOf(TestPlan.revision() + 1, Long.MAX_VALUE)) {
                    val ahead = admin.putWorkStreamOrder(future, listOf(w.streamId))
                    assertEquals(conflict, ahead.status, "a view from the future is stale even before the first write: $future")
                    assertEquals(STALE_REVISION_PROBLEM, ahead.body<ProblemDetail>().type)
                }
                assertEquals(0L, TestPlan.workStreamOrderRevision(), "the refused writes stamped nothing")
                val one = admin.putWorkStreamOrder(0, listOf(w.streamId)).body<PlanOrderResponse>().revision
                assertEquals(one, TestPlan.workStreamOrderRevision())
                val two = admin.putWorkStreamOrder(one, emptyList()).body<PlanOrderResponse>().revision
                val old = admin.putWorkStreamOrder(one, listOf(w.streamId))
                assertEquals(conflict, old.status)
                assertEquals(STALE_REVISION_PROBLEM, old.body<ProblemDetail>().type)
                val future = admin.putWorkStreamOrder(TestPlan.revision() + 1, listOf(w.streamId))
                assertEquals(conflict, future.status)
                assertEquals(STALE_REVISION_PROBLEM, future.body<ProblemDetail>().type)
                assertEquals(conflict, admin.putWorkStreamOrder(one, listOf(999_999u)).status, "stale before the ids")
                assertEquals(two, TestPlan.workStreamOrderRevision(), "a rejected PUT leaves the order revision alone")
            } finally {
                TestPlan.resetWorkStreamOrder()
            }
        }

    @Test
    fun `each list's revision is its own - another list, another stream, a plan write and a ranking never stale it`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("prev", teams = true)
        val (b) = w.programs(1)
        val a = w.programId
        val other = TestPlan.workStream(w.streamOwner.personId!!)
        val (x, y) = w.programs(2, other)
        try {
            val owner = w.streamOwner.client
            val mine = owner.putProgramOrder(w.streamId, TestPlan.revision(), listOf(a, b)).body<PlanOrderResponse>().revision
            val theirs = w.streamOwner.client.putProgramOrder(other, TestPlan.revision(), listOf(x, y)).body<PlanOrderResponse>().revision
            val admin = w.admin.client
            val streams = admin.putWorkStreamOrder(TestPlan.revision(), listOf(w.streamId, other)).body<PlanOrderResponse>().revision

            // A ranking write and a team order, both held from here: the order PUTs below must not stamp either.
            val t = w.requireTeams()
            TestPlan.teamOrder(t.teamId, listOf(TestPlan.milestone(w.projectId, t.teamId)))
            val ranking = RankingUpdateRequest(TestPlan.revision(), listOf(w.projectId))
            assertEquals(ok, admin.putJson("/api/v1/roadmap/ranking", ranking).status)
            val rankingStamp = TestPlan.scalar("SELECT ranking_revision FROM plan_state WHERE id = 1") { it.getLong(1) }
            val teamStamp = TestPlan.teamOrderRevision(t.teamId)

            // The held revisions stay current through writes elsewhere: a ranking, another stream's list, plan writes, a node create.
            assertEquals(ok, w.streamOwner.client.putProgramOrder(other, theirs, listOf(y, x)).status)
            TestPlan.workStream(w.streamOwner.personId)
            TestPlan.program(w.streamId, w.programOwner.personId!!)
            assertEquals(ok, owner.putProgramOrder(w.streamId, mine, listOf(b, a)).status, "this stream's list: still current")
            assertEquals(ok, admin.putWorkStreamOrder(streams, listOf(other, w.streamId)).status, "the stream order: still current")
            // And the reverse: writing the stream order does not stale a program order held from before it.
            val held = requireNotNull(TestPlan.programOrderRevision(w.streamId))
            assertEquals(ok, w.admin.client.putWorkStreamOrder(TestPlan.revision(), listOf(w.streamId, other)).status)
            assertEquals(ok, w.streamOwner.client.putProgramOrder(w.streamId, held, listOf(a, b)).status)
            val unchanged = TestPlan.scalar("SELECT ranking_revision FROM plan_state WHERE id = 1") { it.getLong(1) }
            assertEquals(rankingStamp, unchanged, "an order PUT never stamps the ranking revision")
            assertEquals(teamStamp, TestPlan.teamOrderRevision(t.teamId), "nor a team's order revision")
            assertEquals(ok, admin.putJson("/api/v1/roadmap/ranking", RankingUpdateRequest(TestPlan.revision(), emptyList())).status)
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }

    @Test
    fun `a partial list stores the listed ones only and an empty list is the reset, both bumping`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ppart")
        val (b, c) = w.programs(2)
        val a = w.programId
        val owner = w.streamOwner.client

        val before = TestPlan.revision()
        assertEquals(ok, owner.putProgramOrder(w.streamId, before, listOf(c, a)).status)
        assertEquals(listOf(1 to c, 2 to a), TestPlan.programOrderRows(w.streamId), "b is unlisted: it has no row")
        assertEquals(before + 1, TestPlan.revision())
        assertEquals(ok, owner.putProgramOrder(w.streamId, before + 1, listOf(b, c, a)).status)
        assertEquals(listOf(1 to b, 2 to c, 3 to a), TestPlan.programOrderRows(w.streamId))
        val reset = owner.putProgramOrder(w.streamId, before + 2, emptyList())
        assertEquals(ok, reset.status)
        assertEquals(emptyList(), TestPlan.programOrderRows(w.streamId), "[] removes every row of the stream")
        assertEquals(before + 3, reset.body<PlanOrderResponse>().revision, "the reset is a plan write")
        assertEquals(before + 3, TestPlan.programOrderRevision(w.streamId), "and the stream's program order revision")
        assertEquals(conflict, owner.putProgramOrder(w.streamId, before + 2, listOf(a)).status)

        val streams = listOf(w.streamId, TestPlan.workStream(w.streamOwner.personId!!))
        try {
            val sBefore = TestPlan.revision()
            assertEquals(ok, w.admin.client.putWorkStreamOrder(sBefore, listOf(streams[1])).status)
            assertEquals(listOf(1 to streams[1]), TestPlan.workStreamOrderRows(), "the other stream is unlisted")
            assertEquals(ok, w.admin.client.putWorkStreamOrder(sBefore + 1, emptyList()).status)
            assertEquals(emptyList(), TestPlan.workStreamOrderRows(), "[] removes every row")
            assertEquals(sBefore + 2, TestPlan.revision())
            assertEquals(sBefore + 2, TestPlan.workStreamOrderRevision())
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }

    @Test
    fun `both order PUTs are audited on every accepted write, a no-op and a reset included - and on nothing else`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pordaudit")
        val (b) = w.programs(1)
        val a = w.programId
        val other = TestPlan.workStream(w.streamOwner.personId!!)
        withAuditCapture { capture ->
            try {
                val first = TestPlan.revision()
                assertEquals(ok, w.streamOwner.client.putProgramOrder(w.streamId, first, listOf(a, b)).status)
                val created = capture.awaitEvent {
                    it.message == "work_stream.program_order_changed" && it.hasKeyValue("orderTo", "$a,$b")
                }
                assertNotNull(created)
                assertTrue(created.hasKeyValue("byUserId", w.streamOwner.userId.toLong()))
                assertTrue(created.hasKeyValue("workStreamId", w.streamId.toLong()))
                assertTrue(created.hasKeyValue("revisionFrom", first))
                assertTrue(created.hasKeyValue("revisionTo", first + 1))
                assertTrue(created.hasKeyValue("orderFrom", ""), "the default order is the empty text")

                // The same list again changes nothing and is still a plan write, so it is still on the trail.
                assertEquals(ok, w.admin.client.putProgramOrder(w.streamId, first + 1, listOf(a, b)).status)
                val noop = capture.awaitEvent {
                    it.message == "work_stream.program_order_changed" && it.hasKeyValue("orderFrom", "$a,$b") &&
                        it.hasKeyValue("orderTo", "$a,$b")
                }
                assertNotNull(noop)
                assertTrue(noop.hasKeyValue("byUserId", w.admin.userId.toLong()))
                assertEquals(ok, w.streamOwner.client.putProgramOrder(w.streamId, first + 2, emptyList()).status)
                assertNotNull(capture.awaitEvent { it.message == "work_stream.program_order_changed" && it.hasKeyValue("orderTo", "") })

                val s = TestPlan.revision()
                assertEquals(ok, w.admin.client.putWorkStreamOrder(s, listOf(other, w.streamId)).status)
                val listed = "$other,${w.streamId}"
                val streams = capture.awaitEvent { it.message == "plan.work_stream_order_changed" && it.hasKeyValue("orderTo", listed) }
                assertNotNull(streams)
                assertTrue(streams.hasKeyValue("byUserId", w.admin.userId.toLong()))
                assertTrue(streams.hasKeyValue("revisionFrom", s))
                assertTrue(streams.hasKeyValue("revisionTo", s + 1))
                assertEquals(ok, w.admin.client.putWorkStreamOrder(s + 1, emptyList()).status)
                assertNotNull(capture.awaitEvent { it.message == "plan.work_stream_order_changed" && it.hasKeyValue("orderFrom", listed) })

                // Nothing else is on the trail: a 409, a 400 and a 403 leave no order event.
                assertEquals(conflict, w.streamOwner.client.putProgramOrder(w.streamId, first, listOf(a)).status)
                assertEquals(badRequest, w.streamOwner.client.putProgramOrder(w.streamId, first + 3, listOf(a, a)).status)
                assertEquals(conflict, w.admin.client.putWorkStreamOrder(0, listOf(other)).status)
                assertEquals(badRequest, w.admin.client.putWorkStreamOrder(s + 2, listOf(other, other)).status)
                assertEquals(forbidden, w.stranger.client.putProgramOrder(w.streamId, first + 3, listOf(a)).status)
                assertEquals(forbidden, w.stranger.client.putWorkStreamOrder(s + 2, listOf(other)).status)
                assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", w.stranger.userId.toLong()) })
                val stream = w.streamId.toLong()
                val programEvents = capture.events.count {
                    it.message == "work_stream.program_order_changed" && it.hasKeyValue("workStreamId", stream)
                }
                assertEquals(3, programEvents)
                val admin = w.admin.userId.toLong()
                val streamEvents = capture.events.count {
                    it.message == "plan.work_stream_order_changed" && it.hasKeyValue("byUserId", admin)
                }
                assertEquals(2, streamEvents)
            } finally {
                TestPlan.resetWorkStreamOrder()
            }
        }
    }
}
