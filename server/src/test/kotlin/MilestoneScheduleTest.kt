package ch.nokillswit

import ch.nokillswit.planning.MilestoneResponse
import ch.nokillswit.planning.MilestoneScheduleRequest
import ch.nokillswit.planning.ScheduleResponse
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
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `PUT /milestones/{id}/schedule` (V14): the dates belong to the milestone's TEAM manager or ADMIN and to nobody else — above all not the
 * project's owner — with read-before-guard ordering, the both-or-neither / order / working-day rules, per-milestone optimistic concurrency
 * on the plan revision, and the guard re-run under the plan lock against the stored team (a manager revoked or a team changed while the
 * request was held open is a 403, never a write). 2026-11-02 is a Monday, 2026-11-07/08 the weekend.
 */
class MilestoneScheduleTest {
    private val forbidden = HttpStatusCode.Forbidden

    private fun schedule(path: String) = "$path/schedule"

    private suspend fun HttpClient.put(path: String, expected: Long, start: String?, end: String?): HttpResponse =
        putJson(schedule(path), MilestoneScheduleRequest(expected, start, end))

    private suspend fun HttpClient.rawPut(path: String, body: String): HttpResponse = put(path) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpClient.read(path: String): MilestoneResponse = get(path).body()

    private suspend fun HttpResponse.problem(): ProblemDetail = body()

    @Test
    fun `the team's manager schedules the milestone, the bar reads back and the answer carries the new plan revision`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("sch", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val path = "/api/v1/milestones/$id"
        assertNull(t.manager.client.read(path).startDate)
        val response = t.manager.client.put(path, TestPlan.revision(), "2026-11-02", "2026-11-13")
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(TestPlan.revision(), response.body<ScheduleResponse>().revision)
        val stored = w.stranger.client.read(path)
        assertEquals("2026-11-02", stored.startDate)
        assertEquals("2026-11-13", stored.endDate)
        assertEquals("2026-11-02", TestPlan.scalar("SELECT start_date::text FROM milestones WHERE id = $id") { it.getString(1) })
    }

    @Test
    fun `the project owner cannot schedule - dates belong to the team's manager, whatever the caller owns`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("own", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val path = "/api/v1/milestones/$id"
        val before = TestPlan.revision()
        val denied = listOf(
            "project owner" to w.projectOwner, "program owner" to w.programOwner, "stream owner" to w.streamOwner,
            "stranger" to w.stranger, "personless" to w.personless, "roadmap editor" to w.editor,
            "the other team's manager" to t.otherManager,
        )
        for ((label, caller) in denied) {
            assertEquals(forbidden, caller.client.put(path, before, "2026-11-02", "2026-11-06").status, label)
        }
        assertEquals(before, TestPlan.revision(), "no refused write bumped the revision")
        assertNull(w.admin.client.read(path).startDate, "nothing was written")
    }

