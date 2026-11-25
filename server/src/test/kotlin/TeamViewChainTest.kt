package ch.nokillswit

import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.planning.DependencyType
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.PlanActor
import ch.nokillswit.planning.TeamView
import ch.nokillswit.planning.TeamViewService
import ch.nokillswit.planning.UNKNOWN_BASELINE_PROBLEM
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/team/{id}?criticalChain=true` (1.27): the critical chain through the team's milestones as ghost members of other teams.
 * The kernel's vectors are `CriticalChainKernelsTest`'s and the assembly's `TeamCriticalChainTest`'s; here the block is read through
 * the wire: the world is x1 (team X) -> y1 (team X) -> p1 (the viewed team P), with s1 (team X, the sibling of p1: it ends P too and
 * y1 drives it) beside it. 2027-02-01 is a Monday; the weeks are Feb 1-5, 8-12 and 15-19.
 */
class TeamViewChainTest {
    private fun path(teamId: UInt) = "/api/v1/views/team/$teamId"

    private fun chainPath(teamId: UInt) = "${path(teamId)}?criticalChain=true"

    private class Chain(
        val w: PlanWorld, val teamP: UInt, val teamX: UInt, val projectX: UInt, val projectY: UInt,
        val x1: UInt, val y1: UInt, val p1: UInt, val s1: UInt, val xy: UInt, val yp: UInt, val ys: UInt,
    )

    private suspend fun scheduled(project: UInt, team: UInt, name: String, week: Pair<String, String>): UInt =
        TestPlan.milestone(project, team, name).also { TestPlan.schedule(it, week.first, week.second) }

    private val week1 = "2027-02-01" to "2027-02-05"
    private val week2 = "2027-02-08" to "2027-02-12"
    private val week3 = "2027-02-15" to "2027-02-19"

    private suspend fun ApplicationTestBuilder.chain(prefix: String): Chain {
        val w = planWorld(prefix, teams = true)
        val t = w.requireTeams()
        val x = secondProject(w, "$prefix-x")
        val y = secondProject(w, "$prefix-y")
        val x1 = scheduled(x.projectId, t.otherTeamId, "x1", week1)
        val y1 = scheduled(y.projectId, t.otherTeamId, "y1", week2)
        val p1 = scheduled(w.projectId, t.teamId, "p1", week3)
        val s1 = scheduled(w.projectId, t.otherTeamId, "s1", week3)
        return Chain(
            w, t.teamId, t.otherTeamId, x.projectId, y.projectId, x1, y1, p1, s1,
            xy = TestPlan.dependency(milestoneRef(x1), milestoneRef(y1)),
            yp = TestPlan.dependency(milestoneRef(y1), milestoneRef(p1)),
            ys = TestPlan.dependency(milestoneRef(y1), milestoneRef(s1)),
        )
    }

    private suspend fun HttpClient.chainView(teamId: UInt): TeamView = get(chainPath(teamId)).body()

    @Test
    fun `the block lists the members of other teams nearest first, and the links between two of them only`() = testApplication {
        usePostgresTestcontainer()
        val c = chain("tvch1")
        val view = c.w.admin.client.chainView(c.teamP)
        val block = assertNotNull(view.criticalChain)

        assertEquals(listOf(c.y1, c.x1), block.members.map { it.id })
        assertEquals(listOf(1, 2), block.members.map { it.hops })
        assertEquals(listOf(listOf(c.w.projectId), listOf(c.w.projectId)), block.members.map { it.chainOf })
        val y1 = block.members.first()
        assertEquals(EndpointKind.MILESTONE, y1.kind)
        assertEquals(listOf("y1", c.projectY, c.teamX), listOf(y1.name, y1.projectId, y1.teamId))
        assertEquals(c.w.admin.client.get(path(c.teamX)).body<TeamView>().team.name, y1.teamName)
        assertEquals("2027-02-08" to "2027-02-12", y1.startDate to y1.endDate)
        assertFalse(block.truncated)

        // x1 -> y1 touches none of the team's milestones: only the block holds it. y1 -> p1 ends at the team's p1: it is a
        // dependencies[] row with critical true and is not repeated.
        assertEquals(listOf(c.xy), block.links.map { it.id })
        val link = block.links.single()
        assertEquals(milestoneRef(c.x1) to milestoneRef(c.y1), link.predecessor to link.successor)
        assertEquals(DependencyType.FS to 0, link.type to link.lagDays)
        assertEquals(listOf(c.yp), view.dependencies.map { it.id })
        assertTrue(view.dependencies.single().critical)
    }

    @Test
    fun `a sibling branch that p1 does not drive is left out, and so is the link into it`() = testApplication {
        usePostgresTestcontainer()
        val c = chain("tvch2")
        val block = assertNotNull(c.w.admin.client.chainView(c.teamP).criticalChain)
        assertFalse(c.s1 in block.members.map { it.id }, "s1 ends P and y1 drives it, but no zero-slack path leads through p1 to it")
        assertFalse(c.ys in block.links.map { it.id })
        // Team X owns x1, y1 and s1: its chain through y1 reaches P's end by BOTH p1 and s1, and p1 is the one milestone of another team.
        val other = assertNotNull(c.w.admin.client.chainView(c.teamX).criticalChain)
        assertEquals(listOf(c.p1), other.members.map { it.id })
        assertEquals(emptyList(), other.links, "y1 -> p1 has an end among team X's milestones")
    }

    @Test
    fun `the team's own milestones are never members, whatever the chain through them`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tvch3", teams = true)
        val t = w.requireTeams()
        val x = secondProject(w, "tvch3-x")
        val a1 = scheduled(x.projectId, t.otherTeamId, "a1", week1)
        val p1 = scheduled(w.projectId, t.teamId, "p1", week2)
        val p2 = scheduled(w.projectId, t.teamId, "p2", week3)
        val ap = TestPlan.dependency(milestoneRef(a1), milestoneRef(p1))
        val pp = TestPlan.dependency(milestoneRef(p1), milestoneRef(p2))
        val view = w.admin.client.chainView(t.teamId)
        val block = assertNotNull(view.criticalChain)
        assertEquals(listOf(a1), block.members.map { it.id })
        assertEquals(emptyList(), block.links, "both links have an end among the team's milestones")
        assertEquals(setOf(ap, pp), view.dependencies.map { it.id }.toSet())
        assertTrue(view.dependencies.all { it.critical })
    }

    @Test
    fun `a whole project named by a chain link is a member, and the milestone met only through containment is not`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tvch4", teams = true)
        val t = w.requireTeams()
        val x = secondProject(w, "tvch4-x")
        val v = secondProject(w, "tvch4-v")
        val x1 = scheduled(x.projectId, t.otherTeamId, "x1", week1)
        val v1 = scheduled(v.projectId, t.otherTeamId, "v1", week2)
        val p1 = scheduled(w.projectId, t.teamId, "p1", week3)
        val intoProject = TestPlan.dependency(milestoneRef(x1), projectRef(v.projectId))
        val outOfProject = TestPlan.dependency(projectRef(v.projectId), milestoneRef(p1))
        val view = w.admin.client.chainView(t.teamId)
        val block = assertNotNull(view.criticalChain)

        assertEquals(listOf(EndpointKind.PROJECT to v.projectId, EndpointKind.MILESTONE to x1), block.members.map { it.kind to it.id })
        assertFalse(v1 in block.members.map { it.id })
        val project = block.members.first()
        assertEquals(listOf(1, 2), block.members.map { it.hops })
        assertEquals(listOf(v.projectId, null, null), listOf(project.projectId, project.teamId, project.teamName))
        assertEquals("2027-02-08" to "2027-02-12", project.startDate to project.endDate, "the project's derived span")
        assertEquals(listOf(intoProject), block.links.map { it.id })
        assertEquals(listOf(outOfProject), view.dependencies.map { it.id })
    }

    @Test
    fun `a member on the chains of two of the team's projects is one row naming both`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tvch5", teams = true)
        val t = w.requireTeams()
        val b = secondProject(w, "tvch5-b")
        val x = secondProject(w, "tvch5-x")
        val a1 = scheduled(x.projectId, t.otherTeamId, "a1", week1)
        val pa = scheduled(w.projectId, t.teamId, "pa", week2)
        val pb = scheduled(b.projectId, t.teamId, "pb", week2)
        TestPlan.dependency(milestoneRef(a1), milestoneRef(pa))
        TestPlan.dependency(milestoneRef(a1), milestoneRef(pb))
        val block = assertNotNull(w.admin.client.chainView(t.teamId).criticalChain)
        val member = block.members.single()
        assertEquals(listOf(a1, 1), listOf(member.id, member.hops))
        assertEquals(listOf(w.projectId, b.projectId).sorted(), member.chainOf)
        assertEquals(emptyList(), block.links, "each link ends at one of the team's milestones")
    }

    @Test
    fun `a small cap cuts the far end and says so, and the links that lost an end go with it`() = testApplication {
        usePostgresTestcontainer()
        val c = chain("tvch6")
        val admin = PlanActor(isAdmin = true, personId = null, roadmapEditor = false, managedTeamIds = emptySet())
        val one = assertNotNull(TeamViewService(sharedDatabaseForTests(), maxChainMembers = 1).view(c.teamP, admin, criticalChain = true))
        val cutMembers = assertNotNull(one.criticalChain)
        assertEquals(listOf(c.y1), cutMembers.members.map { it.id })
        assertEquals(emptyList(), cutMembers.links, "x1 -> y1 lost x1")
        assertTrue(cutMembers.truncated)
        val noLinks = assertNotNull(TeamViewService(sharedDatabaseForTests(), maxChainLinks = 0).view(c.teamP, admin, criticalChain = true))
        assertEquals(listOf(c.y1, c.x1), noLinks.criticalChain?.members?.map { it.id })
        assertEquals(emptyList(), noLinks.criticalChain?.links)
        assertEquals(true, noLinks.criticalChain?.truncated)
        val plain = assertNotNull(TeamViewService(sharedDatabaseForTests(), maxChainMembers = 1).view(c.teamP, admin))
        assertNull(plain.criticalChain, "no parameter, no block, whatever the caps")
    }

    @Test
    fun `without the parameter the document has no criticalChain key, and with it the document is the same plus that key`() =
        testApplication {
            usePostgresTestcontainer()
            val c = chain("tvch7")
            val client = c.w.admin.client
            val plain = client.get(path(c.teamP)).bodyAsText()
            assertFalse(plain.contains("criticalChain"))
            for (same in listOf("false", "")) {
                val answer = client.get("${path(c.teamP)}?criticalChain=$same").bodyAsText()
                assertEquals(plain, answer, "?criticalChain=$same is the plain document")
            }
            val with = client.rawJson(chainPath(c.teamP)).jsonObject
            assertEquals(client.rawJson(path(c.teamP)), JsonObject(with.filterKeys { it != "criticalChain" }))
            assertTrue("criticalChain" in with)
        }

    @Test
    fun `the block is the same for every caller`() = testApplication {
        usePostgresTestcontainer()
        val c = chain("tvch8")
        val t = c.w.requireTeams()
        val callers = listOf(c.w.admin, c.w.stranger, c.w.personless, c.w.editor, t.manager, t.otherManager, c.w.projectOwner)
        val blocks = callers.map { it.client.rawJson(chainPath(c.teamP)).jsonObject.getValue("criticalChain") }
        assertEquals(1, blocks.distinct().size, "no member of the block depends on who asks")
    }

    @Test
    fun `with a baseline the document holds both blocks, and the chain block does not change`() = testApplication {
        usePostgresTestcontainer()
        val c = chain("tvch9")
        val client = c.w.admin.client
        val baselineId = TestPlan.baseline()
        try {
            val chainOnly = client.rawJson(chainPath(c.teamP))
            val both = client.rawJson("${chainPath(c.teamP)}&baseline=$baselineId")
            assertTrue(both.hasBaselineKey() && "criticalChain" in both.jsonObject)
            assertEquals(chainOnly, both.withoutBaseline(), "the baseline adds its own keys and nothing else")
        } finally {
            TestPlan.deleteBaseline(baselineId)
        }
    }

    @Test
    fun `a team with no milestones answers an empty block`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("tvch10")
        val empty = TestTeams.seed(planName("tvch10-empty"), null)
        val block = assertNotNull(w.admin.client.chainView(empty).criticalChain)
        assertEquals(emptyList(), block.members)
        assertEquals(emptyList(), block.links)
        assertFalse(block.truncated)
    }

    @Test
    fun `the parameter is strict, read before the team's 404 and the baseline, after the 401`() = testApplication {
        usePostgresTestcontainer()
        val c = chain("tvch11")
        val client = c.w.admin.client
        for (bad in listOf("maybe", "1", "TRUE", "yes", "true&criticalChain=true", "true&criticalChain=false")) {
            val response = client.get("${path(c.teamP)}?criticalChain=$bad")
            assertEquals(HttpStatusCode.BadRequest, response.status, "?criticalChain=$bad")
            assertEquals("about:blank", response.body<ProblemDetail>().type, "?criticalChain=$bad is a plain 400")
        }
        val gone = client.get("${path(MISSING_TEAM)}?criticalChain=maybe")
        assertEquals(HttpStatusCode.BadRequest, gone.status, "the parameter before the 404")
        assertEquals(HttpStatusCode.NotFound, client.get("${path(MISSING_TEAM)}?criticalChain=true").status)
        val unknownBaseline = client.get("${chainPath(c.teamP)}&baseline=$MISSING_TEAM")
        assertEquals(HttpStatusCode.BadRequest, unknownBaseline.status)
        assertEquals(UNKNOWN_BASELINE_PROBLEM, unknownBaseline.body<ProblemDetail>().type, "a valid chain parameter, an unknown baseline")
        val both = client.get("${path(c.teamP)}?criticalChain=maybe&baseline=$MISSING_TEAM")
        assertEquals("about:blank", both.body<ProblemDetail>().type, "the malformed chain parameter comes first")
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get("${path(c.teamP)}?criticalChain=maybe").status)
    }

    private companion object {
        /** An id no row of the shared database reaches (the sequences are far below it). */
        const val MISSING_TEAM = 999_999_999u
    }
}
