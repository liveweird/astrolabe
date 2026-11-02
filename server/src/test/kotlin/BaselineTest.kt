package ch.nokillswit

import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.planning.BASELINE_LIMIT_PROBLEM
import ch.nokillswit.planning.BaselineCreateRequest
import ch.nokillswit.planning.BaselineList
import ch.nokillswit.planning.BaselineResponse
import ch.nokillswit.planning.BaselineUpdateRequest
import ch.nokillswit.users.Permission
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The baselines registry (V20) end to end: the caller matrix (ADMIN and a `ROADMAP_EDITOR` write, everyone else gets 403 BEFORE the body
 * and the id lookup), the grant re-checked under the plan lock, name uniqueness among ACTIVE baselines, the cap of 100, soft delete,
 * the list's `{items, can}` shape and the three audit events. `BaselineCopyTest` owns what a baseline CONTAINS. Baselines are GLOBAL
 * shared state and count toward the cap, so every test removes what it takes.
 */
class BaselineTest {
    private val created = HttpStatusCode.Created
    private val noContent = HttpStatusCode.NoContent
    private val forbidden = HttpStatusCode.Forbidden
    private val conflict = HttpStatusCode.Conflict

    private suspend fun HttpClient.take(name: String, description: String? = null): HttpResponse =
        postJson("/api/v1/baselines", BaselineCreateRequest(name, description))

    private suspend fun HttpClient.rename(id: UInt, name: String, description: String? = null): HttpResponse =
        putJson("/api/v1/baselines/$id", BaselineUpdateRequest(name, description))

