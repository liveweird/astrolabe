package ch.nokillswit

import ch.nokillswit.people.PersonResponse
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.planning.ProjectUpdateRequest
import ch.nokillswit.planning.RankingResponse
import ch.nokillswit.planning.RankingUpdateRequest
import ch.nokillswit.planning.RoadmapView
import ch.nokillswit.planning.STALE_REVISION_PROBLEM
import ch.nokillswit.users.Permission
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
import java.sql.SQLException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The global project rank (V13) end to end: `GET /views/roadmap`, the wholesale `PUT /roadmap/ranking` under the `plan_state` lock
 * (guard-before-read, the grant re-checked under the lock, the 409 stale-revision contract, dense renumbering, the DEFERRABLE
 * position constraint) and the project-delete hook. The ranking is SHARED suite state: every test starts by replacing it with its own
 * list, so assertions on the raw table are exact (a wholesale PUT unranks every other project, which no other test relies on).
 */
class RoadmapRankingTest {
    private val ok = HttpStatusCode.OK
    private val forbidden = HttpStatusCode.Forbidden

    private suspend fun HttpClient.view(): RoadmapView = get("/api/v1/views/roadmap").body()

    /** PUTs [ids] as the whole ranking, at [expected] (default: the current revision). */
    private suspend fun HttpClient.rank(ids: List<UInt>, expected: Long = TestPlan.revision()): HttpResponse =
        putJson("/api/v1/roadmap/ranking", RankingUpdateRequest(expected, ids))

    private suspend fun HttpClient.rawRank(body: String): HttpResponse = put("/api/v1/roadmap/ranking") {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    /** The raw `roadmap_entries` rows as (position, project id), by position. */
    private fun entries(): List<Pair<Int, UInt>> = PostgresTestSupport.connect().use { c ->
        c.createStatement().use { st ->
            st.executeQuery("SELECT position, project_id FROM roadmap_entries ORDER BY position").use { rs ->
                buildList { while (rs.next()) add(rs.getInt(1) to rs.getInt(2).toUInt()) }
            }
        }
    }

    private fun dense(ids: List<UInt>): List<Pair<Int, UInt>> = ids.mapIndexed { index, id -> index + 1 to id }

    private suspend fun PlanWorld.projects(count: Int): List<UInt> = List(count) { TestPlan.project(programId, projectOwner.personId!!) }

    @Test
    fun `only ADMIN and a roadmap editor may rank - everyone else gets 403 before the body is read`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("rk-guard")
            val (a, b) = w.projects(2)
            for ((label, caller) in listOf("admin" to w.admin, "roadmap editor" to w.editor)) {
                val response = caller.client.rank(listOf(a))
                assertEquals(ok, response.status, label)
                assertEquals(TestPlan.revision(), response.body<RankingResponse>().revision, label)
            }
            val revision = TestPlan.revision()
            val callers = listOf(
                "stream owner" to w.streamOwner, "program owner" to w.programOwner, "project owner" to w.projectOwner,
                "stranger" to w.stranger, "person-less login" to w.personless,
            )
            for ((label, caller) in callers) {
                assertEquals(forbidden, caller.client.rank(listOf(a, b)).status, label)
                assertEquals(forbidden, caller.client.rawRank("{ not json").status, "$label: a malformed body stays 403")
            }
            assertEquals(revision, TestPlan.revision(), "a refused PUT never moves the revision")
            assertEquals(dense(listOf(a)), entries(), "nor the ranking")
        }

