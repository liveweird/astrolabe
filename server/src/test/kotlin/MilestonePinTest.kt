package ch.nokillswit

import ch.nokillswit.planning.MILESTONE_UNSCHEDULED_PROBLEM
import ch.nokillswit.planning.MilestonePageResponse
import ch.nokillswit.planning.MilestonePinRequest
import ch.nokillswit.planning.MilestoneResponse
import ch.nokillswit.planning.MilestoneScheduleRequest
import ch.nokillswit.planning.MilestoneSpan
import ch.nokillswit.planning.MilestoneUpdateRequest
import ch.nokillswit.planning.ProjectView
import ch.nokillswit.planning.ScheduleResponse
import ch.nokillswit.planning.TeamScheduleBatchItem
import ch.nokillswit.planning.TeamScheduleBatchRequest
import ch.nokillswit.planning.TeamScheduleBatchResponse
import ch.nokillswit.planning.TeamView
import ch.nokillswit.planning.ValidatedBatchItem
import ch.nokillswit.planning.withPlanWrite
import ch.nokillswit.plugins.ProblemDetail
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import java.sql.SQLException
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * `PUT /milestones/{id}/pin` (V25): the pin is the schedule write's audience (the milestone's team manager or ADMIN, never the project's
 * owner) with the schedule PUT's order (404, 403, then the body) and the guard re-run under the plan lock. A pin needs dates (409
 * `milestone-unscheduled`), is idempotent, takes no `expectedRevision` and never touches `schedule_revision`. Every writer of the dates
 * that can unschedule clears it in the same statement (the single PUT, the batch accept, the import's shared `writeSchedules`); a
 * reschedule keeps it; `ck_milestones_pinned_scheduled` backs the rule at the database. 2026-11-02 is a Monday.
 */
class MilestonePinTest {
    private val ok = HttpStatusCode.OK
    private val forbidden = HttpStatusCode.Forbidden

    private suspend fun HttpClient.pin(path: String, pinned: Boolean): HttpResponse = putJson("$path/pin", MilestonePinRequest(pinned))

    private suspend fun HttpClient.rawPin(path: String, body: String): HttpResponse = put("$path/pin") {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpClient.schedule(path: String, expected: Long, start: String?, end: String?): HttpResponse =
        putJson("$path/schedule", MilestoneScheduleRequest(expected, start, end))

    private suspend fun HttpClient.read(path: String): MilestoneResponse = get(path).body()

    private fun pinnedOf(id: UInt): Boolean = TestPlan.scalar("SELECT pinned FROM milestones WHERE id = $id") { it.getBoolean(1) }

    private fun scheduleRevisionOf(id: UInt): Long =
        TestPlan.scalar("SELECT schedule_revision FROM milestones WHERE id = $id") { it.getLong(1) }

    private fun datesOf(id: UInt): Pair<String?, String?> =
        TestPlan.scalar("SELECT start_date::text, end_date::text FROM milestones WHERE id = $id") { it.getString(1) to it.getString(2) }

    private suspend fun scheduledPinned(w: PlanWorld, teamId: UInt, name: String = planName("pn")): UInt {
        val id = TestPlan.milestone(w.projectId, teamId, name)
        TestPlan.schedule(id, "2026-11-02", "2026-11-06")
        TestPlan.pin(id)
        return id
    }

    @Test
    fun `the team's manager and ADMIN pin and unpin, the answer is the new plan revision and schedule_revision is untouched`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pin", teams = true)
            val t = w.requireTeams()
            val id = TestPlan.milestone(w.projectId, t.teamId)
            TestPlan.schedule(id, "2026-11-02", "2026-11-06")
            val path = "/api/v1/milestones/$id"
            val stamp = scheduleRevisionOf(id)
            assertFalse(w.stranger.client.read(path).pinned)

            val before = TestPlan.revision()
            val pinned = t.manager.client.pin(path, true)
            assertEquals(ok, pinned.status)
            assertEquals(before + 1, pinned.body<ScheduleResponse>().revision)
            assertEquals(before + 1, TestPlan.revision(), "a pin is a plan write: one bump")
            assertTrue(w.stranger.client.read(path).pinned)
            assertEquals(stamp, scheduleRevisionOf(id), "the pin is not the dates: schedule_revision is untouched")
            assertEquals("2026-11-02" to "2026-11-06", datesOf(id))

            assertEquals(ok, w.admin.client.pin(path, false).status)
            assertFalse(w.stranger.client.read(path).pinned)
            assertEquals(ok, w.admin.client.pin(path, true).status)
            assertEquals(ok, t.manager.client.pin(path, false).status)
            assertFalse(pinnedOf(id))
        }

    @Test
    fun `the pin rides the single read, the picker list and both views`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rides", teams = true)
        val t = w.requireTeams()
        val kept = scheduledPinned(w, t.teamId)
        val free = TestPlan.milestone(w.projectId, t.teamId)
        TestPlan.schedule(free, "2026-11-09", "2026-11-13")
        val loose = TestPlan.milestone(w.projectId, t.teamId)

        assertTrue(w.stranger.client.read("/api/v1/milestones/$kept").pinned)
        assertFalse(w.stranger.client.read("/api/v1/milestones/$free").pinned)
        val list = w.stranger.client.get("/api/v1/milestones?pageSize=100&sort=-id").body<MilestonePageResponse>()
        assertEquals(listOf(false, false, true), listOf(loose, free, kept).map { id -> list.items.single { it.id == id }.pinned })

        val project = w.stranger.client.get("/api/v1/views/project/${w.projectId}").body<ProjectView>()
        assertEquals(setOf(kept), (project.scheduled + project.unscheduled).filter { it.pinned }.map { it.id }.toSet())
        val team = w.stranger.client.get("/api/v1/views/team/${t.teamId}").body<TeamView>()
        assertEquals(setOf(kept), (team.scheduled + team.unscheduled).filter { it.pinned }.map { it.id }.toSet())
        assertTrue(team.scheduled.single { it.id == kept }.pinned)
        assertTrue(team.unscheduled.none { it.pinned }, "an unscheduled milestone is never pinned")
    }

    @Test
    fun `the project owner and every other caller get 403 whatever they own, and a refused pin writes and bumps nothing`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("deny", teams = true)
            val t = w.requireTeams()
            val id = TestPlan.milestone(w.projectId, t.teamId)
            TestPlan.schedule(id, "2026-11-02", "2026-11-06")
            val path = "/api/v1/milestones/$id"
            val before = TestPlan.revision()
            val denied = listOf(
                "project owner" to w.projectOwner, "program owner" to w.programOwner, "stream owner" to w.streamOwner,
                "stranger" to w.stranger, "personless" to w.personless, "roadmap editor" to w.editor,
                "the other team's manager" to t.otherManager,
            )
            for ((label, caller) in denied) assertEquals(forbidden, caller.client.pin(path, true).status, label)
            assertEquals(before, TestPlan.revision(), "no refused write bumped the revision")
            assertFalse(pinnedOf(id))
            // The other team's manager pins THEIR milestones only; ADMIN pins any.
            val theirs = TestPlan.milestone(w.projectId, t.otherTeamId)
            TestPlan.schedule(theirs, "2026-11-09", "2026-11-13")
            assertEquals(ok, t.otherManager.client.pin("/api/v1/milestones/$theirs", true).status)
            assertEquals(forbidden, t.manager.client.pin("/api/v1/milestones/$theirs", false).status)
            assertTrue(pinnedOf(theirs))
        }

    @Test
    fun `404 comes first for every caller, a forbidden caller's malformed body stays 403, the manager's is 400`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("order", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        TestPlan.schedule(id, "2026-11-02", "2026-11-06")
        val gone = TestPlan.milestone(w.projectId, t.teamId)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$gone").status)
        val callers = listOf("stranger" to w.stranger, "project owner" to w.projectOwner, "manager" to t.manager, "admin" to w.admin)
        for ((label, caller) in callers) {
            assertEquals(HttpStatusCode.NotFound, caller.client.pin("/api/v1/milestones/999999", true).status, "unknown: $label")
            assertEquals(HttpStatusCode.NotFound, caller.client.pin("/api/v1/milestones/$gone", true).status, "deleted: $label")
        }
        val path = "/api/v1/milestones/$id"
        assertEquals(forbidden, w.projectOwner.client.rawPin(path, "{ not json").status)
        assertEquals(forbidden, w.stranger.client.rawPin(path, "{}").status)
        assertEquals(forbidden, t.otherManager.client.rawPin(path, """{"pinned":"yes"}""").status)
        assertEquals(HttpStatusCode.BadRequest, t.manager.client.rawPin(path, "{ not json").status)
        assertEquals(HttpStatusCode.BadRequest, t.manager.client.rawPin(path, "{}").status, "the member is required")
        assertEquals(HttpStatusCode.BadRequest, w.admin.client.rawPin(path, """{"pinned":"yes"}""").status)
        assertFalse(pinnedOf(id))
        // A deleted project hides its milestones.
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/${w.projectId}").status)
        assertEquals(HttpStatusCode.NotFound, t.manager.client.pin(path, true).status)
    }

    @Test
    fun `pinning an unscheduled milestone is the typed 409 and writes nothing, unpinning one is a harmless no-op`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("unsch", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val path = "/api/v1/milestones/$id"
        val before = TestPlan.revision()
        for ((label, caller) in listOf("manager" to t.manager, "admin" to w.admin)) {
            val response = caller.client.pin(path, true)
            assertEquals(HttpStatusCode.Conflict, response.status, label)
            assertEquals(MILESTONE_UNSCHEDULED_PROBLEM, response.body<ProblemDetail>().type)
        }
        assertEquals(before, TestPlan.revision(), "the refusal rolled back, no bump")
        assertFalse(pinnedOf(id))
        assertEquals(forbidden, w.projectOwner.client.pin(path, true).status, "the guard outranks the 409")
        assertEquals(ok, t.manager.client.pin(path, false).status)
        assertEquals(before + 1, TestPlan.revision(), "a no-op still bumps (the conservative rule)")
    }

    @Test
    fun `a no-op pin bumps and audits nothing, a change audits one line, an unpin names its reason, a refusal audits nothing`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("aud", teams = true)
            val t = w.requireTeams()
            val id = TestPlan.milestone(w.projectId, t.teamId)
            TestPlan.schedule(id, "2026-11-02", "2026-11-06")
            val path = "/api/v1/milestones/$id"
            withAuditCapture { capture ->
                val first = t.manager.client.pin(path, true)
                val pinned = capture.awaitEvent { it.message == "milestone.pinned" && it.hasKeyValue("milestoneId", id.toLong()) }
                assertNotNull(pinned)
                assertTrue(pinned.hasKeyValue("byUserId", t.manager.userId.toLong()))
                assertTrue(pinned.hasKeyValue("teamId", t.teamId.toLong()))
                assertTrue(pinned.hasKeyValue("revisionTo", first.body<ScheduleResponse>().revision))

                val revision = TestPlan.revision()
                assertEquals(ok, t.manager.client.pin(path, true).status)
                assertEquals(revision + 1, TestPlan.revision(), "an idempotent repeat still bumps")
                assertEquals(1, capture.events.count { it.message == "milestone.pinned" && it.hasKeyValue("milestoneId", id.toLong()) })

                val unpin = w.admin.client.pin(path, false)
                val unpinned = capture.awaitEvent { it.message == "milestone.unpinned" && it.hasKeyValue("milestoneId", id.toLong()) }
                assertNotNull(unpinned)
                assertTrue(unpinned.hasKeyValue("byUserId", w.admin.userId.toLong()))
                assertTrue(unpinned.hasKeyValue("teamId", t.teamId.toLong()))
                assertTrue(unpinned.hasKeyValue("reason", "REQUESTED"))
                assertTrue(unpinned.hasKeyValue("revisionTo", unpin.body<ScheduleResponse>().revision))
                assertEquals(ok, w.admin.client.pin(path, false).status)
                assertEquals(1, capture.events.count { it.message == "milestone.unpinned" && it.hasKeyValue("milestoneId", id.toLong()) })

                // Refusals (403 central, 409, 400) emit no pin event of their own.
                val count = capture.events.count { it.message.startsWith("milestone.") && it.hasKeyValue("milestoneId", id.toLong()) }
                w.projectOwner.client.pin(path, true)
                t.manager.client.rawPin(path, "{}")
                val free = TestPlan.milestone(w.projectId, t.teamId)
                t.manager.client.pin("/api/v1/milestones/$free", true)
                val after = capture.events.count { it.message.startsWith("milestone.") && it.hasKeyValue("milestoneId", id.toLong()) }
                assertEquals(count, after)
                assertTrue(capture.events.none { it.message == "milestone.pinned" && it.hasKeyValue("milestoneId", free.toLong()) })
                val ownerId = w.projectOwner.userId.toLong()
                assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", ownerId) })
            }
        }

    @Test
    fun `a pin never stales a drag, and a reschedule keeps the pin`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("keep", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        TestPlan.schedule(id, "2026-11-02", "2026-11-06")
        val path = "/api/v1/milestones/$id"
        val view = TestPlan.revision()
        assertEquals(ok, w.admin.client.pin(path, true).status)
        // The drag carries the revision of a view read BEFORE the pin: schedule_revision did not move, so it passes.
        assertEquals(ok, t.manager.client.schedule(path, view, "2026-11-09", "2026-11-13").status)
        assertTrue(pinnedOf(id), "a reschedule keeps the pin: it is advice to the planner, not a lock")
        assertEquals("2026-11-09" to "2026-11-13", datesOf(id))
        // A batch item with dates keeps it too, a no-op (equal span) item as well.
        val batch = TeamScheduleBatchRequest(TestPlan.revision(), listOf(TeamScheduleBatchItem(id, "2026-11-16", "2026-11-20")))
        val batched = t.manager.client.postJson("/api/v1/teams/${t.teamId}/milestone-schedules", batch)
        assertEquals(listOf(id), batched.body<TeamScheduleBatchResponse>().accepted)
        assertTrue(pinnedOf(id))
        val same = TeamScheduleBatchRequest(TestPlan.revision(), listOf(TeamScheduleBatchItem(id, "2026-11-16", "2026-11-20")))
        t.manager.client.postJson("/api/v1/teams/${t.teamId}/milestone-schedules", same)
        assertTrue(pinnedOf(id))
        // A plan-field edit and a team change keep the dates AND the pin (the new team's manager inherits both).
        val name = w.admin.client.read(path).name
        val edit = MilestoneUpdateRequest(name, null, t.otherTeamId, 3.0)
        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.putJson(path, edit).status)
        assertTrue(pinnedOf(id))
        assertEquals("2026-11-16" to "2026-11-20", datesOf(id))
    }

    @Test
    fun `the single PUT's unschedule clears the pin in the same write and audits it after the dates`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("clr1", teams = true)
        val t = w.requireTeams()
        val id = scheduledPinned(w, t.teamId)
        val path = "/api/v1/milestones/$id"
        withAuditCapture { capture ->
            val response = t.manager.client.schedule(path, TestPlan.revision(), null, null)
            assertEquals(ok, response.status)
            assertEquals(null to null, datesOf(id))
            assertFalse(pinnedOf(id), "an unschedule clears the pin (ck_milestones_pinned_scheduled)")
            assertFalse(w.stranger.client.read(path).pinned)
            val cleared = capture.awaitEvent { it.message == "milestone.unpinned" && it.hasKeyValue("milestoneId", id.toLong()) }
            assertNotNull(cleared)
            assertTrue(cleared.hasKeyValue("byUserId", t.manager.userId.toLong()))
            assertTrue(cleared.hasKeyValue("teamId", t.teamId.toLong()))
            assertTrue(cleared.hasKeyValue("reason", "UNSCHEDULED"))
            assertTrue(cleared.hasKeyValue("revisionTo", response.body<ScheduleResponse>().revision))
            assertNotNull(capture.events.singleOrNull { it.message == "milestone.scheduled" && it.hasKeyValue("milestoneId", id.toLong()) })
            // Scheduling it again does not bring the pin back, and unscheduling an unpinned milestone clears nothing.
            assertEquals(ok, t.manager.client.schedule(path, TestPlan.revision(), "2026-11-09", "2026-11-13").status)
            assertFalse(pinnedOf(id))
            assertEquals(ok, t.manager.client.schedule(path, TestPlan.revision(), null, null).status)
            assertEquals(1, capture.events.count { it.message == "milestone.unpinned" && it.hasKeyValue("milestoneId", id.toLong()) })
        }
    }

    @Test
    fun `the batch accept's unschedule item clears the pin and audits it, a dated item beside it keeps its own`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("clr2", teams = true)
        val t = w.requireTeams()
        val gone = scheduledPinned(w, t.teamId)
        val stays = scheduledPinned(w, t.teamId)
        val plain = TestPlan.milestone(w.projectId, t.teamId)
        TestPlan.schedule(plain, "2026-11-09", "2026-11-13")
        withAuditCapture { capture ->
            val request = TeamScheduleBatchRequest(
                TestPlan.revision(),
                listOf(
                    TeamScheduleBatchItem(gone, null, null),
                    TeamScheduleBatchItem(stays, "2026-11-16", "2026-11-20"),
                    TeamScheduleBatchItem(plain, null, null),
                ),
            )
            val response = t.manager.client.postJson("/api/v1/teams/${t.teamId}/milestone-schedules", request)
            assertEquals(ok, response.status)
            val answered = response.body<TeamScheduleBatchResponse>()
            assertEquals(listOf(gone, stays, plain), answered.accepted)
            assertFalse(pinnedOf(gone))
            assertTrue(pinnedOf(stays))
            assertFalse(pinnedOf(plain))
            assertEquals(null to null, datesOf(gone))
            val cleared = capture.awaitEvent { it.message == "milestone.unpinned" && it.hasKeyValue("milestoneId", gone.toLong()) }
            assertNotNull(cleared)
            assertTrue(cleared.hasKeyValue("byUserId", t.manager.userId.toLong()))
            assertTrue(cleared.hasKeyValue("teamId", t.teamId.toLong()))
            assertTrue(cleared.hasKeyValue("reason", "UNSCHEDULED"))
            assertTrue(cleared.hasKeyValue("revisionTo", answered.revision))
            assertEquals(1, capture.events.count { it.message == "milestone.unpinned" }, "only the pinned item that was unscheduled")
        }
    }

    @Test
    fun `a skipped unschedule item keeps its pin`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("clr3", teams = true)
        val t = w.requireTeams()
        val id = scheduledPinned(w, t.teamId)
        val view = TestPlan.revision()
        // Another login drags the milestone after the view: the batch item is STALE and skipped, so nothing - the pin included - changes.
        assertEquals(ok, w.admin.client.schedule("/api/v1/milestones/$id", view, "2026-11-09", "2026-11-13").status)
        val request = TeamScheduleBatchRequest(view, listOf(TeamScheduleBatchItem(id, null, null)))
        val answered = t.manager.client.postJson("/api/v1/teams/${t.teamId}/milestone-schedules", request).body<TeamScheduleBatchResponse>()
        assertEquals(emptyList(), answered.accepted)
        assertTrue(pinnedOf(id))
        assertEquals("2026-11-09" to "2026-11-13", datesOf(id))
    }

    @Test
    fun `the shared date writer of the import and the batch clears the pin on a null span and keeps it on a dated one`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("clr4", teams = true)
        val t = w.requireTeams()
        val cleared = scheduledPinned(w, t.teamId)
        val kept = scheduledPinned(w, t.teamId)
        val database = sharedDatabaseForTests()
        val span = MilestoneSpan(LocalDate.parse("2026-11-16"), LocalDate.parse("2026-11-20"))
        // `writeSchedules` is what the Jira import's apply and the batch accept both call; the unschedule pair must clear in the statement.
        database.withPlanWrite { revision ->
            ch.nokillswit.planning.writeSchedules(listOf(ValidatedBatchItem(cleared, null), ValidatedBatchItem(kept, span)), revision + 1)
        }
        assertFalse(pinnedOf(cleared))
        assertEquals(null to null, datesOf(cleared))
        assertTrue(pinnedOf(kept))
        assertEquals("2026-11-16" to "2026-11-20", datesOf(kept))
    }

    @Test
    fun `the database refuses a pinned row without dates - the CHECK is the net under every writer`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("chk", teams = true)
        val t = w.requireTeams()
        val pinned = scheduledPinned(w, t.teamId)
        val loose = TestPlan.milestone(w.projectId, t.teamId)
        PostgresTestSupport.connect().use { c ->
            val unscheduling = assertFailsWith<SQLException> {
                c.createStatement().use { it.executeUpdate("UPDATE milestones SET start_date = NULL, end_date = NULL WHERE id = $pinned") }
            }
            assertEquals("23514", unscheduling.sqlState, "ck_milestones_pinned_scheduled")
            val pinning = assertFailsWith<SQLException> {
                c.createStatement().use { it.executeUpdate("UPDATE milestones SET pinned = TRUE WHERE id = $loose") }
            }
            assertEquals("23514", pinning.sqlState)
        }
        assertTrue(pinnedOf(pinned))
        assertFalse(pinnedOf(loose))
    }

    @Test
    fun `a manager cleared while the pin was held at the lock is refused - 403, no write, no bump`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("held1", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        TestPlan.schedule(id, "2026-11-02", "2026-11-06")
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { t.manager.client.pin("/api/v1/milestones/$id", true) },
            { it.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", t.teamId.toInt()) },
        )
        assertEquals(forbidden, response.status)
        assertEquals(revision, TestPlan.revision())
        assertFalse(pinnedOf(id))
    }

    @Test
    fun `a milestone moved to another team or unscheduled while the pin was held is judged by what is stored under the lock`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("held2", teams = true)
            val t = w.requireTeams()
            val moved = TestPlan.milestone(w.projectId, t.teamId)
            TestPlan.schedule(moved, "2026-11-02", "2026-11-06")
            val refused = requestHeldAtPlanLock(
                { t.manager.client.pin("/api/v1/milestones/$moved", true) },
                { it.exec("UPDATE milestones SET team_id = ? WHERE id = ?", t.otherTeamId.toInt(), moved.toInt()) },
            )
            assertEquals(forbidden, refused.status, "the guard checks the STORED team re-read under the lock")
            assertFalse(pinnedOf(moved))

            val dateless = TestPlan.milestone(w.projectId, t.teamId)
            TestPlan.schedule(dateless, "2026-11-09", "2026-11-13")
            val unscheduled = requestHeldAtPlanLock(
                { t.manager.client.pin("/api/v1/milestones/$dateless", true) },
                { it.exec("UPDATE milestones SET start_date = NULL, end_date = NULL WHERE id = ?", dateless.toInt()) },
            )
            assertEquals(HttpStatusCode.Conflict, unscheduled.status, "the dates are re-read under the lock too")
            assertEquals(MILESTONE_UNSCHEDULED_PROBLEM, unscheduled.body<ProblemDetail>().type)
            assertFalse(pinnedOf(dateless))

            val deleted = TestPlan.milestone(w.projectId, t.teamId)
            TestPlan.schedule(deleted, "2026-11-09", "2026-11-13")
            val missing = requestHeldAtPlanLock(
                { w.admin.client.pin("/api/v1/milestones/$deleted", true) },
                { it.exec("UPDATE milestones SET marked_as_deleted = TRUE WHERE id = ?", deleted.toInt()) },
            )
            assertEquals(HttpStatusCode.NotFound, missing.status)
        }
}
