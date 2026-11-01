package ch.nokillswit

import ch.nokillswit.authz.ProblemCycleNode
import ch.nokillswit.planning.DEPENDENCY_CYCLE_PROBLEM
import ch.nokillswit.planning.DependencyResponse
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import ch.nokillswit.planning.MilestoneResponse
import ch.nokillswit.planning.ProjectResponse
import ch.nokillswit.plugins.ProblemDetail
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Dependencies over HTTP (V15), create / read / delete: the SUCCESSOR's project chain is the guard (the named product-rule tests: the
 * predecessor's project owner alone cannot create or delete, a team manager who owns nothing on the chain cannot link, a forbidden
 * caller's malformed body stays 403), read-before-guard ordering, every 400, the mixed endpoint kinds read back resolved, the duplicate
 * pair 409, the cycle 409 with its path as data, and what a refused write leaves alone (no row, no revision bump). The cascades, the
 * held-request re-guard, the audits and the V15 constraints are in [DependencyLifecycleTest]. Plan tables are SHARED suite state:
 * every test mints a world of its own and asserts on its own ids.
 */
class DependencyTest {
    private val forbidden = HttpStatusCode.Forbidden

    private suspend fun HttpClient.rawPost(path: String, body: String): HttpResponse = post(path) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpResponse.problem(): ProblemDetail = body()

    private fun depCount(): Int = TestPlan.scalar("SELECT count(*) FROM dependencies WHERE NOT marked_as_deleted") { it.getInt(1) }

    private fun linksInto(milestone: UInt): Int =
        TestPlan.scalar("SELECT count(*) FROM dependencies WHERE NOT marked_as_deleted AND succ_milestone_id = $milestone") { it.getInt(1) }

