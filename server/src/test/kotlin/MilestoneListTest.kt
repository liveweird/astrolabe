package ch.nokillswit

import ch.nokillswit.planning.MilestonePageResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /api/v1/milestones` (v0.4.0 C2, the dependency pickers' milestone search): any authenticated user, paged per
 * `list-endpoints.md`, one `name` filter (case- and accent-insensitive), the project's name on every row, ACTIVE rows under an active
 * project chain only. The plan tables are SHARED suite state - every row carries a unique marker and every assertion filters on it.
 */
class MilestoneListTest {
    private val ok = HttpStatusCode.OK
    private val badRequest = HttpStatusCode.BadRequest

    private fun marker() = UUID.randomUUID().toString().substring(0, 8)

    private suspend fun HttpClient.milestones(vararg params: Pair<String, String>): HttpResponse =
        get("/api/v1/milestones") { params.forEach { (key, value) -> url.parameters.append(key, value) } }

    @Test
    fun `an unauthenticated list is 401`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get("/api/v1/milestones").status)
    }

    @Test
    fun `any authenticated caller reads the list - the person-less and the stranger too`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-any")
        for ((who, caller) in w.outsiders + ("projectOwner" to w.projectOwner) + ("admin" to w.admin)) {
            assertEquals(ok, caller.client.milestones("pageSize" to "1").status, who)
        }
    }

    @Test
    fun `paging, sort and filter violations are 400`() = testApplication {
        usePostgresTestcontainer()
        val client = planCaller("ml-bad").client
        assertEquals(badRequest, client.milestones("page" to "0").status)
        assertEquals(badRequest, client.milestones("page" to "x").status)
        assertEquals(badRequest, client.milestones("pageSize" to "101").status)
        assertEquals(badRequest, client.milestones("pageSize" to "0").status)
        assertEquals(badRequest, client.milestones("sort" to "startDate").status, "the dates are not sortable")
        assertEquals(badRequest, client.milestones("sort" to "-projectName").status, "the joined name is not sortable")
        assertEquals(badRequest, client.milestones("name" to "a", "name" to "b").status, "a repeated scalar key is a 400")
    }

    @Test
    fun `the name filter is case- and accent-insensitive and total is counted after it`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-filter")
        val teamId = TestTeams.seed(planName("ml-team"))
        val tag = marker()
        val zolw = TestPlan.milestone(w.projectId, teamId, name = "Żółw $tag")
        val plain = TestPlan.milestone(w.projectId, teamId, name = "Zolw $tag two")
        TestPlan.milestone(w.projectId, teamId, name = "Other ${marker()}")
        val client = w.stranger.client

        val byAscii = client.milestones("name" to "zolw $tag", "sort" to "id").body<MilestonePageResponse>()
        assertEquals(listOf(zolw, plain), byAscii.items.map { it.id })
        assertEquals(2L, byAscii.total)
        val byUpper = client.milestones("name" to "ŻÓŁW $tag").body<MilestonePageResponse>()
        assertEquals(setOf(zolw, plain), byUpper.items.map { it.id }.toSet())
        // `total` is after the filter and before pagination.
        val firstPage = client.milestones("name" to tag, "pageSize" to "1").body<MilestonePageResponse>()
        assertEquals(1, firstPage.items.size)
        assertEquals(2L, firstPage.total)
        assertEquals(1, firstPage.pageSize)
        val secondPage = client.milestones("name" to tag, "pageSize" to "1", "page" to "2").body<MilestonePageResponse>()
        assertEquals(listOf(plain), secondPage.items.map { it.id })
        // LIKE metacharacters in the filter are literals, a blank filter is no filter.
        assertEquals(0L, client.milestones("name" to "$tag%").body<MilestonePageResponse>().total)
        assertTrue(client.milestones("name" to "  ").body<MilestonePageResponse>().total >= 3)
    }

    @Test
    fun `rows carry the project name, the team and the schedule - the same name in two projects is told apart`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-names")
        val tag = marker()
        val teamName = planName("ml-team")
        val teamId = TestTeams.seed(teamName)
        val projectA = TestPlan.project(w.programId, w.projectOwner.personId!!, name = "Alpha $tag")
        val projectB = TestPlan.project(w.programId, w.projectOwner.personId, name = "Beta $tag")
        val designA = TestPlan.milestone(projectA, teamId, name = "Design $tag", estimate = 3.5)
        val designB = TestPlan.milestone(projectB, teamId, name = "Design $tag")
        TestPlan.schedule(designA, "2027-02-01", "2027-02-05")

        val items = w.stranger.client.milestones("name" to "design $tag", "sort" to "id").body<MilestonePageResponse>().items
        assertEquals(listOf(designA, designB), items.map { it.id })
        assertEquals(listOf("Alpha $tag", "Beta $tag"), items.map { it.projectName })
        assertEquals(listOf(projectA, projectB), items.map { it.projectId })
        val first = items.first()
        assertEquals(teamId, first.teamId)
        assertEquals(teamName, first.teamName)
        assertEquals(3.5, first.estimateMd)
        assertEquals("2027-02-01", first.startDate)
        assertEquals("2027-02-05", first.endDate)
        assertNull(items.last().startDate, "an unscheduled milestone lists with no dates")
        assertNull(first.description)
    }

    @Test
    fun `the default sort is id ascending and the explicit sorts apply`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-sort")
        val teamId = TestTeams.seed(planName("ml-team"))
        val tag = marker()
        val b = TestPlan.milestone(w.projectId, teamId, name = "B $tag")
        val a = TestPlan.milestone(w.projectId, teamId, name = "A $tag")
        val c = TestPlan.milestone(w.projectId, teamId, name = "C $tag")
        val client = w.stranger.client

        assertEquals(listOf(b, a, c), client.milestones("name" to tag).body<MilestonePageResponse>().items.map { it.id })
        assertEquals(listOf(a, b, c), client.milestones("name" to tag, "sort" to "name").body<MilestonePageResponse>().items.map { it.id })
        assertEquals(listOf(c, b, a), client.milestones("name" to tag, "sort" to "-name").body<MilestonePageResponse>().items.map { it.id })
        // createdAt/updatedAt may tie within a millisecond (the id tiebreaker then orders the tie): the whitelist is what is pinned.
        for (field in listOf("createdAt", "-createdAt", "updatedAt", "-updatedAt")) {
            val ids = client.milestones("name" to tag, "sort" to field).body<MilestonePageResponse>().items.map { it.id }
            assertEquals(setOf(a, b, c), ids.toSet(), field)
        }
    }

    @Test
    fun `a deleted milestone and the milestones of a deleted project are absent`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-del")
        val teamId = TestTeams.seed(planName("ml-team"))
        val tag = marker()
        val kept = TestPlan.milestone(w.projectId, teamId, name = "Kept $tag")
        val gone = TestPlan.milestone(w.projectId, teamId, name = "Gone $tag")
        val owner = w.projectOwner.personId!!
        val otherProject = TestPlan.project(w.programId, owner)
        val inOther = TestPlan.milestone(otherProject, teamId, name = "Other $tag")
        val client = w.stranger.client
        assertEquals(setOf(kept, gone, inOther), client.milestones("name" to tag).body<MilestonePageResponse>().items.map { it.id }.toSet())

        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/milestones/$gone").status)
        val afterMilestone = client.milestones("name" to tag).body<MilestonePageResponse>()
        assertEquals(setOf(kept, inOther), afterMilestone.items.map { it.id }.toSet())
        assertEquals(2L, afterMilestone.total)

        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$otherProject").status)
        val afterProject = client.milestones("name" to tag).body<MilestonePageResponse>()
        assertEquals(listOf(kept), afterProject.items.map { it.id })
        assertEquals(1L, afterProject.total)
    }
}
