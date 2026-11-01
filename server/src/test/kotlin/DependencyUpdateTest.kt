package ch.nokillswit

import ch.nokillswit.planning.DEPENDENCY_CYCLE_PROBLEM
import ch.nokillswit.planning.DependencyResponse
import ch.nokillswit.planning.DependencyStatus
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.ProjectResponse
import ch.nokillswit.planning.ProjectView
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
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * `PUT /dependencies/{id}` (the link's type and lag; the ends never change): the SUCCESSOR's project chain is the guard like the
 * delete's (read-before-guard, a forbidden caller's malformed body stays 403), every 400, the full-body rule, what an edit changes and
 * what a no-op leaves alone (the revision bumps either way, `updated_at` and the audit only on a change), the cycle re-check on the
 * graph WITHOUT the edited edge (409 with the path as data, nothing written, no bump), the guard re-run under the plan lock, and the
 * project view reading the new check back. Plan tables are SHARED suite state: every test mints a world of its own.
 */
class DependencyUpdateTest {
    private suspend fun HttpClient.rawPut(path: String, body: String): HttpResponse = put(path) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpResponse.problem(): ProblemDetail = body()

    private fun stored(id: UInt): Triple<String, Int, Long> = PostgresTestSupport.connect().use { c ->
        c.createStatement().use { st ->
            st.executeQuery("SELECT type, lag_days, updated_at FROM dependencies WHERE id = $id").use { rs ->
                rs.next()
                Triple(rs.getString(1), rs.getInt(2), rs.getLong(3))
            }
        }
    }

    private fun zeroUpdatedAt(id: UInt) = PostgresTestSupport.connect().use {
        it.createStatement().use { st -> st.executeUpdate("UPDATE dependencies SET updated_at = 0 WHERE id = $id") }
    }