    @Test
    fun `unauthenticated requests are 401`() = testApplication {
        usePostgresTestcontainer()
        val client = jsonClient()
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/projects/1/dependencies").status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/dependencies/1").status)
        assertEquals(HttpStatusCode.Unauthorized, client.delete("/api/v1/dependencies/1").status)
    }

    @Test
    fun `creating a link needs an owner of the SUCCESSOR's project chain or ADMIN, not the predecessor's`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpc", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dpc")
        val successor = TestPlan.milestone(b.projectId, t.teamId)
        val path = "/api/v1/projects/${b.projectId}/dependencies"
        suspend fun predecessor() = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))

        // The named product rules: the predecessor's project owner (w.projectOwner owns project A, the predecessor's side) cannot link
        // into B, a team manager who owns nothing on B's chain cannot link, and a forbidden caller's malformed body stays 403.
        val denied = listOf(
            "the predecessor's project owner" to w.projectOwner, "a team manager" to t.manager, "the other manager" to t.otherManager,
        ) + w.outsiders
        for ((label, caller) in denied) {
            assertEquals(forbidden, caller.client.postDependency(b.projectId, predecessor(), milestoneRef(successor)).status, label)
            assertEquals(forbidden, caller.client.rawPost(path, "{ not json").status, "a forbidden caller's bad body stays 403: $label")
            val unknownProject = caller.client.postDependency(999_999u, predecessor(), milestoneRef(successor))
            assertEquals(HttpStatusCode.NotFound, unknownProject.status, "404 before 403: $label")
        }
        assertEquals(0, linksInto(successor))

        val allowed = listOf(
            "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner, "second project owner" to b.owner,
        )
        for ((label, caller) in allowed) {
            val pred = predecessor()
            val response = caller.client.postDependency(b.projectId, pred, milestoneRef(successor), DependencyType.FS, 2)
            assertEquals(HttpStatusCode.Created, response.status, label)
            val created = response.body<DependencyResponse>()
            assertEquals("/api/v1/dependencies/${created.id}", response.headers["Location"], label)
            assertEquals(pred.id, created.predecessor.id)
            assertEquals(successor, created.successor.id)
            assertEquals(2, created.lagDays)
        }
        assertEquals(4, linksInto(successor))
        val ownProject = b.owner.client.postDependency(b.projectId, predecessor(), projectRef(b.projectId))
        assertEquals(HttpStatusCode.Created, ownProject.status, "the successor may be the path project itself")
    }

    @Test
    fun `invalid links are 400 and write nothing - unknown or deleted ends, a successor outside the project, self-links, lag, shapes`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("dpv", teams = true)
            val t = w.requireTeams()
            val b = secondProject(w, "dpv")
            val admin = w.admin.client
            val a1 = TestPlan.milestone(w.projectId, t.teamId)
            val b1 = TestPlan.milestone(b.projectId, t.teamId)
            val goneMilestone = TestPlan.milestone(w.projectId, t.teamId)
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/$goneMilestone").status)
            val goneProject = TestPlan.project(w.programId, w.projectOwner.personId!!)
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/projects/$goneProject").status)
            val before = TestPlan.revision()
            val path = "/api/v1/projects/${b.projectId}/dependencies"

            suspend fun expect400(label: String, response: HttpResponse, detail: String? = null) {
                assertEquals(HttpStatusCode.BadRequest, response.status, label)
                if (detail != null) assertEquals(detail, response.problem().detail, label)
            }
            val outside = "Successor must be this project or one of its milestones"
            val self = "A dependency cannot link an endpoint to itself"
            val onB: suspend (EndpointRef, EndpointRef, Int) -> HttpResponse =
                { pred, succ, lag -> admin.postDependency(b.projectId, pred, succ, lagDays = lag) }
            expect400("unknown predecessor milestone", onB(milestoneRef(999_999u), milestoneRef(b1), 0),
                "Unknown or deleted milestone ids: 999999")
            expect400("deleted predecessor milestone", onB(milestoneRef(goneMilestone), milestoneRef(b1), 0),
                "Unknown or deleted milestone ids: $goneMilestone")
            expect400("unknown predecessor project", onB(projectRef(999_999u), milestoneRef(b1), 0),
                "Unknown or deleted project ids: 999999")
            expect400("deleted predecessor project", onB(projectRef(goneProject), milestoneRef(b1), 0),
                "Unknown or deleted project ids: $goneProject")
            expect400("a successor milestone of another project", onB(milestoneRef(b1), milestoneRef(a1), 0), outside)
            expect400("a successor project that is not the path project", onB(milestoneRef(b1), projectRef(w.projectId), 0), outside)
            expect400("an unknown successor milestone", onB(milestoneRef(a1), milestoneRef(999_999u), 0), outside)
            expect400("a deleted successor milestone", onB(milestoneRef(a1), milestoneRef(goneMilestone), 0), outside)
            expect400("a milestone linked to itself", onB(milestoneRef(b1), milestoneRef(b1), 0), self)
            expect400("a project linked to itself", onB(projectRef(b.projectId), projectRef(b.projectId), 0), self)
            expect400("lag 366", onB(milestoneRef(a1), milestoneRef(b1), 366), "Lag must be between -365 and 365 working days")
            expect400("lag -366", onB(milestoneRef(a1), milestoneRef(b1), -366))
            val pred = """{"kind":"MILESTONE","id":$a1}"""
            val succ = """{"kind":"MILESTONE","id":$b1}"""
            expect400("an unknown type", admin.rawPost(path, """{"predecessor":$pred,"successor":$succ,"type":"XX"}"""))
            expect400("an unknown kind", admin.rawPost(path, """{"predecessor":{"kind":"TEAM","id":1},"successor":$succ,"type":"FS"}"""))
            expect400("a missing successor", admin.rawPost(path, """{"predecessor":$pred,"type":"FS"}"""))
            expect400("a missing type", admin.rawPost(path, """{"predecessor":$pred,"successor":$succ}"""))
            expect400("a non-integer lag", admin.rawPost(path, """{"predecessor":$pred,"successor":$succ,"type":"FS","lagDays":"x"}"""))
            assertEquals(before, TestPlan.revision(), "no rejected write moved the revision")
            assertEquals(0, linksInto(b1))
        }

    @Test
    fun `the lag boundaries are accepted and an omitted lag is zero`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpl", teams = true)
        val t = w.requireTeams()
        val admin = w.admin.client
        val successor = TestPlan.milestone(w.projectId, t.teamId)
        for (lag in listOf(365, -365, 0)) {
            val pred = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
            val response = admin.postDependency(w.projectId, pred, milestoneRef(successor), DependencyType.SS, lag)
            assertEquals(HttpStatusCode.Created, response.status, "lag $lag")
            assertEquals(lag, response.body<DependencyResponse>().lagDays)
        }
        val pred = TestPlan.milestone(w.projectId, t.teamId)
        val raw = admin.rawPost(
            "/api/v1/projects/${w.projectId}/dependencies",
            """{"predecessor":{"kind":"MILESTONE","id":$pred},"successor":{"kind":"MILESTONE","id":$successor},"type":"FF"}""",
        )
        assertEquals(HttpStatusCode.Created, raw.status)
        val created = raw.body<DependencyResponse>()
        assertEquals(0, created.lagDays, "the lag defaults to 0")
        assertEquals(DependencyType.FF, created.type)
    }

    @Test
    fun `every kind of endpoint links within or across projects and reads back resolved`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpk", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dpk")
        val admin = w.admin.client
        val a1 = TestPlan.milestone(w.projectId, t.teamId, planName("a1"))
        val a2 = TestPlan.milestone(w.projectId, t.teamId, planName("a2-unscheduled"))
        val b1 = TestPlan.milestone(b.projectId, t.otherTeamId, planName("b1"))
        TestPlan.schedule(a1, "2027-02-01", "2027-02-05")
        TestPlan.schedule(b1, "2027-02-08", "2027-02-12")
        val projectA = admin.get("/api/v1/projects/${w.projectId}").body<ProjectResponse>()
        val projectB = admin.get("/api/v1/projects/${b.projectId}").body<ProjectResponse>()
        val a1Name = admin.get("/api/v1/milestones/$a1").body<MilestoneResponse>().name

        // m -> m across projects, then m -> p, p -> m, p -> p; all acyclic (everything flows from A towards B).
        val mm = admin.postDependency(b.projectId, milestoneRef(a1), milestoneRef(b1), DependencyType.FS, 1)
        val mp = admin.postDependency(b.projectId, milestoneRef(a2), projectRef(b.projectId), DependencyType.FS)
        val pm = admin.postDependency(b.projectId, projectRef(w.projectId), milestoneRef(b1), DependencyType.SS, -2)
        val pp = admin.postDependency(b.projectId, projectRef(w.projectId), projectRef(b.projectId), DependencyType.FF)
        for ((label, response) in listOf("m-m" to mm, "m-p" to mp, "p-m" to pm, "p-p" to pp)) {
            assertEquals(HttpStatusCode.Created, response.status, label)
        }
        val read = admin.get("/api/v1/dependencies/${mm.body<DependencyResponse>().id}").body<DependencyResponse>()
        assertEquals(DependencyType.FS, read.type)
        assertEquals(1, read.lagDays)
        with(read.predecessor) {
            assertEquals(EndpointKind.MILESTONE, kind)
            assertEquals(a1, id)
            assertEquals(a1Name, name)
            assertEquals(w.projectId, projectId)
            assertEquals(projectA.name, projectName)
            assertEquals(t.teamId, teamId)
            assertTrue(teamName.orEmpty().isNotBlank())
            assertEquals("2027-02-01", startDate)
            assertEquals("2027-02-05", endDate)
        }
        assertEquals(t.otherTeamId, read.successor.teamId, "the successor milestone's own team")
        assertEquals(b.projectId, read.successor.projectId)

        val milestoneToProject = mp.body<DependencyResponse>()
        assertNull(milestoneToProject.predecessor.startDate, "an unscheduled milestone has no dates")
        assertNull(milestoneToProject.predecessor.endDate)
        with(milestoneToProject.successor) {
            assertEquals(EndpointKind.PROJECT, kind)
            assertEquals(projectB.name, name)
            assertEquals(b.projectId, projectId, "a project endpoint carries its own id as projectId")
            assertNull(teamId)
            assertNull(teamName)
            assertEquals("2027-02-08", startDate, "a project's dates are its DERIVED span")
            assertEquals("2027-02-12", endDate)
        }
        val projectToMilestone = pm.body<DependencyResponse>()
        assertEquals("2027-02-01", projectToMilestone.predecessor.startDate, "project A's span is its only scheduled milestone")
        assertEquals("2027-02-05", projectToMilestone.predecessor.endDate)
        assertEquals(-2, projectToMilestone.lagDays)
    }

    @Test
    fun `a project's endpoint dates are its derived span, never its target window`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpt", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dpt")
        val owner = w.projectOwner.personId!!
        val windowed = TestPlan.project(w.programId, owner, targetStart = "2030-01-01", targetEnd = "2030-12-31")
        TestPlan.schedule(TestPlan.milestone(windowed, t.teamId), "2027-03-01", "2027-03-05")
        val empty = TestPlan.project(w.programId, owner, targetStart = "2030-01-01", targetEnd = "2030-12-31")
        val b1 = TestPlan.milestone(b.projectId, t.teamId)
        val scheduled = w.admin.client.postDependency(b.projectId, projectRef(windowed), milestoneRef(b1)).body<DependencyResponse>()
        assertEquals("2027-03-01", scheduled.predecessor.startDate)
        assertEquals("2027-03-05", scheduled.predecessor.endDate)
        val unscheduled = w.admin.client.postDependency(b.projectId, projectRef(empty), projectRef(b.projectId)).body<DependencyResponse>()
        assertNull(unscheduled.predecessor.startDate, "a project with nothing scheduled has no dates, whatever its window says")
        assertNull(unscheduled.predecessor.endDate)
    }

    @Test
    fun `a second link on the same ordered pair is 409 whatever its type, and a deleted link frees the pair`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpd", teams = true)
        val t = w.requireTeams()
        val admin = w.admin.client
        val a1 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val a2 = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
        val first = admin.postDependency(w.projectId, a1, a2)
        assertEquals(HttpStatusCode.Created, first.status)
        val before = TestPlan.revision()
        for (type in listOf(DependencyType.FS, DependencyType.SS)) {
            val again = admin.postDependency(w.projectId, a1, a2, type, 3)
            assertEquals(HttpStatusCode.Conflict, again.status, "$type")
            val problem = again.problem()
            assertEquals("These two endpoints are already linked", problem.detail)
            assertEquals("about:blank", problem.type)
            assertNull(problem.cycle, "only the cycle problem carries the member")
        }
        assertEquals(before, TestPlan.revision(), "a refused insert rolled the bump back")
        assertFalse(
            admin.postDependency(w.projectId, a1, a2).bodyAsText().contains("\"cycle\""),
            "every other problem omits the extension member",
        )
        val id = first.body<DependencyResponse>().id
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/dependencies/$id").status)
        assertEquals(HttpStatusCode.Created, admin.postDependency(w.projectId, a1, a2, DependencyType.FF).status,
            "the deleted link freed the ordered pair")
    }

    @Test
    fun `a reverse pair that closes no cycle is the plain already-linked 409 - one active link per unordered pair`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpu", teams = true)
        val t = w.requireTeams()
        val admin = w.admin.client
        // SS a->b is S(a)->S(b) and FF b->a is E(b)->E(a); SF a->b is S(a)->E(b) and SF b->a is S(b)->E(a): neither pair closes a loop.
        for ((label, first, second) in listOf(
            Triple("SS then FF", DependencyType.SS, DependencyType.FF),
            Triple("SF then SF", DependencyType.SF, DependencyType.SF),
        )) {
            val a = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
            val b = milestoneRef(TestPlan.milestone(w.projectId, t.teamId))
            val link = admin.postDependency(w.projectId, a, b, first)
            assertEquals(HttpStatusCode.Created, link.status, label)
            val revision = TestPlan.revision()
            val count = depCount()
            val reverse = admin.postDependency(w.projectId, b, a, second)
            assertEquals(HttpStatusCode.Conflict, reverse.status, label)
            val problem = reverse.problem()
            assertEquals("These two endpoints are already linked", problem.detail, label)
            assertEquals("about:blank", problem.type, "$label: not a cycle")
            assertNull(problem.cycle, label)
            assertEquals(revision, TestPlan.revision(), "$label: no bump")
            assertEquals(count, depCount(), "$label: nothing written")
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/dependencies/${link.body<DependencyResponse>().id}").status)
            val freed = admin.postDependency(w.projectId, b, a, second)
            assertEquals(HttpStatusCode.Created, freed.status, "$label: deleting the first freed the pair")
        }
    }

    @Test
    fun `a link that would close a cycle is 409 dependency-cycle with the path as data, writes nothing, no bump`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpy", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dpy")
        val admin = w.admin.client
        val nameOf = mutableMapOf<UInt, String>()
        suspend fun milestone(projectId: UInt, label: String): UInt {
            val name = planName(label)
            return TestPlan.milestone(projectId, t.teamId, name).also { nameOf[it] = name }
        }
        val a1 = milestone(w.projectId, "a1")
        val a2 = milestone(w.projectId, "a2")
        val a3 = milestone(w.projectId, "a3")
        val b1 = milestone(b.projectId, "b1")
        val projectA = admin.get("/api/v1/projects/${w.projectId}").body<ProjectResponse>().name

        suspend fun refused(
            label: String, projectId: UInt, pred: EndpointRef, succ: EndpointRef, type: DependencyType, path: List<String>,
        ) {
            val revision = TestPlan.revision()
            val count = depCount()
            val response = admin.postDependency(projectId, pred, succ, type)
            assertEquals(HttpStatusCode.Conflict, response.status, label)
            val problem = response.problem()
            val cycle: List<ProblemCycleNode> = checkNotNull(problem.cycle) { "$label: the cycle member is present" }
            assertEquals(DEPENDENCY_CYCLE_PROBLEM, problem.type, label)
            assertEquals(path, cycle.map { it.name }, "$label: the cycle, the first node repeated last")
            assertEquals("Adding this dependency would close a cycle: ${path.joinToString(" → ")}", problem.detail, label)
            assertEquals(cycle.first(), cycle.last(), label)
            assertEquals(revision, TestPlan.revision(), "$label: no bump")
            assertEquals(count, depCount(), "$label: nothing written")
        }
        val n = { id: UInt -> nameOf.getValue(id) }

        // The reverse of an existing pair.
        assertEquals(HttpStatusCode.Created, admin.postDependency(b.projectId, milestoneRef(a1), milestoneRef(b1)).status)
        refused("the reverse pair", w.projectId, milestoneRef(b1), milestoneRef(a1), DependencyType.FS, listOf(n(b1), n(a1), n(b1)))
        // A symmetric zero-lag pair is a cycle too: lags never enter the graph.
        val a2ToB1 = admin.postDependency(b.projectId, milestoneRef(a2), milestoneRef(b1), DependencyType.SS)
        assertEquals(HttpStatusCode.Created, a2ToB1.status)
        refused("start-to-start both ways", w.projectId, milestoneRef(b1), milestoneRef(a2), DependencyType.SS, listOf(n(b1), n(a2), n(b1)))
        // A milestone and its own project: the containment edges are part of the graph.
        val projectOfA = projectRef(w.projectId)
        refused("m FS its project", w.projectId, milestoneRef(a1), projectOfA, DependencyType.FS, listOf(n(a1), projectA, n(a1)))
        refused("its project FS m", w.projectId, projectOfA, milestoneRef(a1), DependencyType.FS, listOf(projectA, n(a1), projectA))
        // A cycle across two projects: a1 -> b1 exists; b1 -> a3 here, then a3 -> a1 would close it.
        assertEquals(HttpStatusCode.Created, admin.postDependency(w.projectId, milestoneRef(b1), milestoneRef(a3)).status)
        refused("a cycle across two projects", w.projectId, milestoneRef(a3), milestoneRef(a1), DependencyType.FS,
            listOf(n(a3), n(a1), n(b1), n(a3)))
        // Redundant with containment, harmless: a project that starts with its own milestone.
        val startsWith = admin.postDependency(w.projectId, projectRef(w.projectId), milestoneRef(a1), DependencyType.SS)
        assertEquals(HttpStatusCode.Created, startsWith.status, "p SS m inside its own project is allowed")
        // The successor project's own owner hits the same 409: the guard passed, the graph refuses.
        val byOwner = w.projectOwner.client.postDependency(w.projectId, milestoneRef(b1), milestoneRef(a1))
        assertEquals(HttpStatusCode.Conflict, byOwner.status)
        assertEquals(DEPENDENCY_CYCLE_PROBLEM, byOwner.problem().type)
    }

    @Test
    fun `reading a link is open to every authenticated user and 404 for unknown ids or when an end is gone`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpr", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dpr")
        val a1 = TestPlan.milestone(w.projectId, t.teamId)
        val b1 = TestPlan.milestone(b.projectId, t.teamId)
        val id = TestPlan.dependency(milestoneRef(a1), milestoneRef(b1))
        for ((label, caller) in w.outsiders + ("manager" to t.manager) + ("admin" to w.admin) + ("owner" to b.owner)) {
            val response = caller.client.get("/api/v1/dependencies/$id")
            assertEquals(HttpStatusCode.OK, response.status, label)
            assertEquals(id, response.body<DependencyResponse>().id)
        }
        assertEquals(HttpStatusCode.NotFound, w.stranger.client.get("/api/v1/dependencies/999999").status)
        // An end whose project is gone hides the link (a raw update: the API would cascade the link away).
        PostgresTestSupport.connect().use { it.exec("UPDATE projects SET marked_as_deleted = TRUE WHERE id = ?", w.projectId.toInt()) }
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get("/api/v1/dependencies/$id").status)
        // Leave nothing active under the raw-deleted project in the shared container: its milestones and links go too.
        PostgresTestSupport.connect().use {
            it.exec("UPDATE dependencies SET marked_as_deleted = TRUE WHERE id = ?", id.toInt())
            it.exec("UPDATE milestones SET marked_as_deleted = TRUE WHERE id = ?", a1.toInt())
        }
    }

    @Test
    fun `deleting a link needs an owner of the SUCCESSOR's project chain or ADMIN, not the predecessor's`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("dpx", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "dpx")
        val a1 = TestPlan.milestone(w.projectId, t.teamId)
        val b1 = TestPlan.milestone(b.projectId, t.teamId)
        val denied = listOf("the predecessor's project owner" to w.projectOwner, "a team manager" to t.manager) + w.outsiders
        val allowed = listOf(
            "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner, "successor project owner" to b.owner,
        )
        for ((label, caller) in allowed) {
            val id = TestPlan.dependency(milestoneRef(a1), milestoneRef(b1))
            for ((deniedLabel, outsider) in denied) {
                assertEquals(forbidden, outsider.client.delete("/api/v1/dependencies/$id").status, "$deniedLabel deleting for $label")
                val unknown = outsider.client.delete("/api/v1/dependencies/999999")
                assertEquals(HttpStatusCode.NotFound, unknown.status, "404 before 403: $deniedLabel")
            }
            assertEquals(HttpStatusCode.NoContent, caller.client.delete("/api/v1/dependencies/$id").status, label)
            assertEquals(HttpStatusCode.NotFound, caller.client.delete("/api/v1/dependencies/$id").status, "a second delete is 404")
            assertEquals(HttpStatusCode.NotFound, caller.client.get("/api/v1/dependencies/$id").status)
        }
        // A project-level successor: the same chain rule, so the PREDECESSOR project's owner is still refused.
        val id = TestPlan.dependency(projectRef(w.projectId), projectRef(b.projectId))
        assertEquals(forbidden, w.projectOwner.client.delete("/api/v1/dependencies/$id").status)
        assertEquals(HttpStatusCode.NoContent, b.owner.client.delete("/api/v1/dependencies/$id").status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get("/api/v1/dependencies/$id").status)
    }
}