    private suspend fun HttpClient.rawPost(body: String): HttpResponse = post("/api/v1/baselines") {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpClient.rawPut(id: UInt, body: String): HttpResponse = put("/api/v1/baselines/$id") {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpClient.list(): BaselineList = get("/api/v1/baselines").body()

    private fun activeBaselines(): Int = TestPlan.scalar("SELECT count(*) FROM baselines WHERE NOT marked_as_deleted") { it.getInt(1) }

    private fun execSql(sql: String): Int = PostgresTestSupport.connect().use { c -> c.createStatement().use { it.executeUpdate(sql) } }

    private fun rowsNamed(name: String): Int = TestPlan.scalar("SELECT count(*) FROM baselines WHERE name = '$name'") { it.getInt(1) }

    @Test
    fun `ADMIN and a roadmap editor take baselines - every other caller gets 403 before the body is read and nothing is written`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bl-guard", teams = true)
            val ids = mutableListOf<UInt>()
            try {
                for ((label, caller) in listOf("admin" to w.admin, "roadmap editor" to w.editor)) {
                    val name = planName("bl-$label")
                    val response = caller.client.take(name, "  a description ")
                    assertEquals(created, response.status, label)
                    val baseline = response.body<BaselineResponse>()
                    ids += baseline.id
                    assertEquals("/api/v1/baselines/${baseline.id}", response.headers["Location"], label)
                    assertEquals(name, baseline.name)
                    assertEquals("a description", baseline.description, "trimmed")
                    assertEquals(baseline, caller.client.get("/api/v1/baselines/${baseline.id}").body<BaselineResponse>(), label)
                }
                val revision = TestPlan.revision()
                val active = activeBaselines()
                val outsiders = listOf(
                    "stream owner" to w.streamOwner, "program owner" to w.programOwner, "project owner" to w.projectOwner,
                    "stranger" to w.stranger, "person-less login" to w.personless, "team manager" to w.requireTeams().manager,
                )
                val victim = ids.first()
                for ((label, caller) in outsiders) {
                    val name = planName("bl-denied")
                    assertEquals(forbidden, caller.client.take(name).status, label)
                    assertEquals(forbidden, caller.client.rawPost("{ not json").status, "$label: a malformed body stays 403")
                    assertEquals(forbidden, caller.client.rename(victim, planName("bl-ren")).status, label)
                    assertEquals(forbidden, caller.client.rawPut(999999999u, "garbage").status, "$label: and so does an unknown id")
                    assertEquals(forbidden, caller.client.delete("/api/v1/baselines/$victim").status, label)
                    assertEquals(forbidden, caller.client.delete("/api/v1/baselines/999999999").status, "$label: whether or not it exists")
                    assertEquals(0, rowsNamed(name), "$label wrote nothing")
                }
                assertEquals(revision, TestPlan.revision(), "a refused write never moves the plan revision")
                assertEquals(active, activeBaselines())
                assertEquals(HttpStatusCode.OK, w.stranger.client.get("/api/v1/baselines/$victim").status, "reads are everyone's")
            } finally {
                ids.forEach { TestPlan.deleteBaseline(it) }
            }
        }

    @Test
    fun `a request without a token is 401 on every operation`() = testApplication {
        usePostgresTestcontainer()
        val anonymous = jsonClient()
        assertEquals(HttpStatusCode.Unauthorized, anonymous.get("/api/v1/baselines").status)
        assertEquals(HttpStatusCode.Unauthorized, anonymous.take(planName("bl-anon")).status)
        assertEquals(HttpStatusCode.Unauthorized, anonymous.get("/api/v1/baselines/1").status)
        assertEquals(HttpStatusCode.Unauthorized, anonymous.rename(1u, planName("bl-anon")).status)
        assertEquals(HttpStatusCode.Unauthorized, anonymous.delete("/api/v1/baselines/1").status)
    }

    @Test
    fun `the body is validated - an editor gets 400 for a blank, long or control-character name and a long description`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bl-valid")
            val id = TestPlan.baseline()
            try {
                val revision = TestPlan.revision()
                val bad = listOf(
                    "  ", "x".repeat(101), "tab\there", "new\nline",
                )
                for (name in bad) {
                    assertEquals(HttpStatusCode.BadRequest, w.editor.client.take(name).status, "create '$name'")
                    assertEquals(HttpStatusCode.BadRequest, w.editor.client.rename(id, name).status, "rename '$name'")
                }
                assertEquals(HttpStatusCode.BadRequest, w.editor.client.take(planName("bl-d"), "d".repeat(501)).status)
                assertEquals(HttpStatusCode.BadRequest, w.editor.client.rename(id, planName("bl-d"), "d".repeat(501)).status)
                assertEquals(HttpStatusCode.BadRequest, w.editor.client.rawPost("{ not json").status)
                assertEquals(HttpStatusCode.BadRequest, w.editor.client.rawPost("{}").status, "a name is required")
                assertEquals(HttpStatusCode.BadRequest, w.editor.client.get("/api/v1/baselines/abc").status)
                assertEquals(HttpStatusCode.BadRequest, w.editor.client.get("/api/v1/baselines/-1").status)
                assertEquals(revision, TestPlan.revision(), "a rejected body is rolled back or never reaches the lock")
                val maxName = "n".repeat(100)
                val response = w.editor.client.take(maxName, "d".repeat(500))
                assertEquals(created, response.status, "the bounds themselves are fine")
                TestPlan.deleteBaseline(response.body<BaselineResponse>().id)
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    @Test
    fun `a PUT is a full replace - an omitted description clears it, and a changed one is read back`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("bl-replace")
        val baseline = w.editor.client.take(planName("bl-replace"), "first words").body<BaselineResponse>()
        try {
            assertEquals("first words", w.admin.client.get("/api/v1/baselines/${baseline.id}").body<BaselineResponse>().description)
            assertEquals(noContent, w.editor.client.rename(baseline.id, baseline.name, "second words").status)
            assertEquals("second words", w.admin.client.get("/api/v1/baselines/${baseline.id}").body<BaselineResponse>().description)
            assertEquals(noContent, w.editor.client.rawPut(baseline.id, """{"name":"${baseline.name}"}""").status)
            val cleared = w.admin.client.get("/api/v1/baselines/${baseline.id}").body<BaselineResponse>()
            assertNull(cleared.description, "omitted = cleared")
            assertEquals(baseline.name, cleared.name)
            assertEquals(baseline.planRevision, cleared.planRevision, "the frozen facts never change")
            assertEquals(baseline.milestoneCount, cleared.milestoneCount)
        } finally {
            TestPlan.deleteBaseline(baseline.id)
        }
    }

    @Test
    fun `a name is unique among ACTIVE baselines case-insensitively, the 409 names what clashed, and a delete frees it`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bl-name")
            val name = planName("Bl-Name")
            val first = w.admin.client.take(name).body<BaselineResponse>()
            val extra = mutableListOf<UInt>()
            try {
                val revision = TestPlan.revision()
                val clash = w.editor.client.take(name.uppercase())
                assertEquals(conflict, clash.status, "case-insensitive")
                assertContains(clash.bodyAsText(), "A baseline with this name already exists", message = "the SPA relies on this detail")
                assertEquals(revision, TestPlan.revision(), "the clash rolled back the bump")
                val other = TestPlan.baseline()
                extra += other
                assertEquals(conflict, w.editor.client.rename(other, name.lowercase()).status, "a rename onto a taken name clashes too")
                assertEquals(noContent, w.admin.client.rename(first.id, name.lowercase()).status, "renaming onto itself (case) is fine")
                assertEquals(noContent, w.admin.client.delete("/api/v1/baselines/${first.id}").status)
                val reused = w.admin.client.take(name)
                assertEquals(created, reused.status, "a deleted baseline frees its name")
                extra += reused.body<BaselineResponse>().id
            } finally {
                TestPlan.deleteBaseline(first.id)
                extra.forEach { TestPlan.deleteBaseline(it) }
            }
        }