    @Test
    fun `revoking the grant while the PUT waits for the plan lock refuses the write - 403, revision and ranking unchanged`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("rk-revoke")
            val (a, b) = w.projects(2)
            assertEquals(ok, w.admin.client.rank(listOf(a)).status)
            val revision = TestPlan.revision()
            withAuditCapture { capture ->
                val response = requestHeldAtPlanLock(
                    { w.editor.client.rank(listOf(b, a), revision) },
                    { it.exec("DELETE FROM user_permissions WHERE user_id = ?", w.editor.userId.toInt()) },
                )
                assertEquals(forbidden, response.status, "the outer guard passed on the grant; the re-check under the lock did not")
                val denied = capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("path", "/api/v1/roadmap/ranking") }
                assertNotNull(denied, "the re-guard refusal is audited centrally")
                assertTrue(denied.hasKeyValue("byUserId", w.editor.userId.toLong()))
                assertTrue(capture.events.none { it.message == "roadmap.ranked" && it.hasKeyValue("byUserId", w.editor.userId.toLong()) })
            }
            assertEquals(revision, TestPlan.revision())
            assertEquals(dense(listOf(a)), entries())
        }

    @Test
    fun `a roadmap editor without a person can rank - the grant needs no ownership`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-nopersonrank")
        val (a, b) = w.projects(2)
        val editor = planCaller("rk-nopersoned", withPerson = false)
        TestUsers.service.replacePermissions(editor.userId, setOf(Permission.ROADMAP_EDITOR))
        val view = editor.client.view()
        assertTrue(view.can.editRank)
        val response = editor.client.rank(listOf(b, a), view.revision)
        assertEquals(ok, response.status)
        assertEquals(TestPlan.revision(), response.body<RankingResponse>().revision)
        assertEquals(dense(listOf(b, a)), entries())
    }

    @Test
    fun `a stale expectedRevision is 409 with the stale-revision type and writes nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-stale")
        val admin = w.admin.client
        val (a, b, c) = w.projects(3)
        val first = admin.rank(listOf(a, b)).body<RankingResponse>().revision
        // The revision the first PUT answered is current: chained saves with the returned revision work.
        val second = admin.rank(listOf(b, a), first).body<RankingResponse>().revision
        assertEquals(first + 1, second)

        val rejected = admin.rank(listOf(a, b, c), first)
        assertEquals(HttpStatusCode.Conflict, rejected.status)
        assertEquals(STALE_REVISION_PROBLEM, rejected.body<ProblemDetail>().type)
        assertEquals(second, TestPlan.revision(), "a rejected PUT does not bump")
        assertEquals(dense(listOf(b, a)), entries())

        // Stale is checked before the ids, so a stale list naming an id that is gone is the reload signal, not a 400 (only a RANKED
        // project's delete stales a held view; an unranked one's moves no revision, so ranking it afterwards is a 400).
        assertEquals(HttpStatusCode.Conflict, admin.rank(listOf(999_999u), first).status)
        assertEquals(dense(listOf(b, a)), entries())
        // Stale in both directions: a revision from the future (above the plan's) is refused too, never a slip-past.
        assertEquals(HttpStatusCode.Conflict, admin.rank(listOf(a, b, c), TestPlan.revision() + 1).status)
        assertEquals(HttpStatusCode.Conflict, admin.rank(listOf(a, b, c), Long.MAX_VALUE).status)
        assertEquals(dense(listOf(b, a)), entries())
    }

    private fun rankingRevision(): Long = TestPlan.scalar("SELECT ranking_revision FROM plan_state WHERE id = 1") { it.getLong(1) }

    @Test
    fun `a plan write elsewhere - rename, create, schedule, dependency - does not stale a ranking PUT`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-elsewhere", teams = true)
        val admin = w.admin.client
        val (a, b) = w.projects(2)
        assertEquals(ok, admin.rank(listOf(a, b)).status)
        val held = admin.view().revision
        assertEquals(rankingRevision(), held, "the view answers the ranking's revision")

        val teamId = w.requireTeams().teamId
        val source = TestPlan.milestone(a, teamId)
        val target = TestPlan.milestone(b, teamId)
        TestPlan.schedule(source, "2027-03-01", "2027-03-05")
        TestPlan.dependency(milestoneRef(source), milestoneRef(target))
        w.projects(1)
        assertEquals(
            HttpStatusCode.NoContent,
            admin.putJson("/api/v1/projects/$b", ProjectUpdateRequest(planName("renamed"), null, w.projectOwner.personId!!)).status,
        )
        assertTrue(TestPlan.revision() >= held + 6, "six plan writes moved the plan revision")
        assertEquals(held, rankingRevision(), "none of them touched the ranking's")
        assertEquals(held, admin.view().revision)

        val response = admin.rank(listOf(b, a), held)
        assertEquals(ok, response.status, "the held view is still current for the ranking")
        assertEquals(TestPlan.revision(), response.body<RankingResponse>().revision)
        assertEquals(TestPlan.revision(), rankingRevision(), "stamped with the plan revision the PUT left behind")
        assertEquals(TestPlan.revision(), admin.view().revision)
        assertEquals(dense(listOf(b, a)), entries())
    }

    @Test
    fun `a team-order write does not stale a ranking PUT`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-teamorder", teams = true)
        val t = w.requireTeams()
        val (a, b) = w.projects(2)
        assertEquals(ok, w.admin.client.rank(listOf(a, b)).status)
        val held = w.admin.client.view().revision
        val first = TestPlan.milestone(a, t.teamId)
        val second = TestPlan.milestone(a, t.teamId)
        val before = TestPlan.revision()

        assertEquals(ok, t.manager.client.putTeamOrder(t.teamId, TestPlan.revision(), listOf(second, first)).status)
        assertEquals(before + 1, TestPlan.revision(), "the order write is a plan write")
        assertEquals(held, rankingRevision(), "but it does not touch the ranking's revision")
        assertEquals(held, w.admin.client.view().revision)

        assertEquals(ok, w.admin.client.rank(listOf(b, a), held).status, "the held view is still current for the ranking")
        assertEquals(dense(listOf(b, a)), entries())
    }

    @Test
    fun `a ranking write and the delete of a ranked project stale a held view - an unranked delete does not`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-stales")
        val admin = w.admin.client
        val (a, b, c) = w.projects(3)
        val loose = w.projects(1).single()
        assertEquals(ok, admin.rank(listOf(a, b, c)).status)

        // Another ranking write (even one that keeps the order) moves the ranking's revision.
        var held = admin.view().revision
        assertEquals(ok, w.editor.client.rank(listOf(a, b, c), held).status)
        assertEquals(HttpStatusCode.Conflict, admin.rank(listOf(c, b, a), held).status)
        assertEquals(dense(listOf(a, b, c)), entries())

        // A delete that compacts the rank stamps it with the revision the delete left behind; the unranked delete leaves it alone.
        held = admin.view().revision
        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$loose").status)
        assertEquals(held, rankingRevision(), "an unranked project's delete does not change the ranking")
        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$b").status)
        assertEquals(TestPlan.revision(), rankingRevision(), "the compaction is stamped with the delete's plan revision")
        assertEquals(HttpStatusCode.Conflict, admin.rank(listOf(c, a), held).status, "a view held across the compaction is stale")
        assertEquals(dense(listOf(a, c)), entries())

        // The reloaded view is current again.
        val fresh = admin.view()
        assertEquals(dense(listOf(a, c)), fresh.ranked.map { it.position to it.project.id })
        assertEquals(ok, admin.rank(listOf(c, a), fresh.revision).status)
        assertEquals(dense(listOf(c, a)), entries())
    }

    @Test
    fun `a ranking PUT held at the plan lock beside a plan write still passes - the other writer does not stale it`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-lockmix", teams = true)
        val (a, b) = w.projects(2)
        assertEquals(ok, w.admin.client.rank(listOf(a, b)).status)
        val held = w.admin.client.view().revision
        val teamId = w.requireTeams().teamId
        val status = PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
            try {
                coroutineScope {
                    // The milestone write queues first, the PUT second (tuple-lock waiters are served in queue order), so the
                    // plan write provably commits - and bumps the plan revision - BEFORE the PUT compares.
                    val write = async { TestPlan.milestone(a, teamId) }
                    awaitLockWait("plan_state", waiters = 1)
                    val rank = async { w.admin.client.rank(listOf(b, a), held) }
                    awaitLockWait("plan_state", waiters = 2)
                    raw.rollback()
                    write.await()
                    rank.await().status
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(ok, status, "the plan write committed first and the PUT still passed")
        assertTrue(TestPlan.revision() >= held + 2, "the milestone write bumped, then the PUT")
        assertEquals(TestPlan.revision(), rankingRevision())
        assertEquals(dense(listOf(b, a)), entries())
    }

    @Test
    fun `duplicate, unknown, deleted and oversized id lists are 400 and change nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-400")
        val admin = w.admin.client
        val (a, gone) = w.projects(2)
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/projects/$gone").status)
        assertEquals(ok, admin.rank(listOf(a)).status)
        val revision = TestPlan.revision()
        val bad = mapOf(
            "duplicate" to listOf(a, a),
            "unknown" to listOf(a, 999_999u),
            "deleted" to listOf(a, gone),
            "more than 1000" to List(1001) { 5_000_000u + it.toUInt() },
        )
        for ((label, ids) in bad) assertEquals(HttpStatusCode.BadRequest, admin.rank(ids).status, label)
        assertEquals("projectIds must be distinct", admin.rank(listOf(a, a)).body<ProblemDetail>().detail)
        assertTrue(admin.rank(listOf(a, gone)).body<ProblemDetail>().detail!!.contains("$gone"))
        val negative = admin.rawRank("""{"expectedRevision":$revision,"projectIds":[-1]}""")
        assertEquals(HttpStatusCode.BadRequest, negative.status, "a negative id")
        assertEquals(HttpStatusCode.BadRequest, admin.rawRank("""{"projectIds":[]}""").status, "the revision is required")
        assertEquals(revision, TestPlan.revision())
        assertEquals(dense(listOf(a)), entries())
    }

    @Test
    fun `a PUT writes positions exactly 1 to n in the given order - reorder, drop, append, empty`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-order")
        val admin = w.admin.client
        val projects = w.projects(4)
        val (a, b, c) = projects
        val d = projects[3]
        val steps = listOf(
            listOf(a, b, c), listOf(c, a, b), listOf(b, a, c), listOf(c, b, a), listOf(b, a), listOf(b, a, d), emptyList(),
        )
        for (ids in steps) {
            val expected = dense(ids)
            val before = TestPlan.revision()
            assertEquals(ok, admin.rank(ids).status, "$ids")
            assertEquals(expected, entries(), "$ids")
            assertEquals(before + 1, TestPlan.revision(), "$ids: one bump per PUT")
            assertEquals(expected, admin.view().ranked.map { it.position to it.project.id }, "$ids: the view agrees")
        }
        val all = setOf(a, b, c, d)
        assertEquals(all, admin.view().unranked.map { it.id }.filter { it in all }.toSet(), "dropped = unranked")
    }

    @Test
    fun `deleting a ranked project removes its entry and keeps the positions dense - first, last and middle`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-delete")
        val admin = w.admin.client
        val projects = w.projects(5)
        val (a, b, c) = projects
        val (d, e) = projects.drop(3)
        assertEquals(ok, admin.rank(listOf(a, b, c, d, e)).status)

        suspend fun deleteAndCheck(id: UInt, expected: List<Pair<Int, UInt>>) {
            val before = TestPlan.revision()
            assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$id").status)
            assertEquals(expected, entries(), "after deleting $id")
            assertEquals(before + 1, TestPlan.revision(), "the delete is ONE plan write")
            assertEquals(0, TestPlan.scalar("SELECT count(*) FROM roadmap_entries WHERE project_id = $id") { it.getInt(1) }, "hard-deleted")
        }
        deleteAndCheck(a, dense(listOf(b, c, d, e))) // position 1: every other row shifts in the one sweep
        deleteAndCheck(d, dense(listOf(b, c, e))) // the middle
        deleteAndCheck(e, dense(listOf(b, c))) // the last
        // An unranked project's delete leaves the ranking alone, and the next PUT works on the compacted ranking.
        val unranked = w.projects(1).single()
        deleteAndCheck(unranked, dense(listOf(b, c)))
        assertEquals(ok, admin.rank(admin.view().ranked.map { it.project.id }.reversed().filter { it in setOf(b, c) }).status)
        assertEquals(dense(listOf(c, b)), entries())
    }

    @Test
    fun `the position constraint is deferrable - a swap and a sweep pass, a duplicate fails only at commit`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-deferred")
        val (a, b, c) = w.projects(3)
        assertEquals(ok, w.admin.client.rank(listOf(a, b, c)).status)
        val deferrable = TestPlan.scalar(
            "SELECT condeferrable AND condeferred FROM pg_constraint WHERE conname = 'uq_roadmap_entries_position'",
        ) { it.getBoolean(1) }
        assertTrue(deferrable, "DEFERRABLE INITIALLY DEFERRED")
        PostgresTestSupport.connect().use { c1 ->
            c1.autoCommit = false
            // One statement swaps two positions: an immediate unique check would reject it mid-statement.
            c1.createStatement().use {
                it.executeUpdate(
                    "UPDATE roadmap_entries SET position = CASE project_id WHEN $a THEN 2 WHEN $b THEN 1 END WHERE project_id IN ($a, $b)",
                )
            }
            c1.commit()
            // A duplicate position is accepted by the statement and refused when the transaction commits.
            c1.createStatement().use { it.executeUpdate("UPDATE roadmap_entries SET position = 1 WHERE project_id = $c") }
            assertEquals("23505", assertFailsWith<SQLException> { c1.commit() }.sqlState)
            c1.rollback()
            // A position below 1 is the CHECK, immediately.
            val check = assertFailsWith<SQLException> {
                c1.createStatement().use { it.executeUpdate("UPDATE roadmap_entries SET position = 0 WHERE project_id = $c") }
            }
            assertEquals("23514", check.sqlState)
            c1.rollback()
        }
        assertEquals(dense(listOf(b, a, c)), entries())
    }

    @Test
    fun `two PUTs racing with the same expectedRevision - exactly one wins and the other is the stale 409`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-race")
        val (a, b, c) = w.projects(3)
        assertEquals(ok, w.admin.client.rank(listOf(a, b, c)).status)
        val revision = TestPlan.revision()
        val orders = listOf(listOf(c, b, a), listOf(b, c, a))
        val statuses = PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
            try {
                coroutineScope {
                    val calls = orders.map { ids -> async { w.admin.client.rank(ids, revision) } }
                    awaitLockWait("plan_state", waiters = 2)
                    raw.rollback()
                    calls.map { it.await().status }
                }
            } finally {
                raw.rollback()
            }
        }
        assertEquals(listOf(ok, HttpStatusCode.Conflict), statuses.sortedBy { it.value })
        assertEquals(revision + 1, TestPlan.revision(), "only the winner bumped")
        val winner = orders[statuses.indexOf(ok)]
        assertEquals(dense(winner), entries(), "the ranking is the winner's list, whole")
    }

    @Test
    fun `the roadmap view lists ranked and unranked projects with program, stream and owner names, unranked by name`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-view")
        val owner = w.projectOwner.personId!!
        val ownerName = w.admin.client.get("/api/v1/people/$owner").body<PersonResponse>().name
        val stream = TestPlan.workStream(owner, planName("Stream"))
        val program = TestPlan.program(stream, owner, planName("Program"))
        val tag = planName("rkv")
        val windowed = TestPlan.project(program, owner, "$tag-windowed", "2026-03-29", "2026-10-25")
        val upper = TestPlan.project(program, owner, "$tag-Bravo")
        val lower = TestPlan.project(program, owner, "$tag-alpha")
        val deleted = TestPlan.project(program, owner, "$tag-deleted")
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/$deleted").status)
        assertEquals(ok, w.admin.client.rank(listOf(windowed)).status)

        val view = w.stranger.client.view()
        assertEquals(TestPlan.revision(), view.revision)
        val ranked = view.ranked.single()
        assertEquals(1, ranked.position)
        with(ranked.project) {
            assertEquals(windowed, id)
            assertEquals("$tag-windowed", name)
            assertEquals(program, programId)
            assertEquals(stream, workStreamId)
            assertEquals(ownerName, this.ownerName)
            assertEquals("2026-03-29", targetStart)
            assertEquals("2026-10-25", targetEnd)
            assertTrue(programName.startsWith("Program-") && workStreamName.startsWith("Stream-"))
        }
        val mine = view.unranked.filter { it.name.startsWith(tag) }
        assertEquals(listOf(lower, upper), mine.map { it.id }, "by name, case-insensitively; the deleted project is absent")
        assertEquals(null, mine.first().targetStart)
    }

    @Test
    fun `can-editRank agrees with the guard for every kind of caller`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-can")
        val (a) = w.projects(1)
        assertEquals(ok, w.admin.client.rank(listOf(a)).status)
        val expected = mapOf(
            "admin" to true, "roadmap editor" to true, "stream owner" to false, "program owner" to false, "project owner" to false,
            "stranger" to false, "person-less login" to false,
        )
        val callers = mapOf(
            "admin" to w.admin, "roadmap editor" to w.editor, "stream owner" to w.streamOwner, "program owner" to w.programOwner,
            "project owner" to w.projectOwner, "stranger" to w.stranger, "person-less login" to w.personless,
        )
        for ((label, caller) in callers) {
            val view = caller.client.view()
            assertEquals(expected.getValue(label), view.can.editRank, label)
            val status = caller.client.rank(view.ranked.map { it.project.id }, view.revision).status
            assertEquals(if (view.can.editRank) ok else forbidden, status, "$label: the flag is what the PUT answers")
        }
    }

    @Test
    fun `roadmap_ranked is audited with both orders and the revisions - a rejected PUT emits nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("rk-audit")
        val (a, b) = w.projects(2)
        assertEquals(ok, w.admin.client.rank(listOf(a, b)).status)
        withAuditCapture { capture ->
            val before = TestPlan.revision()
            assertEquals(ok, w.editor.client.rank(listOf(b, a)).status)
            val event = capture.awaitEvent { it.message == "roadmap.ranked" && it.hasKeyValue("orderTo", "$b,$a") }
            assertNotNull(event)
            assertTrue(event.hasKeyValue("byUserId", w.editor.userId.toLong()))
            assertTrue(event.hasKeyValue("revisionFrom", before))
            assertTrue(event.hasKeyValue("revisionTo", before + 1))
            assertTrue(event.hasKeyValue("orderFrom", "$a,$b"))

            assertEquals(HttpStatusCode.Conflict, w.admin.client.rank(listOf(a), before).status)
            assertEquals(HttpStatusCode.BadRequest, w.admin.client.rank(listOf(a, a)).status)
            assertEquals(forbidden, w.stranger.client.rank(listOf(a)).status)
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("path", "/api/v1/roadmap/ranking") })
            assertEquals(1, capture.events.count { it.message == "roadmap.ranked" }, "only the accepted PUT is a ranking event")
        }
    }
}
