package ch.nokillswit

import ch.nokillswit.planning.MilestonePageResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.client.statement.bodyAsText
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /api/v1/milestones` (v0.4.0 C2, the milestone pickers' search; 1.30.0 removed everything no consumer used): any authenticated
 * user, paged per `list-endpoints.md`, the filters `name` (case- and accent-insensitive) and `projectId` (ANDed), the sorts `id`,
 * `name`, `createdAt` and `updatedAt`, the project's and team's name on every row, ACTIVE rows under an active project chain only.
 * The removed 1.27 filters (`scheduled`, `teamId`, `programId`, `workStreamId`) are ignored like any unknown parameter (API-LIST-004),
 * and the removed sort keys (`rankPosition`, `projectName`, `teamName`, `startDate`) and the row's `rankPosition` are gone. The plan
 * tables are SHARED suite state - every row carries a unique marker or a filter naming the test's own project, and every assertion
 * filters on it.
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
        assertEquals(badRequest, client.milestones("sort" to "endDate").status, "the end date is not sortable")
        assertEquals(badRequest, client.milestones("sort" to "-estimateMd").status, "the estimate is not sortable")
        for (removed in listOf("rankPosition", "-rankPosition", "projectName", "teamName", "-teamName", "startDate", "-startDate")) {
            assertEquals(badRequest, client.milestones("sort" to removed).status, "the removed sort key $removed is a 400")
        }
        assertEquals(badRequest, client.milestones("name" to "a", "name" to "b").status, "a repeated scalar key is a 400")
        assertEquals(badRequest, client.milestones("projectId" to "abc").status)
        assertEquals(badRequest, client.milestones("projectId" to "-1").status)
        assertEquals(badRequest, client.milestones("projectId" to "1", "projectId" to "1").status, "a repeated key is a 400")
        assertEquals(ok, client.milestones("projectId" to "").status, "a blank filter is absent")
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

    @Test
    fun `projectId narrows, combines with name, and an id that names nothing is an empty page, not a 404`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-narrow")
        val tag = marker()
        val team = TestTeams.seed(planName("ml-team"))
        val projectB = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val alpha = TestPlan.milestone(w.projectId, team, name = "Alpha $tag")
        val beta = TestPlan.milestone(w.projectId, team, name = "Beta $tag")
        val gamma = TestPlan.milestone(projectB, team, name = "Gamma $tag")
        val client = w.stranger.client

        fun ids(page: MilestonePageResponse) = page.items.map { it.id }.toSet()
        suspend fun ask(vararg params: Pair<String, String>) = client.milestones(*params, "sort" to "id").body<MilestonePageResponse>()

        assertEquals(setOf(alpha, beta), ids(ask("projectId" to "${w.projectId}", "name" to tag)))
        assertEquals(setOf(gamma), ids(ask("projectId" to "$projectB")))
        assertEquals(setOf(beta), ids(ask("projectId" to "${w.projectId}", "name" to "beta $tag")))
        assertEquals(emptySet(), ids(ask("projectId" to "$projectB", "name" to "beta $tag")), "the filters are ANDed")
        // `total` is counted after the filter, before the page.
        val firstPage = client.milestones("projectId" to "${w.projectId}", "pageSize" to "1").body<MilestonePageResponse>()
        assertEquals(1, firstPage.items.size)
        assertEquals(2L, firstPage.total)
        val nothing = client.milestones("projectId" to "2147483647")
        assertEquals(ok, nothing.status)
        assertEquals(0L, nothing.body<MilestonePageResponse>().total)
    }

    @Test
    fun `the removed 1_27 filters are ignored and list every milestone, the row has no rankPosition`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-removed")
        val tag = marker()
        val team = TestTeams.seed(planName("ml-team"))
        val open = TestPlan.milestone(w.projectId, team, name = "Open $tag")
        val dated = TestPlan.milestone(w.projectId, team, name = "Dated $tag")
        TestPlan.schedule(dated, "2027-03-01", "2027-03-05")
        val client = w.stranger.client

        // Unknown parameter names are ignored (API-LIST-004), even with a value that would once have been a 400 or matched nothing.
        val response = client.milestones(
            "name" to tag, "scheduled" to "yes", "teamId" to "abc", "programId" to "2147483647", "workStreamId" to "-1",
        )
        assertEquals(ok, response.status)
        val body = response.bodyAsText()
        val page = Json.decodeFromString<MilestonePageResponse>(body)
        assertEquals(setOf(open, dated), page.items.map { it.id }.toSet(), "no removed filter narrows the list")
        assertEquals(2L, page.total)
        val row = Json.parseToJsonElement(body).jsonObject.getValue("items").jsonArray.first().jsonObject
        assertEquals(
            setOf(
                "id", "projectId", "projectName", "name", "description", "teamId", "teamName", "estimateMd", "startDate", "endDate",
                "pinned", "createdAt", "updatedAt",
            ),
            row.keys,
            "rankPosition is gone from the row",
        )
    }

    @Test
    fun `a deleted project's milestones are absent under the project filter`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-del-filter")
        val teamId = TestTeams.seed(planName("ml-team"))
        val doomed = TestPlan.project(w.programId, w.projectOwner.personId!!)
        TestPlan.milestone(doomed, teamId, name = "Unscheduled ${marker()}")
        val dated = TestPlan.milestone(doomed, teamId, name = "Dated ${marker()}")
        TestPlan.schedule(dated, "2027-05-03", "2027-05-07")
        val client = w.stranger.client
        assertEquals(2L, client.milestones("projectId" to "$doomed").body<MilestonePageResponse>().total)

        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$doomed").status)
        assertEquals(0L, client.milestones("projectId" to "$doomed").body<MilestonePageResponse>().total)
    }
}
