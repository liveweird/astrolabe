package ch.nokillswit

import ch.nokillswit.planning.ProgramsView
import ch.nokillswit.planning.RoadmapCriticalPair
import ch.nokillswit.planning.RoadmapCriticalProject
import ch.nokillswit.planning.RoadmapView
import ch.nokillswit.planning.UNKNOWN_BASELINE_PROBLEM
import ch.nokillswit.plugins.ProblemDetail
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/programs?criticalPath=N` (1.16): the SAME block as `GET /views/roadmap?criticalPath=N` (one shared step over the same
 * snapshot rows), present only with the parameter, with the roadmap's plain `400`s. The chain world is the roadmap test's own: every
 * project and milestone here is this test's, and the block is a function of the target's upstream chain alone, so rows other classes
 * left in the shared database cannot move it (the plain-versus-picked comparison reads the same plan twice). 2027-02-01 is a Monday.
 */
class ProgramsViewCriticalPathTest {
    private val programsPath = "/api/v1/views/programs"
    private val roadmapPath = "/api/v1/views/roadmap"

    /**
     * x1 -> y1 -> p1 (projects X, Y, P; one week each) and z1, a week ahead of p1's start (five working days of slack on z1 -> p1).
     * [empty] is a project with nothing scheduled.
     */
    private class Chain(val x: UInt, val y: UInt, val p: UInt, val z: UInt, val empty: UInt)

    private suspend fun PlanWorld.chain(): Chain {
        val t = requireTeams()
        val owner = projectOwner.personId!!
        val ids = List(5) { TestPlan.project(programId, owner, planName("cp$it")) }
        val (x, y, p) = ids
        val (z, empty) = ids.drop(3)
        suspend fun at(project: UInt, start: String, end: String): UInt =
            TestPlan.milestone(project, t.teamId).also { TestPlan.schedule(it, start, end) }
        val x1 = at(x, "2027-02-01", "2027-02-05")
        val y1 = at(y, "2027-02-08", "2027-02-12")
        val p1 = at(p, "2027-02-15", "2027-02-19")
        val z1 = at(z, "2027-02-01", "2027-02-05")
        TestPlan.milestone(empty, t.teamId)
        TestPlan.dependency(milestoneRef(x1), milestoneRef(y1))
        TestPlan.dependency(milestoneRef(y1), milestoneRef(p1))
        TestPlan.dependency(milestoneRef(z1), milestoneRef(p1))
        return Chain(x, y, p, z, empty)
    }

    private fun JsonElement.withoutCriticalPath(): JsonElement = JsonObject((this as JsonObject).filterKeys { it != "criticalPath" })

    private suspend fun HttpClient.programsBlock(target: UInt) = get("$programsPath?criticalPath=$target").body<ProgramsView>().criticalPath

    private suspend fun HttpClient.roadmapBlock(target: UInt) = get("$roadmapPath?criticalPath=$target").body<RoadmapView>().criticalPath

    @Test
    fun `the block equals the roadmap's for the same target, for every kind of caller`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvcp-eq", teams = true)
        val c = w.chain()
        for (caller in listOf(w.stranger, w.personless, w.admin)) {
            val client = caller.client
            val block = assertNotNull(client.programsBlock(c.p), "the programs view answers the block")
            assertEquals(client.roadmapBlock(c.p), block, "the roadmap's block for the same target")
            assertEquals(c.p, block.projectId)
            assertEquals(
                listOf(
                    RoadmapCriticalProject(c.y, 0, true, 1),
                    RoadmapCriticalProject(c.z, 5, false, 1),
                    RoadmapCriticalProject(c.x, 0, true, 2),
                ),
                block.projects,
                "the target is implied; Z has slack and is off the chain",
            )
            assertEquals(
                listOf(RoadmapCriticalPair(c.x, c.y), RoadmapCriticalPair(c.y, c.p))
                    .sortedWith(compareBy({ it.predecessorProjectId }, { it.successorProjectId })),
                block.pairs,
            )
        }
        // Another target of the same plan: Y's chain is X alone.
        val toY = assertNotNull(w.stranger.client.programsBlock(c.y))
        assertEquals(w.stranger.client.roadmapBlock(c.y), toY)
        assertEquals(listOf(RoadmapCriticalProject(c.x, 0, true, 1)), toY.projects)
        assertEquals(listOf(RoadmapCriticalPair(c.x, c.y)), toY.pairs)
    }

    @Test
    fun `a target with nothing scheduled answers empty lists, and one upstream of nothing has no chain - as the roadmap does`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pvcp-empty", teams = true)
            val c = w.chain()
            val client = w.stranger.client
            val empty = assertNotNull(client.programsBlock(c.empty))
            assertEquals(c.empty, empty.projectId)
            assertTrue(empty.projects.isEmpty() && empty.pairs.isEmpty(), "nothing scheduled: both lists empty")
            assertEquals(client.roadmapBlock(c.empty), empty)

            val first = assertNotNull(client.programsBlock(c.x))
            assertTrue(first.projects.isEmpty() && first.pairs.isEmpty(), "nothing is upstream of the first project")
            assertEquals(client.roadmapBlock(c.x), first)
        }

    @Test
    fun `without the parameter there is no criticalPath key, with it the plain document plus that key`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvcp-add", teams = true)
        val c = w.chain()
        val client = w.stranger.client
        val plain = client.rawJson(programsPath)
        assertFalse((plain as JsonObject).containsKey("criticalPath"), "the plain document is exactly what it was")
        val picked = client.rawJson("$programsPath?criticalPath=${c.p}")
        assertTrue((picked as JsonObject).containsKey("criticalPath"))
        assertEquals(plain, picked.withoutCriticalPath(), "the parameter only adds the block")
    }

    @Test
    fun `a blank criticalPath means absent - the plain document without the block`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvcp-blank", teams = true)
        w.chain()
        val client = w.stranger.client
        val blank = client.get("$programsPath?criticalPath=")
        assertEquals(HttpStatusCode.OK, blank.status)
        assertNull(blank.body<ProgramsView>().criticalPath)
        assertFalse((client.rawJson("$programsPath?criticalPath=") as JsonObject).containsKey("criticalPath"))
    }

    @Test
    fun `criticalPath is refused with a plain 400 - malformed, repeated, unknown, deleted`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvcp-400", teams = true)
        val c = w.chain()
        val client = w.stranger.client
        for (malformed in listOf("abc", "-1", "1.5", "99999999999", "${c.p}&criticalPath=${c.x}")) {
            val response = client.get("$programsPath?criticalPath=$malformed")
            assertEquals(HttpStatusCode.BadRequest, response.status, "?criticalPath=$malformed")
            assertEquals("about:blank", response.body<ProblemDetail>().type, "?criticalPath=$malformed is a plain 400")
        }
        val unknown = client.get("$programsPath?criticalPath=999999")
        assertEquals(HttpStatusCode.BadRequest, unknown.status)
        val unknownProblem = unknown.body<ProblemDetail>()
        assertEquals("about:blank", unknownProblem.type)
        assertEquals("Unknown or deleted project id: 999999", unknownProblem.detail)

        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/projects/${c.z}").status)
        val gone = client.get("$programsPath?criticalPath=${c.z}")
        assertEquals(HttpStatusCode.BadRequest, gone.status, "a soft-deleted project")
        assertEquals("Unknown or deleted project id: ${c.z}", gone.body<ProblemDetail>().detail)
        // A deleted project leaves the chain of the others: Z's link is gone with it.
        val toP = assertNotNull(client.programsBlock(c.p))
        assertEquals(listOf(c.y, c.x), toP.projects.map { it.projectId })
    }

    @Test
    fun `with a baseline both blocks are present, and a bad baseline is answered before an unknown criticalPath`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pvcp-bl", teams = true)
        val c = w.chain()
        val client = w.stranger.client

        val unknownBaseline = client.get("$programsPath?baseline=999999&criticalPath=999999")
        assertEquals(HttpStatusCode.BadRequest, unknownBaseline.status)
        assertEquals(UNKNOWN_BASELINE_PROBLEM, unknownBaseline.body<ProblemDetail>().type, "the baseline's typed problem comes first")

        val id = TestPlan.baseline()
        try {
            val both = client.get("$programsPath?baseline=$id&criticalPath=${c.p}").body<ProgramsView>()
            assertNotNull(both.baseline, "the baseline block")
            assertEquals(c.p, assertNotNull(both.criticalPath, "and the chain").projectId)
            assertEquals(client.roadmapBlock(c.p), both.criticalPath, "the same block as without the baseline")
            assertEquals(
                client.get("$programsPath?baseline=$id").body<ProgramsView>().copy(criticalPath = null),
                both.copy(criticalPath = null),
                "independent blocks",
            )

            // A known baseline beside an unknown project is the plain 400 of the project id.
            val unknownProject = client.get("$programsPath?baseline=$id&criticalPath=999999")
            assertEquals(HttpStatusCode.BadRequest, unknownProject.status)
            assertEquals("about:blank", unknownProject.body<ProblemDetail>().type)
        } finally {
            TestPlan.deleteBaseline(id)
        }
        val deletedBaseline = client.get("$programsPath?baseline=$id&criticalPath=999999")
        assertEquals(HttpStatusCode.BadRequest, deletedBaseline.status)
        assertEquals(UNKNOWN_BASELINE_PROBLEM, deletedBaseline.body<ProblemDetail>().type, "a deleted baseline, beside an unknown project")
    }
}