    @Test
    fun `an unauthenticated PUT is 401`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().put("/api/v1/dependencies/1").status)
    }

    @Test
    fun `editing a link needs an owner of the SUCCESSOR's project chain or ADMIN, not the predecessor's - 404, 403, then the body`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("dup", teams = true)
            val t = w.requireTeams()
            val b = secondProject(w, "dup")
            val a1 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
            val b1 = milestoneRef(TestPlan.milestone(b.projectId, t.teamId))
            val denied = listOf("the predecessor's project owner" to w.projectOwner, "a team manager" to t.manager) + w.outsiders
            val allowed = listOf(
                "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner,
                "successor project owner" to b.owner,
            )
            for ((label, caller) in allowed) {
                val id = TestPlan.dependency(a1, b1)
                for ((deniedLabel, outsider) in denied) {
                    val refused = outsider.client.putDependency(id, DependencyType.SS, 2)
                    assertEquals(HttpStatusCode.Forbidden, refused.status, "$deniedLabel for $label")
                    assertEquals(
                        HttpStatusCode.Forbidden, outsider.client.rawPut("/api/v1/dependencies/$id", "{ not json").status,
                        "a forbidden caller's malformed body stays 403: $deniedLabel",
                    )
                    val unknown = outsider.client.putDependency(999_999u, DependencyType.SS)
                    assertEquals(HttpStatusCode.NotFound, unknown.status, "404 before 403: $deniedLabel")
                }
                assertEquals(DependencyType.FS.name to 0, stored(id).let { it.first to it.second }, "$label: a refused edit wrote nothing")
                assertEquals(HttpStatusCode.NoContent, caller.client.putDependency(id, DependencyType.SS, 2).status, label)
                assertEquals(DependencyType.SS.name to 2, stored(id).let { it.first to it.second }, label)
                assertEquals(HttpStatusCode.NoContent, caller.client.delete("/api/v1/dependencies/$id").status)
                assertEquals(HttpStatusCode.NotFound, caller.client.putDependency(id, DependencyType.FS).status, "a deleted link is 404")
            }
            // A project-level successor: the same chain rule, the PREDECESSOR project's owner is still refused.
            val id = TestPlan.dependency(projectRef(w.projectId), projectRef(b.projectId))
            assertEquals(HttpStatusCode.Forbidden, w.projectOwner.client.putDependency(id, DependencyType.FF).status)
            assertEquals(HttpStatusCode.NoContent, b.owner.client.putDependency(id, DependencyType.FF).status)
        }

    @Test
    fun `an invalid body is 400 and writes nothing - both fields are required, the lag is in range`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpb", teams = true)
        val t = w.requireTeams()
        val admin = w.admin.client
        val pred = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val id = TestPlan.dependency(pred, milestoneRef(TestPlan.milestone(w.projectId, t.teamId)))
        val before = TestPlan.revision()
        val path = "/api/v1/dependencies/$id"

        suspend fun expect400(label: String, response: HttpResponse, detail: String? = null) {
            assertEquals(HttpStatusCode.BadRequest, response.status, label)
            if (detail != null) assertEquals(detail, response.problem().detail, label)
        }
        val range = "Lag must be between -365 and 365 working days"
        expect400("lag 366", admin.putDependency(id, DependencyType.SS, 366), range)
        expect400("lag -366", admin.putDependency(id, DependencyType.SS, -366), range)
        expect400("an unknown type", admin.rawPut(path, """{"type":"XX","lagDays":0}"""))
        expect400("a missing type", admin.rawPut(path, """{"lagDays":0}"""))
        expect400("a missing lag - no partial body", admin.rawPut(path, """{"type":"SS"}"""))
        expect400("a non-integer lag", admin.rawPut(path, """{"type":"SS","lagDays":"x"}"""))
        expect400("a fractional lag", admin.rawPut(path, """{"type":"SS","lagDays":1.5}"""))
        expect400("malformed JSON", admin.rawPut(path, "{ not json"))
        assertEquals(before, TestPlan.revision(), "no rejected write moved the revision")
        assertEquals(DependencyType.FS.name to 0, stored(id).let { it.first to it.second })
        // The boundaries and a lead are accepted; the ends never move.
        for (lag in listOf(365, -365, 0, -2)) {
            assertEquals(HttpStatusCode.NoContent, admin.putDependency(id, DependencyType.FF, lag).status, "lag $lag")
            assertEquals(DependencyType.FF.name to lag, stored(id).let { it.first to it.second })
        }
        val read = admin.get(path).body<DependencyResponse>()
        assertEquals(DependencyType.FF, read.type)
        assertEquals(-2, read.lagDays)
    }

    @Test
    fun `a change updates the link, bumps the revision once and audits it - a no-op bumps and touches nothing else`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpn", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dpn")
        val a1 = TestPlan.milestone(w.projectId, t.teamId)
        val b1 = TestPlan.milestone(b.projectId, t.teamId)
        val id = TestPlan.dependency(milestoneRef(a1), milestoneRef(b1), DependencyType.FS, 3)
        zeroUpdatedAt(id)
        withAuditCapture { capture ->
            // A no-op: the same type and lag. The conservative rule bumps the revision; no row write, no audit.
            var revision = TestPlan.revision()
            assertEquals(HttpStatusCode.NoContent, b.owner.client.putDependency(id, DependencyType.FS, 3).status)
            assertEquals(revision + 1, TestPlan.revision(), "a no-op still bumps")
            assertEquals(0L, stored(id).third, "a no-op leaves updated_at alone")

            // A lag-only change.
            revision = TestPlan.revision()
            assertEquals(HttpStatusCode.NoContent, b.owner.client.putDependency(id, DependencyType.FS, -1).status)
            assertEquals(revision + 1, TestPlan.revision())
            val lagOnly = stored(id)
            assertEquals(DependencyType.FS.name to -1, lagOnly.first to lagOnly.second)
            assertTrue(lagOnly.third > 0L, "a change stamps updated_at")

            // A type change, by ADMIN.
            assertEquals(HttpStatusCode.NoContent, w.admin.client.putDependency(id, DependencyType.SF, 4).status)
            val read = w.admin.client.get("/api/v1/dependencies/$id").body<DependencyResponse>()
            assertEquals(DependencyType.SF, read.type)
            assertEquals(4, read.lagDays)
            assertEquals(a1, read.predecessor.id, "the ends never change")
            assertEquals(b1, read.successor.id)

            val last = assertNotNull(capture.awaitEvent { it.message == "dependency.updated" && it.hasKeyValue("typeTo", "SF") })
            assertTrue(last.hasKeyValue("byUserId", w.admin.userId.toLong()))
            assertTrue(last.hasKeyValue("dependencyId", id.toLong()))
            assertTrue(last.hasKeyValue("predKind", "MILESTONE"))
            assertTrue(last.hasKeyValue("predId", a1.toLong()))
            assertTrue(last.hasKeyValue("succKind", "MILESTONE"))
            assertTrue(last.hasKeyValue("succId", b1.toLong()))
            assertTrue(last.hasKeyValue("typeFrom", "FS"))
            assertTrue(last.hasKeyValue("lagFrom", -1))
            assertTrue(last.hasKeyValue("lagTo", 4))
            val first = assertNotNull(capture.awaitEvent { it.message == "dependency.updated" && it.hasKeyValue("lagTo", -1) })
            assertTrue(first.hasKeyValue("typeFrom", "FS") && first.hasKeyValue("typeTo", "FS") && first.hasKeyValue("lagFrom", 3))
            val emitted = capture.events.count { it.message == "dependency.updated" && it.hasKeyValue("dependencyId", id.toLong()) }
            assertEquals(2, emitted, "the lag change and the type change were audited, the no-op was not")

            // A rejected edit emits nothing of its own; a 403 is the central denial.
            val before = capture.events.count { it.message?.startsWith("dependency.") == true }
            w.admin.client.putDependency(id, DependencyType.FS, 999) // 400
            w.stranger.client.putDependency(id, DependencyType.FS, 0) // 403
            assertEquals(before, capture.events.count { it.message?.startsWith("dependency.") == true })
            assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", w.stranger.userId.toLong()) })
        }
    }

    @Test
    fun `a type change that would close a cycle is 409 dependency-cycle with the path, nothing written, no bump`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpy", teams = true)
        val t = w.requireTeams()
        val admin = w.admin.client
        val names = mutableMapOf<UInt, String>()
        suspend fun milestone(label: String): UInt {
            val name = planName(label)
            return TestPlan.milestone(w.projectId, t.teamId, name).also { names[it] = name }
        }
        val projectName = admin.get("/api/v1/projects/${w.projectId}").body<ProjectResponse>().name

        suspend fun refused(id: UInt, type: DependencyType, lag: Int, path: List<String>) {
            val revision = TestPlan.revision()
            val before = stored(id)
            val response = admin.putDependency(id, type, lag)
            assertEquals(HttpStatusCode.Conflict, response.status, "$path")
            val problem = response.problem()
            val cycle = assertNotNull(problem.cycle, "the cycle member is present")
            assertEquals(DEPENDENCY_CYCLE_PROBLEM, problem.type)
            assertEquals(path, cycle.map { it.name })
            assertEquals(cycle.first(), cycle.last(), "the first node repeated last")
            assertEquals("Changing this dependency would close a cycle: ${path.joinToString(" → ")}", problem.detail)
            assertEquals(revision, TestPlan.revision(), "no bump")
            assertEquals(before, stored(id), "nothing written")
        }

        // A project that starts with its own milestone (p SS m) is redundant with containment and allowed; p FS m is a loop through it.
        val inside = milestone("inside")
        val startsWith = TestPlan.dependency(projectRef(w.projectId), milestoneRef(inside), DependencyType.SS)
        refused(startsWith, DependencyType.FS, 0, listOf(projectName, names.getValue(inside), projectName))
        val lagOnly = admin.putDependency(startsWith, DependencyType.SS, 5)
        assertEquals(HttpStatusCode.NoContent, lagOnly.status, "a lag change cannot close a cycle")

        // A three-entity loop: m1 SS m2, m2 FS m3 and m3 FF m1 are fine; m3 SS m1 would close S1 -> S2 -> E2 -> S3 -> S1.
        val m1 = milestone("m1")
        val m2 = milestone("m2")
        val m3 = milestone("m3")
        TestPlan.dependency(milestoneRef(m1), milestoneRef(m2), DependencyType.SS)
        TestPlan.dependency(milestoneRef(m2), milestoneRef(m3), DependencyType.FS)
        val back = TestPlan.dependency(milestoneRef(m3), milestoneRef(m1), DependencyType.FF)
        val n = { id: UInt -> names.getValue(id) }
        refused(back, DependencyType.SS, 0, listOf(n(m3), n(m1), n(m2), n(m3)))
        // Start-to-finish adds S3 -> E1; E1 reaches only END(project), never S3, so it is accepted - the check is on the new edge.
        val revision = TestPlan.revision()
        assertEquals(HttpStatusCode.NoContent, admin.putDependency(back, DependencyType.SF, 2).status)
        assertEquals(revision + 1, TestPlan.revision())
        assertEquals(DependencyType.SF.name to 2, stored(back).let { it.first to it.second })
    }

    @Test
    fun `an edit held open is re-guarded under the plan lock, and a link deleted meanwhile is 404`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dph", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dph")
        val a1 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val b1 = milestoneRef(TestPlan.milestone(b.projectId, t.teamId))
        val link = TestPlan.dependency(a1, b1)
        val revision = TestPlan.revision()
        val demoted = requestHeldAtPlanLock(
            { b.owner.client.putDependency(link, DependencyType.SS, 1) },
            { it.exec("UPDATE projects SET owner_person_id = ? WHERE id = ?", w.stranger.personId!!.toInt(), b.projectId.toInt()) },
        )
        assertEquals(HttpStatusCode.Forbidden, demoted.status, "the owner re-assigned meanwhile")
        assertEquals(revision, TestPlan.revision(), "no bump")
        assertEquals(DependencyType.FS.name to 0, stored(link).let { it.first to it.second })
        val vanished = requestHeldAtPlanLock(
            { w.admin.client.putDependency(link, DependencyType.SS, 1) },
            { it.exec("UPDATE dependencies SET marked_as_deleted = TRUE WHERE id = ?", link.toInt()) },
        )
        assertEquals(HttpStatusCode.NotFound, vanished.status, "the chain is re-read under the lock")
    }

    @Test
    fun `the project view reads the edited type and lag back - the check follows`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpv2", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dpv2")
        val a1 = TestPlan.milestone(w.projectId, t.teamId)
        val b1 = TestPlan.milestone(b.projectId, t.teamId)
        TestPlan.schedule(a1, "2027-02-01", "2027-02-05")
        TestPlan.schedule(b1, "2027-02-08", "2027-02-12")
        // Finish-to-start: b1 starts the working day after a1 ends - satisfied. Start-to-start with a +5 lag needs 2027-02-08, which
        // holds too; +6 needs 2027-02-09, one working day late.
        val link = TestPlan.dependency(milestoneRef(a1), milestoneRef(b1), DependencyType.FS, 0)
        suspend fun check() =
            w.stranger.client.get("/api/v1/views/project/${b.projectId}").body<ProjectView>().dependencies.single { it.id == link }
        assertEquals(DependencyStatus.OK, check().check.status)
        assertEquals(HttpStatusCode.NoContent, b.owner.client.putDependency(link, DependencyType.SS, 6).status)
        val edited = check()
        assertEquals(DependencyType.SS, edited.type)
        assertEquals(6, edited.lagDays)
        assertEquals(DependencyStatus.VIOLATED, edited.check.status)
        assertEquals(1, edited.check.shortfallDays)
        assertEquals("2027-02-09", edited.check.requiredDate)
    }
}
