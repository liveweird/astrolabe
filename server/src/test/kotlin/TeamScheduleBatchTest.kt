package ch.nokillswit

import ch.nokillswit.planning.MAX_BATCH_SCHEDULE_ITEMS
import ch.nokillswit.planning.MilestoneScheduleRequest
import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.planning.STALE_REVISION_PROBLEM
import ch.nokillswit.planning.SkippedSchedule
import ch.nokillswit.planning.SkippedScheduleReason.GONE
import ch.nokillswit.planning.SkippedScheduleReason.NOT_ON_TEAM
import ch.nokillswit.planning.SkippedScheduleReason.NO_WORKING_DAY
import ch.nokillswit.planning.SkippedScheduleReason.STALE
import ch.nokillswit.planning.TeamScheduleBatchItem
import ch.nokillswit.planning.TeamScheduleBatchRequest
import ch.nokillswit.planning.TeamScheduleBatchResponse
import ch.nokillswit.plugins.ProblemDetail
import ch.qos.logback.classic.spi.ILoggingEvent
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.post
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
 * `POST /teams/{id}/milestone-schedules` (v0.8.0): the batch accept of an auto-proposal - N schedule PUTs in ONE plan write under the
 * TEAM's guard. The manager of the team or ADMIN write, nobody else (above all not the project owner); read-before-guard (404, 403, the
 * body); whole-batch 400s before the lock and a whole-batch 409 for a view from the future; then per item, under the lock, the first of
 * GONE / NOT_ON_TEAM / NO_WORKING_DAY / STALE skips the item and the rest are written, with ONE bump for the batch. 2027-02-01 is a Monday.
 */
class TeamScheduleBatchTest {
    private val ok = HttpStatusCode.OK
    private val forbidden = HttpStatusCode.Forbidden

    private fun item(id: UInt, start: String?, end: String?) = TeamScheduleBatchItem(id, start, end)

    /** The week of Mon 2027-02-01 and the week after it, as batch items. */
    private fun week1(id: UInt) = item(id, "2027-02-01", "2027-02-05")

    private fun week2(id: UInt) = item(id, "2027-02-08", "2027-02-12")

    private fun week3(id: UInt) = item(id, "2027-02-15", "2027-02-19")

    private fun ILoggingEvent.milestoneId(): Any? = keyValuePairs.single { it.key == "milestoneId" }.value

    private suspend fun HttpClient.batch(teamId: UInt, expected: Long, vararg items: TeamScheduleBatchItem): HttpResponse =
        postJson("/api/v1/teams/$teamId/milestone-schedules", TeamScheduleBatchRequest(expected, items.toList()))

    private suspend fun HttpClient.rawBatch(teamId: UInt, body: String): HttpResponse = post("/api/v1/teams/$teamId/milestone-schedules") {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpResponse.result(): TeamScheduleBatchResponse = body()

    private fun datesOf(id: UInt): Pair<String?, String?> =
        TestPlan.scalar("SELECT start_date::text, end_date::text FROM milestones WHERE id = $id") { it.getString(1) to it.getString(2) }

    private fun scheduleRevisionOf(id: UInt): Long =
        TestPlan.scalar("SELECT schedule_revision FROM milestones WHERE id = $id") { it.getLong(1) }

    private suspend fun PlanWorld.milestones(teamId: UInt, count: Int): List<UInt> = List(count) { TestPlan.milestone(projectId, teamId) }

    @Test
    fun `the team's manager and ADMIN apply a batch - the project owner and every other caller get 403, whatever they own`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tsb", teams = true)
            val t = w.requireTeams()
            val (a, b) = w.milestones(t.teamId, 2)
            val before = TestPlan.revision()
            val written = t.manager.client.batch(t.teamId, before, item(a, "2027-02-01", "2027-02-05"), item(b, "2027-02-08", "2027-02-09"))
            assertEquals(ok, written.status)
            val body = written.result()
            assertEquals(before + 1, body.revision, "the answer is the plan revision the write left behind")
            assertEquals(TestPlan.revision(), body.revision)
            assertEquals(listOf(a, b), body.accepted)
            assertEquals(emptyList(), body.skipped)
            assertEquals("2027-02-01" to "2027-02-05", datesOf(a))
            assertEquals("2027-02-08" to "2027-02-09", datesOf(b))
            assertEquals(body.revision, scheduleRevisionOf(a), "every written milestone is stamped with the new plan revision")
            assertEquals(body.revision, scheduleRevisionOf(b))

            val admin = w.admin.client.batch(t.teamId, body.revision, item(b, "2027-02-10", "2027-02-11"))
            assertEquals(ok, admin.status)
            assertEquals(listOf(b), admin.result().accepted)
            assertEquals("2027-02-10" to "2027-02-11", datesOf(b))

            val denied = listOf(
                "project owner" to w.projectOwner, "program owner" to w.programOwner, "stream owner" to w.streamOwner,
                "stranger" to w.stranger, "personless" to w.personless, "roadmap editor" to w.editor,
                "the other team's manager" to t.otherManager,
            )
            val revision = TestPlan.revision()
            for ((label, caller) in denied) {
                assertEquals(forbidden, caller.client.batch(t.teamId, revision, item(a, "2027-03-01", "2027-03-05")).status, label)
            }
            assertEquals("2027-02-01" to "2027-02-05", datesOf(a), "the refused batches wrote nothing")
            assertEquals(revision, TestPlan.revision(), "nor moved the plan revision")
        }