    @Test
    fun `the cap of 100 active baselines is a 409 with the baseline-limit type, checked under the lock, and a delete makes room`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bl-cap")
            val prefix = planName("bl-capfill")
            val makeRoom = 99 - activeBaselines()
            assertTrue(makeRoom >= 0, "the suite leaves at most 99 active baselines behind")
            if (makeRoom > 0) {
                // Header-only rows: the cap counts active headers, and a frozen-row copy per seed would only slow the test.
                execSql(
                    "INSERT INTO baselines (name, plan_revision, milestone_count, project_count, created_at, updated_at) " +
                        "SELECT '$prefix-' || g, 0, 0, 0, 1, 1 FROM generate_series(1, $makeRoom) g",
                )
            }
            var admitted: UInt? = null
            try {
                assertEquals(99, activeBaselines())
                val revision = TestPlan.revision()
                val frozenBefore = TestPlan.scalar("SELECT count(*) FROM baseline_milestones") { it.getInt(1) }
                // The cap is counted UNDER the lock: the create passes the outer guard at 99, waits for the lock, and a 100th header
                // committed meanwhile (by whoever held it) is seen - a count taken before the lock would admit the 101st.
                val refused = requestHeldAtPlanLock({ w.editor.client.take(planName("bl-over")) }) { raw ->
                    raw.createStatement().use {
                        it.executeUpdate(
                            "INSERT INTO baselines (name, plan_revision, milestone_count, project_count, created_at, updated_at) " +
                                "VALUES ('$prefix-last', 0, 0, 0, 1, 1)",
                        )
                    }
                }
                assertEquals(conflict, refused.status)
                assertEquals(BASELINE_LIMIT_PROBLEM, refused.body<ProblemDetail>().type)
                // The cap is checked before the name: a duplicate name at the cap is the limit, not the unique violation.
                val dup = w.admin.client.take("$prefix-last")
                assertEquals(BASELINE_LIMIT_PROBLEM, dup.body<ProblemDetail>().type)
                assertEquals(revision, TestPlan.revision(), "a refused create moved nothing")
                assertEquals(100, activeBaselines())
                assertEquals(frozenBefore, TestPlan.scalar("SELECT count(*) FROM baseline_milestones") { it.getInt(1) }, "no frozen rows")
                assertEquals(100, w.stranger.client.list().items.size, "the list still reads, at its bound")

                execSql("UPDATE baselines SET marked_as_deleted = TRUE WHERE name = '$prefix-last'")
                val room = w.editor.client.take(planName("bl-room"))
                assertEquals(created, room.status, "one slot freed by a delete")
                admitted = room.body<BaselineResponse>().id
                assertEquals(BASELINE_LIMIT_PROBLEM, w.editor.client.take(planName("bl-over2")).body<ProblemDetail>().type)
            } finally {
                admitted?.let { TestPlan.deleteBaseline(it) }
                execSql("UPDATE baselines SET marked_as_deleted = TRUE WHERE name LIKE '$prefix-%'")
            }
        }

    @Test
    fun `revoking the grant while a write waits for the plan lock refuses it - 403, nothing written, revision unchanged`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bl-revoke")
            val id = TestPlan.baseline(planName("bl-held"))
            try {
                val revision = TestPlan.revision()
                val revoke = { c: java.sql.Connection -> c.exec("DELETE FROM user_permissions WHERE user_id = ?", w.editor.userId.toInt()) }
                val name = planName("bl-never")
                val create = requestHeldAtPlanLock({ w.editor.client.take(name) }, revoke)
                assertEquals(forbidden, create.status, "the outer guard passed on the grant; the re-check under the lock did not")
                assertEquals(0, rowsNamed(name))
                assertEquals(revision, TestPlan.revision())
                // The grant is gone for good now: the held rename and delete find it revoked at the outer guard already. Give it back.
                TestUsers.service.replacePermissions(w.editor.userId, setOf(Permission.ROADMAP_EDITOR))
                val renamed = planName("bl-renamed")
                val rename = requestHeldAtPlanLock({ w.editor.client.rename(id, renamed) }, revoke)
                assertEquals(forbidden, rename.status)
                assertEquals(0, rowsNamed(renamed))
                assertEquals(revision, TestPlan.revision())
                TestUsers.service.replacePermissions(w.editor.userId, setOf(Permission.ROADMAP_EDITOR))
                val delete = requestHeldAtPlanLock({ w.editor.client.delete("/api/v1/baselines/$id") }, revoke)
                assertEquals(forbidden, delete.status)
                assertEquals(HttpStatusCode.OK, w.admin.client.get("/api/v1/baselines/$id").status, "the refused delete changed nothing")
                assertEquals(revision, TestPlan.revision())
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    @Test
    fun `the list is a bounded items-and-can set, newest first, without deleted baselines`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("bl-list")
        val older = TestPlan.baseline(planName("bl-older"))
        val newer = TestPlan.baseline(planName("bl-newer"))
        val gone = TestPlan.baseline(planName("bl-gone"))
        try {
            assertEquals(noContent, w.admin.client.delete("/api/v1/baselines/$gone").status)
            val list = w.stranger.client.list()
            val ids = list.items.map { it.id }
            assertTrue(ids.indexOf(newer) in 0 until ids.indexOf(older), "newest first (created_at, then id)")
            assertFalse(gone in ids, "a deleted baseline is not listed")
            val newestFirst = compareByDescending<BaselineResponse> { it.createdAt }.thenByDescending { it.id }
            assertEquals(list.items.sortedWith(newestFirst), list.items)
            assertTrue(list.items.size <= 100)
            for ((label, caller, can) in listOf(
                Triple("admin", w.admin, true), Triple("editor", w.editor, true), Triple("stranger", w.stranger, false),
                Triple("project owner", w.projectOwner, false), Triple("person-less", w.personless, false),
            )) {
                assertEquals(can, caller.client.list().can.manage, label)
            }
            assertEquals(HttpStatusCode.NotFound, w.admin.client.get("/api/v1/baselines/$gone").status, "deleted reads as 404")
            assertEquals(HttpStatusCode.NotFound, w.admin.client.get("/api/v1/baselines/999999999").status)
        } finally {
            TestPlan.deleteBaseline(older)
            TestPlan.deleteBaseline(newer)
            TestPlan.deleteBaseline(gone)
        }
    }

    @Test
    fun `a delete is soft - the baseline reads as 404 everywhere, a second delete and a rename are 404, the frozen rows stay`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("bl-soft")
            TestPlan.milestone(w.projectId, TestTeams.seed(planName("bl-soft-team")))
            val id = TestPlan.baseline(planName("bl-soft"))
            try {
                val projects = TestPlan.scalar("SELECT count(*) FROM baseline_projects WHERE baseline_id = $id") { it.getInt(1) }
                val milestones = TestPlan.scalar("SELECT count(*) FROM baseline_milestones WHERE baseline_id = $id") { it.getInt(1) }
                assertTrue(projects > 0 && milestones > 0, "the copy holds our project and milestone")
                assertEquals(noContent, w.editor.client.delete("/api/v1/baselines/$id").status)
                assertEquals(HttpStatusCode.NotFound, w.editor.client.get("/api/v1/baselines/$id").status)
                assertEquals(HttpStatusCode.NotFound, w.editor.client.delete("/api/v1/baselines/$id").status)
                assertEquals(HttpStatusCode.NotFound, w.editor.client.rename(id, planName("bl-soft-ren")).status)
                assertFalse(w.editor.client.list().items.any { it.id == id })
                assertEquals(projects, TestPlan.scalar("SELECT count(*) FROM baseline_projects WHERE baseline_id = $id") { it.getInt(1) })
                val kept = TestPlan.scalar("SELECT count(*) FROM baseline_milestones WHERE baseline_id = $id") { it.getInt(1) }
                assertEquals(milestones, kept)
            } finally {
                TestPlan.deleteBaseline(id)
            }
        }

    @Test
    fun `the three events are audited with their fields - a no-op rename, a rejection and a read emit none`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("bl-audit")
        withAuditCapture { capture ->
            val name = planName("bl-audit")
            val baseline = w.editor.client.take(name, "first").body<BaselineResponse>()
            try {
                val ofBaseline = { message: String -> { e: ch.qos.logback.classic.spi.ILoggingEvent ->
                    e.message == message && e.hasKeyValue("baselineId", baseline.id.toLong())
                } }
                val createdEvent = capture.awaitEvent(ofBaseline("baseline.created"))
                assertNotNull(createdEvent)
                assertTrue(createdEvent.hasKeyValue("byUserId", w.editor.userId.toLong()))
                assertTrue(createdEvent.hasKeyValue("name", name))
                assertTrue(createdEvent.hasKeyValue("revisionTo", baseline.planRevision))
                assertTrue(createdEvent.hasKeyValue("milestoneCount", baseline.milestoneCount))
                assertTrue(createdEvent.hasKeyValue("projectCount", baseline.projectCount))

                w.editor.client.get("/api/v1/baselines")
                assertEquals(conflict, w.editor.client.take(name).status)
                assertEquals(noContent, w.editor.client.rename(baseline.id, name, "first").status, "nothing changes")
                val renamed = planName("bl-audit-b")
                assertEquals(noContent, w.admin.client.rename(baseline.id, renamed, "second").status)
                val updated = capture.awaitEvent(ofBaseline("baseline.updated"))
                assertNotNull(updated)
                assertTrue(updated.hasKeyValue("byUserId", w.admin.userId.toLong()))
                assertTrue(updated.hasKeyValue("nameFrom", name))
                assertTrue(updated.hasKeyValue("nameTo", renamed))
                assertTrue(updated.hasKeyValue("descriptionChanged", true))
                assertTrue(updated.hasKeyValue("revisionTo", TestPlan.revision()))
                assertEquals(1, capture.events.count(ofBaseline("baseline.updated")))

                assertEquals(HttpStatusCode.NotFound, w.admin.client.delete("/api/v1/baselines/999999999").status)
                assertEquals(noContent, w.admin.client.delete("/api/v1/baselines/${baseline.id}").status)
                val deleted = capture.awaitEvent(ofBaseline("baseline.deleted"))
                assertNotNull(deleted)
                assertTrue(deleted.hasKeyValue("name", renamed))
                assertTrue(deleted.hasKeyValue("byUserId", w.admin.userId.toLong()))
                assertTrue(deleted.hasKeyValue("revisionTo", TestPlan.revision()))
                assertEquals(1, capture.events.count(ofBaseline("baseline.created")))
                assertNull(capture.events.firstOrNull { it.message.startsWith("baseline.") && it.hasKeyValue("baselineId", 999999999L) })
            } finally {
                TestPlan.deleteBaseline(baseline.id)
            }
        }
    }
}