    @Test
    fun `ADMIN schedules any milestone and a manager of two teams' milestones is limited to their own`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("adm", teams = true)
        val t = w.requireTeams()
        val mine = TestPlan.milestone(w.projectId, t.teamId)
        val theirs = TestPlan.milestone(w.projectId, t.otherTeamId)
        assertEquals(HttpStatusCode.OK, w.admin.client.put("/api/v1/milestones/$mine", TestPlan.revision(), "2026-11-02",
            "2026-11-06").status)
        assertEquals(HttpStatusCode.OK, w.admin.client.put("/api/v1/milestones/$theirs", TestPlan.revision(), "2026-11-09",
            "2026-11-13").status)
        assertEquals(HttpStatusCode.OK, t.manager.client.put("/api/v1/milestones/$mine", TestPlan.revision(), "2026-11-03",
            "2026-11-04").status)
        assertEquals(forbidden, t.manager.client.put("/api/v1/milestones/$theirs", TestPlan.revision(), "2026-11-03", "2026-11-04").status)
        assertEquals("2026-11-09", w.admin.client.read("/api/v1/milestones/$theirs").startDate)
    }

    @Test
    fun `an unknown or deleted milestone is 404 for every caller before the guard, and a forbidden caller's malformed body stays 403`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("404", teams = true)
            val t = w.requireTeams()
            val id = TestPlan.milestone(w.projectId, t.teamId)
            val gone = TestPlan.milestone(w.projectId, t.teamId)
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$gone").status)
            for ((label, caller) in listOf("stranger" to w.stranger, "project owner" to w.projectOwner, "manager" to t.manager,
                "admin" to w.admin)) {
                assertEquals(HttpStatusCode.NotFound, caller.client.put("/api/v1/milestones/999999", 0, null, null).status,
                    "unknown: $label")
                assertEquals(HttpStatusCode.NotFound, caller.client.put("/api/v1/milestones/$gone", TestPlan.revision(), null,
                    null).status, "deleted: $label")
            }
            assertEquals(forbidden, w.projectOwner.client.rawPut(schedule("/api/v1/milestones/$id"), "{ not json").status)
            assertEquals(forbidden, w.stranger.client.rawPut(schedule("/api/v1/milestones/$id"), "{}").status)
            // A deleted project hides its milestones (they are cascaded).
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/${w.projectId}").status)
            assertEquals(HttpStatusCode.NotFound, t.manager.client.put("/api/v1/milestones/$id", TestPlan.revision(), null, null).status)
        }

    @Test
    fun `the null pair unschedules and a milestone can be scheduled again`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("uns", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val path = "/api/v1/milestones/$id"
        TestPlan.schedule(id, "2026-11-02", "2026-11-06")
        assertEquals(HttpStatusCode.OK, t.manager.client.put(path, TestPlan.revision(), null, null).status)
        val unscheduled = w.admin.client.read(path)
        assertNull(unscheduled.startDate)
        assertNull(unscheduled.endDate)
        assertEquals(forbidden, w.projectOwner.client.put(path, TestPlan.revision(), null, null).status, "unscheduling is the same guard")
        assertEquals(HttpStatusCode.OK, t.manager.client.put(path, TestPlan.revision(), "2026-11-09", "2026-11-09").status)
        assertEquals("2026-11-09", w.admin.client.read(path).endDate, "a one-day milestone has start == end")
    }

    @Test
    fun `invalid schedules are 400 and write nothing - one date only, shape, order, a span with no working day`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("bad", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val path = "/api/v1/milestones/$id"
        val before = TestPlan.revision()
        val invalid = listOf(
            Triple("start only", "2026-11-02", null),
            Triple("end only", null, "2026-11-06"),
            Triple("not a date", "tomorrow", "2026-11-06"),
            Triple("not a calendar day", "2026-02-30", "2026-03-02"),
            Triple("a timestamp", "2026-11-02T00:00:00Z", "2026-11-06"),
            Triple("year out of range", "1800-01-01", "1800-01-05"),
            Triple("end before start", "2026-11-06", "2026-11-02"),
            Triple("a Saturday", "2026-11-07", "2026-11-07"),
            Triple("a weekend", "2026-11-07", "2026-11-08"),
        )
        for ((label, start, end) in invalid) {
            val response = t.manager.client.put(path, before, start, end)
            assertEquals(HttpStatusCode.BadRequest, response.status, label)
        }
        assertEquals(
            "A milestone must cover at least one working day",
            t.manager.client.put(path, before, "2026-11-07", "2026-11-08").problem().detail,
        )
        assertEquals(before, TestPlan.revision(), "no rejected write moved the revision")
        assertNull(w.admin.client.read(path).startDate)
        // A weekend-bounded span is fine as long as it holds a working day; Friday alone is a working day.
        assertEquals(HttpStatusCode.OK, t.manager.client.put(path, before, "2026-11-07", "2026-11-09").status)
        assertEquals(HttpStatusCode.OK, t.manager.client.put(path, TestPlan.revision(), "2026-11-06", "2026-11-06").status)
        assertEquals(HttpStatusCode.OK, t.manager.client.put(path, TestPlan.revision(), "2026-11-06", "2026-11-22").status)
    }

    @Test
    fun `a stale expectedRevision is 409 with the stale-revision problem type, nothing written and no bump`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("stale", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val path = "/api/v1/milestones/$id"
        val viewRevision = TestPlan.revision()
        // Someone else schedules the milestone after the client read its view.
        TestPlan.schedule(id, "2026-11-09", "2026-11-13")
        val after = TestPlan.revision()
        val response = t.manager.client.put(path, viewRevision, "2026-11-02", "2026-11-06")
        assertEquals(HttpStatusCode.Conflict, response.status)
        assertEquals("urn:astrolabe:problem:stale-revision", response.problem().type)
        assertEquals(after, TestPlan.revision(), "the rejected write rolled back")
        assertEquals("2026-11-09", w.admin.client.read(path).startDate, "nothing was written")
        // Reloading (the current revision) lets the same change through.
        assertEquals(HttpStatusCode.OK, t.manager.client.put(path, after, "2026-11-02", "2026-11-06").status)
    }

    @Test
    fun `concurrency is per milestone - unrelated plan writes never stale a drag, a second write on the same milestone does`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("per", teams = true)
            val t = w.requireTeams()
            val a = TestPlan.milestone(w.projectId, t.teamId)
            val b = TestPlan.milestone(w.projectId, t.teamId)
            val viewRevision = TestPlan.revision()
            TestPlan.schedule(a, "2026-11-02", "2026-11-06")
            repeat(5) { TestPlan.project(w.programId, w.projectOwner.personId!!) }
            assertTrue(TestPlan.revision() >= viewRevision + 6)
            // B was not touched since the view: it accepts the old revision although the plan moved on by six writes.
            val onB = t.manager.client.put("/api/v1/milestones/$b", viewRevision, "2026-11-09", "2026-11-13")
            assertEquals(HttpStatusCode.OK, onB.status)
            val adopted = onB.body<ScheduleResponse>().revision
            // A moved after the view: its old revision is stale ...
            assertEquals(HttpStatusCode.Conflict, t.manager.client.put("/api/v1/milestones/$a", viewRevision, "2026-11-16",
                "2026-11-20").status)
            // ... and so is B's own old revision now that B moved.
            assertEquals(HttpStatusCode.Conflict, t.manager.client.put("/api/v1/milestones/$b", viewRevision, "2026-11-16",
                "2026-11-20").status)
            // The revision the PUT answered is the next drag's expectation, for either milestone.
            assertEquals(HttpStatusCode.OK, t.manager.client.put("/api/v1/milestones/$b", adopted, "2026-11-16", "2026-11-20").status)
            assertEquals(HttpStatusCode.OK, t.manager.client.put("/api/v1/milestones/$a", adopted, "2026-11-16", "2026-11-20").status)
        }

    @Test
    fun `a plan-field edit or a team change does not stale a client's schedule revision`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fields", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val path = "/api/v1/milestones/$id"
        val viewRevision = TestPlan.revision()
        val name = w.admin.client.read(path).name
        val edit = ch.nokillswit.planning.MilestoneUpdateRequest(name, "renamed elsewhere", t.otherTeamId, 9.0)
        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.putJson(path, edit).status)
        assertEquals(HttpStatusCode.OK, t.otherManager.client.put(path, viewRevision, "2026-11-02", "2026-11-06").status,
            "only the schedule is versioned")
    }

    @Test
    fun `a no-op schedule PUT bumps the revision and audits nothing, a real one audits the stored before and after`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("aud", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val path = "/api/v1/milestones/$id"
        withAuditCapture { capture ->
            val first = t.manager.client.put(path, TestPlan.revision(), "2026-11-02", "2026-11-06")
            assertEquals(HttpStatusCode.OK, first.status)
            val scheduled = capture.awaitEvent { it.message == "milestone.scheduled" && it.hasKeyValue("milestoneId", id.toLong()) }
            assertNotNull(scheduled)
            assertTrue(scheduled.hasKeyValue("byUserId", t.manager.userId.toLong()))
            assertTrue(scheduled.hasKeyValue("teamId", t.teamId.toLong()))
            assertTrue(scheduled.hasKeyValue("startFrom", null))
            assertTrue(scheduled.hasKeyValue("endFrom", null))
            assertTrue(scheduled.hasKeyValue("startTo", "2026-11-02"))
            assertTrue(scheduled.hasKeyValue("endTo", "2026-11-06"))
            assertTrue(scheduled.hasKeyValue("revisionTo", first.body<ScheduleResponse>().revision))

            val revision = TestPlan.revision()
            assertEquals(HttpStatusCode.OK, t.manager.client.put(path, revision, "2026-11-02", "2026-11-06").status)
            assertEquals(revision + 1, TestPlan.revision(), "a no-op PUT still bumps (the conservative rule)")
            assertEquals(1, capture.events.count { it.message == "milestone.scheduled" && it.hasKeyValue("milestoneId", id.toLong()) })

            assertEquals(HttpStatusCode.OK, w.admin.client.put(path, TestPlan.revision(), null, null).status)
            val cleared = capture.awaitEvent {
                it.message == "milestone.scheduled" && it.hasKeyValue("milestoneId", id.toLong()) && it.hasKeyValue("startTo", null)
            }
            assertNotNull(cleared)
            assertTrue(cleared.hasKeyValue("startFrom", "2026-11-02"))
            assertTrue(cleared.hasKeyValue("endFrom", "2026-11-06"))

            // Rejected writes (403, 400, 409) emit no schedule event of their own.
            val count = capture.events.count { it.message == "milestone.scheduled" }
            w.projectOwner.client.put(path, TestPlan.revision(), "2026-11-02", "2026-11-06")
            t.manager.client.put(path, TestPlan.revision(), "2026-11-07", "2026-11-08")
            t.manager.client.put(path, 0, "2026-11-02", "2026-11-06")
            assertEquals(count, capture.events.count { it.message == "milestone.scheduled" })
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", w.projectOwner.userId.toLong()) })
        }
    }

    @Test
    fun `a manager cleared from the team while the request was held is refused - 403, no write, no bump`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("held1", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { t.manager.client.put("/api/v1/milestones/$id", revision, "2026-11-02", "2026-11-06") },
            { it.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", t.teamId.toInt()) },
        )
        assertEquals(forbidden, response.status)
        assertEquals(revision, TestPlan.revision())
        assertNull(w.admin.client.read("/api/v1/milestones/$id").startDate)
    }

    @Test
    fun `a milestone moved to another team while the request was held is refused against its STORED team`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("held2", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val revision = TestPlan.revision()
        val response = requestHeldAtPlanLock(
            { t.manager.client.put("/api/v1/milestones/$id", revision, "2026-11-02", "2026-11-06") },
            { it.exec("UPDATE milestones SET team_id = ? WHERE id = ?", t.otherTeamId.toInt(), id.toInt()) },
        )
        assertEquals(forbidden, response.status, "the guard checks the team re-read under the lock, never an earlier read")
        assertEquals(revision, TestPlan.revision())
        assertNull(w.admin.client.read("/api/v1/milestones/$id").startDate)
    }

    @Test
    fun `re-linking the manager's person while the request was held revokes the right, and a milestone deleted meanwhile is 404`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("held3", teams = true)
            val t = w.requireTeams()
            val id = TestPlan.milestone(w.projectId, t.teamId)
            val replacement = TestUsers.seed(email = uniqueEmail("held3-new"), password = "pw", role = ch.nokillswit.users.UserRole.USER)
            val revision = TestPlan.revision()
            val relinked = requestHeldAtPlanLock(
                { t.manager.client.put("/api/v1/milestones/$id", revision, "2026-11-02", "2026-11-06") },
                { it.exec("UPDATE people SET user_id = ? WHERE id = ?", replacement.toInt(), t.manager.personId!!.toInt()) },
            )
            assertEquals(forbidden, relinked.status)
            val deleted = requestHeldAtPlanLock(
                { w.admin.client.put("/api/v1/milestones/$id", TestPlan.revision(), "2026-11-02", "2026-11-06") },
                { it.exec("UPDATE milestones SET marked_as_deleted = TRUE WHERE id = ?", id.toInt()) },
            )
            assertEquals(HttpStatusCode.NotFound, deleted.status, "the chain is re-read under the lock")
        }

    @Test
    fun `the schedule waits for a concurrent manager change on the team row, then answers 403`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("lockwait", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val revision = TestPlan.revision()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // What TeamService.update holds while it replaces the manager.
            raw.prepareStatement("SELECT id FROM teams WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, t.teamId.toInt())
                st.executeQuery().close()
            }
            try {
                coroutineScope {
                    val scheduling = async { t.manager.client.put("/api/v1/milestones/$id", revision, "2026-11-02", "2026-11-06") }
                    awaitLockWait("FOR SHARE")
                    raw.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", t.teamId.toInt())
                    raw.commit()
                    assertEquals(forbidden, scheduling.await().status,
                        "the manager lookup locks the team FOR SHARE: it saw the committed change")
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(revision, TestPlan.revision())
    }

    @Test
    fun `an expectedRevision above the current plan revision is 409 and cannot overwrite a reschedule, a negative one is 400`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("future", teams = true)
            val t = w.requireTeams()
            val id = TestPlan.milestone(w.projectId, t.teamId)
            val path = "/api/v1/milestones/$id"
            TestPlan.schedule(id, "2026-11-09", "2026-11-13")
            val current = TestPlan.revision()
            for (future in listOf(current + 1, current + 1000, Long.MAX_VALUE)) {
                val response = t.manager.client.put(path, future, "2026-11-02", "2026-11-06")
                assertEquals(HttpStatusCode.Conflict, response.status, "expectedRevision $future")
                assertEquals("urn:astrolabe:problem:stale-revision", response.problem().type)
            }
            assertEquals(current, TestPlan.revision(), "the rejected writes rolled back")
            assertEquals("2026-11-09", w.admin.client.read(path).startDate, "nothing was overwritten")
            val atCurrent = t.manager.client.put(path, current, "2026-11-02", "2026-11-06")
            assertEquals(HttpStatusCode.OK, atCurrent.status, "the current revision is fine")
            for (negative in listOf(-1L, Long.MIN_VALUE)) {
                val response = t.manager.client.put(path, negative, "2026-11-02", "2026-11-06")
                assertEquals(HttpStatusCode.BadRequest, response.status, "$negative")
            }
            assertEquals(forbidden, w.projectOwner.client.put(path, -1, null, null).status, "403 still wins over the 400")
        }

    @Test
    fun `the manager lookup does not lock the user row - a held FOR UPDATE on the manager's user never delays a drag`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("userlock", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val revision = TestPlan.revision()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // What PasswordResetService.lockUser / the users writers hold on the manager's login.
            raw.prepareStatement("SELECT id FROM users WHERE id = ? FOR UPDATE").use { st ->
                st.setLong(1, t.manager.userId.toLong())
                st.executeQuery().close()
            }
            try {
                val response = withTimeout(15_000) { t.manager.client.put("/api/v1/milestones/$id", revision, "2026-11-02", "2026-11-06") }
                assertEquals(HttpStatusCode.OK, response.status, "FOR SHARE OF teams, people never queues behind a users-row lock")
            } finally {
                raw.rollback()
            }
        }
        assertEquals("2026-11-02", w.admin.client.read("/api/v1/milestones/$id").startDate)
    }

    @Test
    fun `the schedule waits for a concurrent re-link of the manager's person row, then answers 403`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("personlock", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.milestone(w.projectId, t.teamId)
        val replacement = TestUsers.seed(email = uniqueEmail("personlock-new"), password = "pw", role = ch.nokillswit.users.UserRole.USER)
        val revision = TestPlan.revision()
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // What PersonService.update holds while it re-links the person.
            raw.prepareStatement("SELECT id FROM people WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, t.manager.personId!!.toInt())
                st.executeQuery().close()
            }
            try {
                coroutineScope {
                    val scheduling = async { t.manager.client.put("/api/v1/milestones/$id", revision, "2026-11-02", "2026-11-06") }
                    awaitLockWait("FOR SHARE")
                    raw.exec("UPDATE people SET user_id = ? WHERE id = ?", replacement.toInt(), t.manager.personId!!.toInt())
                    raw.commit()
                    assertEquals(forbidden, scheduling.await().status, "the manager lookup locks the person FOR SHARE: it saw the re-link")
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(revision, TestPlan.revision())
    }
}