    @Test
    fun `an unknown or deleted team is 404 for every caller, and a forbidden caller's malformed body stays 403`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsb404", teams = true)
        val t = w.requireTeams()
        val gone = TestTeams.seed(planName("tsb404-gone"), null)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$gone").status)
        val callers = listOf("stranger" to w.stranger, "project owner" to w.projectOwner, "manager" to t.manager, "admin" to w.admin)
        for ((label, caller) in callers) {
            val revision = TestPlan.revision()
            val request = item(1u, "2027-02-01", "2027-02-05")
            assertEquals(HttpStatusCode.NotFound, caller.client.batch(999999u, revision, request).status, "unknown: $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.batch(gone, revision, request).status, "deleted: $label")
        }
        withAuditCapture { capture ->
            assertEquals(forbidden, w.projectOwner.client.rawBatch(t.teamId, "{ not json").status)
            assertEquals(forbidden, t.otherManager.client.rawBatch(t.teamId, """{"items":"x"}""").status)
            assertEquals(forbidden, w.stranger.client.batch(t.teamId, -1).status, "the guard outranks an empty batch with a bad revision")
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", w.projectOwner.userId.toLong()) })
        }
    }

    @Test
    fun `the whole-batch 400s come after the guard, write nothing and never move the revision`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsb400", teams = true)
        val t = w.requireTeams()
        val (a, b) = w.milestones(t.teamId, 2)
        val revision = TestPlan.revision()
        val manager = t.manager.client
        val good = item(b, "2027-02-08", "2027-02-09")
        val bad = mapOf(
            "negative revision" to manager.batch(t.teamId, -1, good),
            "no items" to manager.batch(t.teamId, revision),
            "more than 1000 items" to manager.batch(
                t.teamId, revision, *Array(MAX_BATCH_SCHEDULE_ITEMS + 1) { item(5_000_000u + it.toUInt(), "2027-02-01", "2027-02-05") },
            ),
            "an id twice" to manager.batch(t.teamId, revision, good, good),
            "start only" to manager.batch(t.teamId, revision, good, item(a, "2027-02-01", null)),
            "end only" to manager.batch(t.teamId, revision, good, item(a, null, "2027-02-05")),
            "not a date" to manager.batch(t.teamId, revision, good, item(a, "tomorrow", "2027-02-05")),
            "a timestamp" to manager.batch(t.teamId, revision, good, item(a, "2027-02-01T00:00:00Z", "2027-02-05")),
            "end before start" to manager.batch(t.teamId, revision, good, item(a, "2027-02-05", "2027-02-01")),
            "a weekend-only span" to manager.batch(t.teamId, revision, good, item(a, "2027-02-06", "2027-02-07")),
            "items missing" to manager.rawBatch(t.teamId, """{"expectedRevision":$revision}"""),
            "not JSON" to manager.rawBatch(t.teamId, "{ not json"),
        )
        for ((label, response) in bad) assertEquals(HttpStatusCode.BadRequest, response.status, label)
        assertTrue(
            bad.getValue("negative revision").body<ProblemDetail>().detail!!.contains("expectedRevision"),
            "the problem names the offending field",
        )
        assertTrue(bad.getValue("a weekend-only span").body<ProblemDetail>().detail!!.contains("items[1]"), "and the item's index")
        assertEquals(null to null, datesOf(b), "the valid item of a rejected batch was not written either")
        assertEquals(null to null, datesOf(a))
        assertEquals(revision, TestPlan.revision(), "a rejected batch never moves the revision")
        val outsider = t.otherManager.client.batch(t.teamId, revision, good, good)
        assertEquals(forbidden, outsider.status, "the guard outranks the body validation")
    }

    @Test
    fun `an expectedRevision above the plan revision is a 409 for the whole batch - nothing written, no bump`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsb409", teams = true)
        val t = w.requireTeams()
        val (a, b) = w.milestones(t.teamId, 2)
        val current = TestPlan.revision()
        for (future in listOf(current + 1, current + 1000, Long.MAX_VALUE)) {
            val response = t.manager.client.batch(t.teamId, future, week1(a), week2(b))
            assertEquals(HttpStatusCode.Conflict, response.status, "a view from the future: $future")
            assertEquals(STALE_REVISION_PROBLEM, response.body<ProblemDetail>().type)
        }
        assertEquals(null to null, datesOf(a))
        assertEquals(null to null, datesOf(b))
        assertEquals(current, TestPlan.revision())
        assertEquals(forbidden, w.stranger.client.batch(t.teamId, current + 1, item(a, "2027-02-01", "2027-02-05")).status, "403 first")
        assertEquals(ok, t.manager.client.batch(t.teamId, current, item(a, "2027-02-01", "2027-02-05")).status, "the current one passes")
    }

    @Test
    fun `a stale, gone, other-team or holiday-only item is skipped with its reason and the rest are written under one bump`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tsbskip", teams = true)
            val t = w.requireTeams()
            val team = w.milestones(t.teamId, 5)
            val (fresh1, fresh2, fresh3) = team.take(3)
            val (staled, doomed) = team.drop(3)
            val holidayHit = TestPlan.milestone(w.projectId, t.teamId)
            val (elsewhere) = w.milestones(t.otherTeamId, 1)
            val movedName = planName("tsbskip-moved")
            val moving = TestPlan.milestone(w.projectId, t.teamId, movedName)
            TestPlan.schedule(fresh1, "2027-03-01", "2027-03-05")
            val view = TestPlan.revision() // the revision the "proposal" was read at

            // After the view: somebody reschedules one item, deletes another, moves a third to another team; an unrelated write too.
            TestPlan.schedule(staled, "2027-03-08", "2027-03-12")
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$doomed").status)
            val away = MilestoneUpdateRequest(movedName, null, t.otherTeamId, 2.0)
            assertEquals(HttpStatusCode.NoContent, w.admin.client.putJson("/api/v1/milestones/$moving", away).status)
            TestPlan.schedule(elsewhere, "2027-03-01", "2027-03-02")

            TestHolidays.with("2027-04-14") {
                val items = arrayOf(
                    item(fresh1, "2027-02-01", "2027-02-05"),
                    item(staled, "2027-02-01", "2027-02-05"),
                    item(doomed, "2027-02-01", "2027-02-05"),
                    item(elsewhere, "2027-02-01", "2027-02-05"),
                    item(moving, "2027-02-01", "2027-02-05"),
                    item(holidayHit, "2027-04-14", "2027-04-14"),
                    item(fresh2, "2027-02-08", "2027-02-12"),
                    item(fresh3, "2027-02-15", "2027-02-19"),
                )
                val staleBefore = scheduleRevisionOf(staled)
                val before = TestPlan.revision()
                val response = t.manager.client.batch(t.teamId, view, *items)
                assertEquals(ok, response.status)
                val body = response.result()
                assertEquals(listOf(fresh1, fresh2, fresh3), body.accepted)
                assertEquals(
                    listOf(
                        SkippedSchedule(staled, STALE), SkippedSchedule(doomed, GONE), SkippedSchedule(elsewhere, NOT_ON_TEAM),
                        SkippedSchedule(moving, NOT_ON_TEAM), SkippedSchedule(holidayHit, NO_WORKING_DAY),
                    ),
                    body.skipped,
                )
                assertEquals(before + 1, body.revision, "ONE bump for the batch")
                assertEquals(body.revision, TestPlan.revision())
                assertEquals("2027-02-01" to "2027-02-05", datesOf(fresh1), "an unrelated plan write after the view did not stale it")
                assertEquals("2027-02-08" to "2027-02-12", datesOf(fresh2))
                assertEquals("2027-02-15" to "2027-02-19", datesOf(fresh3))
                for (id in listOf(fresh1, fresh2, fresh3)) assertEquals(body.revision, scheduleRevisionOf(id), "stamped, id $id")
                assertEquals("2027-03-08" to "2027-03-12", datesOf(staled), "the colleague's dates stand")
                assertEquals(staleBefore, scheduleRevisionOf(staled), "a skipped item is untouched")
                assertEquals(null to null, datesOf(doomed))
                assertEquals("2027-03-01" to "2027-03-02", datesOf(elsewhere), "the other team's milestone is not this manager's to move")
                assertEquals(null to null, datesOf(moving), "moved to another team after the view")
                assertEquals(null to null, datesOf(holidayHit))
            }
        }

    @Test
    fun `an all-skipped batch is still a 200 and bumps the revision once`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsball", teams = true)
        val t = w.requireTeams()
        val (staled, doomed) = w.milestones(t.teamId, 2)
        val view = TestPlan.revision()
        TestPlan.schedule(staled, "2027-03-08", "2027-03-12")
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$doomed").status)
        val before = TestPlan.revision()
        val response = t.manager.client.batch(t.teamId, view, week1(staled), week1(doomed))
        assertEquals(ok, response.status)
        val body = response.result()
        assertEquals(emptyList(), body.accepted)
        assertEquals(listOf(SkippedSchedule(staled, STALE), SkippedSchedule(doomed, GONE)), body.skipped)
        assertEquals(before + 1, body.revision)
        assertEquals(before + 1, TestPlan.revision(), "the lock was taken and the write ran: the conservative rule")
        assertEquals("2027-03-08" to "2027-03-12", datesOf(staled))
    }

    @Test
    fun `a batch mixing dated and null items is written by multi-row statements - every row lands, nulls included`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsbmix", teams = true)
        val t = w.requireTeams()
        val ids = w.milestones(t.teamId, 7) // seven rows = statements of 4, 2 and 1 rows
        TestPlan.schedule(ids[0], "2027-02-01", "2027-02-05")
        TestPlan.schedule(ids[1], "2027-02-08", "2027-02-09")
        TestPlan.schedule(ids[2], "2027-02-10", "2027-02-11")
        val untouched = TestPlan.milestone(w.projectId, t.teamId)
        TestPlan.schedule(untouched, "2027-03-01", "2027-03-02")
        val view = TestPlan.revision()
        val response = t.manager.client.batch(
            t.teamId, view,
            item(ids[0], null, null), // dated -> unscheduled
            item(ids[1], "2027-04-05", "2027-04-09"), // dated -> dated
            item(ids[2], null, null),
            item(ids[3], "2027-04-12", "2027-04-12"), // unscheduled -> dated
            item(ids[4], null, null), // unscheduled -> unscheduled
            item(ids[5], "2027-04-13", "2027-04-14"),
            item(ids[6], "2027-04-15", "2027-04-16"),
        )
        assertEquals(ok, response.status)
        val body = response.result()
        assertEquals(ids, body.accepted)
        assertEquals(emptyList(), body.skipped)
        val expected = listOf(
            null to null, "2027-04-05" to "2027-04-09", null to null, "2027-04-12" to "2027-04-12",
            null to null, "2027-04-13" to "2027-04-14", "2027-04-15" to "2027-04-16",
        )
        assertEquals(expected, ids.map { datesOf(it) })
        for (id in ids) assertEquals(body.revision, scheduleRevisionOf(id), "stamped, id $id")
        assertEquals("2027-03-01" to "2027-03-02", datesOf(untouched), "an unlisted milestone keeps its dates")
    }

    @Test
    fun `a milestone whose project is deleted is GONE even while the milestone row is still active`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsbchain2", teams = true)
        val t = w.requireTeams()
        val second = secondProject(w)
        val orphan = TestPlan.milestone(second.projectId, t.teamId)
        val (live) = w.milestones(t.teamId, 1)
        PostgresTestSupport.connect().use { it.exec("UPDATE projects SET marked_as_deleted = TRUE WHERE id = ?", second.projectId.toInt()) }
        val response = t.manager.client.batch(t.teamId, TestPlan.revision(), week1(orphan), week1(live))
        assertEquals(ok, response.status)
        assertEquals(listOf(live), response.result().accepted)
        assertEquals(listOf(SkippedSchedule(orphan, GONE)), response.result().skipped, "the same chain rule as the single PUT's 404")
        assertEquals(null to null, datesOf(orphan))
    }

    @Test
    fun `an unknown milestone id is skipped as GONE, never a 400 or a 500`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsbunk", teams = true)
        val t = w.requireTeams()
        val (a) = w.milestones(t.teamId, 1)
        val response = t.manager.client.batch(t.teamId, TestPlan.revision(), week1(999_999u), week1(a))
        assertEquals(ok, response.status)
        val body = response.result()
        assertEquals(listOf(a), body.accepted)
        assertEquals(listOf(SkippedSchedule(999_999u, GONE)), body.skipped)
    }

    @Test
    fun `the answered revision is the next expectedRevision of a single PUT and of a second batch, and a stale item then skips`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tsbchain", teams = true)
            val t = w.requireTeams()
            val (a, b) = w.milestones(t.teamId, 2)
            val first = t.manager.client.batch(t.teamId, TestPlan.revision(), week1(a), item(b, "2027-02-08", "2027-02-09"))
            val revision = first.result().revision

            val single = MilestoneScheduleRequest(revision, "2027-02-02", "2027-02-04")
            assertEquals(ok, t.manager.client.putJson("/api/v1/milestones/$a/schedule", single).status, "a single PUT after a batch")
            val second = t.manager.client.batch(t.teamId, revision, item(b, "2027-02-10", "2027-02-11"))
            assertEquals(listOf(b), second.result().accepted, "a second batch with the first's answer")
            assertEquals("2027-02-10" to "2027-02-11", datesOf(b))

            // The first batch's revision is now behind both milestones: the same view skips them as STALE.
            val stale = t.manager.client.batch(t.teamId, revision, item(a, "2027-03-01", "2027-03-02"), item(b, "2027-03-01", "2027-03-02"))
            assertEquals(ok, stale.status)
            assertEquals(emptyList(), stale.result().accepted)
            assertEquals(listOf(SkippedSchedule(a, STALE), SkippedSchedule(b, STALE)), stale.result().skipped)
            assertEquals("2027-02-02" to "2027-02-04", datesOf(a))
        }

    @Test
    fun `an item equal to the stored span is accepted without an event, and the null pair unschedules`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsbnoop", teams = true)
        val t = w.requireTeams()
        val (same, unscheduled) = w.milestones(t.teamId, 2)
        TestPlan.schedule(same, "2027-02-01", "2027-02-05")
        TestPlan.schedule(unscheduled, "2027-02-08", "2027-02-09")
        val view = TestPlan.revision()
        withAuditCapture { capture ->
            val response = t.manager.client.batch(t.teamId, view, item(same, "2027-02-01", "2027-02-05"), item(unscheduled, null, null))
            assertEquals(listOf(same, unscheduled), response.result().accepted)
            assertNotNull(capture.awaitEvent { it.message == "team.schedule_batch_applied" && it.hasKeyValue("teamId", t.teamId.toLong()) })
            val scheduled = capture.events.filter { it.message == "milestone.scheduled" && it.hasKeyValue("teamId", t.teamId.toLong()) }
            assertEquals(listOf<Any?>(unscheduled.toLong()), scheduled.map { it.milestoneId() })
        }
        assertEquals("2027-02-01" to "2027-02-05", datesOf(same))
        assertEquals(null to null, datesOf(unscheduled))
        assertEquals(TestPlan.revision(), scheduleRevisionOf(same), "even an unchanged item is stamped, like a no-op single PUT")
    }

    @Test
    fun `the audit trail has milestone_scheduled per changed item and one team_schedule_batch_applied, and nothing on a rejection`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("tsbaudit", teams = true)
            val t = w.requireTeams()
            val (a, c, d) = w.milestones(t.teamId, 3)
            TestPlan.schedule(d, "2027-02-01", "2027-02-05")
            val view = TestPlan.revision()
            TestPlan.schedule(c, "2027-03-01", "2027-03-05")
            val teamId = t.teamId.toLong()
            withAuditCapture { capture ->
                val response = t.manager.client.batch(t.teamId, view, week2(d), week1(c), week3(a))
                val revision = response.result().revision
                val batch = capture.awaitEvent { it.message == "team.schedule_batch_applied" && it.hasKeyValue("teamId", teamId) }
                assertNotNull(batch)
                assertTrue(batch.hasKeyValue("byUserId", t.manager.userId.toLong()))
                assertTrue(batch.hasKeyValue("revisionTo", revision))
                assertTrue(batch.hasKeyValue("acceptedCount", 2))
                assertTrue(batch.hasKeyValue("skippedCount", 1))
                assertTrue(batch.hasKeyValue("acceptedIds", listOf(a, d).sorted().joinToString(",")), "ids ascending, comma-joined")
                assertTrue(batch.hasKeyValue("skippedIds", "$c"))

                val moved = capture.events.filter { it.message == "milestone.scheduled" && it.hasKeyValue("teamId", teamId) }
                assertEquals(setOf(a.toLong(), d.toLong()), moved.map { it.milestoneId() }.toSet())
                val rescheduled = moved.single { it.hasKeyValue("milestoneId", d.toLong()) }
                assertTrue(rescheduled.hasKeyValue("byUserId", t.manager.userId.toLong()))
                assertTrue(rescheduled.hasKeyValue("startFrom", "2027-02-01") && rescheduled.hasKeyValue("endFrom", "2027-02-05"))
                assertTrue(rescheduled.hasKeyValue("startTo", "2027-02-08") && rescheduled.hasKeyValue("endTo", "2027-02-12"))
                assertTrue(rescheduled.hasKeyValue("revisionTo", revision))
                val fresh = moved.single { it.hasKeyValue("milestoneId", a.toLong()) }
                assertTrue(fresh.hasKeyValue("startFrom", null) && fresh.hasKeyValue("endFrom", null), "an unscheduled one has no before")

                // A 409, a 400 and a 403 emit no batch event of their own.
                val current = TestPlan.revision()
                assertEquals(HttpStatusCode.Conflict, t.manager.client.batch(t.teamId, current + 1, week1(a)).status)
                assertEquals(HttpStatusCode.BadRequest, t.manager.client.batch(t.teamId, -1, week1(a)).status)
                assertEquals(forbidden, w.projectOwner.client.batch(t.teamId, current, week1(a)).status)
                val owner = w.projectOwner.userId.toLong()
                assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", owner) })
                assertEquals(1, capture.events.count { it.message == "team.schedule_batch_applied" && it.hasKeyValue("teamId", teamId) })
            }
        }

    @Test
    fun `a manager cleared from the team while the batch was held is refused - 403, no write, no bump`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsbheld1", teams = true)
        val t = w.requireTeams()
        val (a) = w.milestones(t.teamId, 1)
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { t.manager.client.batch(t.teamId, revision, item(a, "2027-02-01", "2027-02-05")) },
            { it.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", t.teamId.toInt()) },
        )
        assertEquals(forbidden, response.status, "the guard is re-run under the lock against the team as it is then")
        assertEquals(revision, TestPlan.revision())
        assertEquals(null to null, datesOf(a))
    }

    @Test
    fun `a team deleted while the batch was held is 404, even for ADMIN - no write, no bump`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsbheld2", teams = true)
        val t = w.requireTeams()
        val (a) = w.milestones(t.teamId, 1)
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { w.admin.client.batch(t.teamId, revision, item(a, "2027-02-01", "2027-02-05")) },
            { it.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", t.teamId.toInt()) },
        )
        assertEquals(HttpStatusCode.NotFound, response.status, "the team is re-read (and locked) under the plan lock")
        assertEquals(revision, TestPlan.revision())
        assertEquals(null to null, datesOf(a))
    }

    @Test
    fun `a milestone deleted by a write that held the lock first is skipped GONE, not a failure`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tsbheld3", teams = true)
        val t = w.requireTeams()
        val (a, b) = w.milestones(t.teamId, 2)
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { t.manager.client.batch(t.teamId, revision, item(a, "2027-02-01", "2027-02-05"), item(b, "2027-02-08", "2027-02-09")) },
            { it.exec("UPDATE milestones SET marked_as_deleted = TRUE WHERE id = ?", a.toInt()) },
        )
        assertEquals(ok, response.status)
        assertEquals(listOf(b), response.result().accepted)
        assertEquals(listOf(SkippedSchedule(a, GONE)), response.result().skipped)
        assertNull(datesOf(a).first)
    }
}
