package ch.nokillswit

import ch.nokillswit.planning.HomeView
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
 * `GET /api/v1/milestones` (v0.4.0 C2, the dependency pickers' milestone search; 1.19.0 C2, the Milestones page's list): any
 * authenticated user, paged per `list-endpoints.md`, the filters `name` (case- and accent-insensitive), `scheduled`, `teamId` and
 * `projectId` (ANDed), the sorts `projectName` and `teamName`, the project's and team's name on every row, ACTIVE rows under an active
 * project chain only. The plan tables are SHARED suite state - every row carries a unique marker or a filter naming the test's own
 * team or project, and every assertion filters on it (a plan-wide figure is compared with another read of the same test).
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
        assertEquals(badRequest, client.milestones("sort" to "-estimateMd").status, "the estimate is not sortable")
        assertEquals(badRequest, client.milestones("name" to "a", "name" to "b").status, "a repeated scalar key is a 400")
        assertEquals(badRequest, client.milestones("scheduled" to "yes").status, "scheduled is a strict boolean")
        assertEquals(badRequest, client.milestones("scheduled" to "TRUE").status, "scheduled is a strict boolean")
        assertEquals(badRequest, client.milestones("teamId" to "abc").status)
        assertEquals(badRequest, client.milestones("projectId" to "-1").status)
        assertEquals(badRequest, client.milestones("scheduled" to "true", "scheduled" to "true").status, "a repeated key is a 400")
        assertEquals(badRequest, client.milestones("teamId" to "1", "teamId" to "1").status, "a repeated key is a 400")
        assertEquals(badRequest, client.milestones("projectId" to "1", "projectId" to "1").status, "a repeated key is a 400")
        assertEquals(ok, client.milestones("scheduled" to "", "teamId" to "", "projectId" to "").status, "blank filters are absent")
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
    fun `scheduled splits the milestones of a project exactly, and the two totals add up to the unfiltered one`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-sched")
        val teamId = TestTeams.seed(planName("ml-team"))
        val open1 = TestPlan.milestone(w.projectId, teamId, name = "Open one ${marker()}")
        val open2 = TestPlan.milestone(w.projectId, teamId, name = "Open two ${marker()}")
        val done = TestPlan.milestone(w.projectId, teamId, name = "Done ${marker()}")
        TestPlan.schedule(done, "2027-03-01", "2027-03-05")
        val client = w.stranger.client
        val project = "projectId" to w.projectId.toString()

        val unscheduled = client.milestones(project, "scheduled" to "false", "sort" to "id").body<MilestonePageResponse>()
        assertEquals(listOf(open1, open2), unscheduled.items.map { it.id })
        assertEquals(2L, unscheduled.total)
        assertTrue(unscheduled.items.all { it.startDate == null && it.endDate == null })
        val scheduled = client.milestones(project, "scheduled" to "true").body<MilestonePageResponse>()
        assertEquals(listOf(done), scheduled.items.map { it.id })
        assertEquals(1L, scheduled.total)
        val all = client.milestones(project).body<MilestonePageResponse>()
        assertEquals(3L, all.total)
        assertEquals(all.total, unscheduled.total + scheduled.total)
        // Unscheduling moves a milestone to the other side of the split.
        TestPlan.schedule(done, null, null)
        assertEquals(3L, client.milestones(project, "scheduled" to "false").body<MilestonePageResponse>().total)
        assertEquals(0L, client.milestones(project, "scheduled" to "true").body<MilestonePageResponse>().total)
    }

    @Test
    fun `teamId and projectId narrow and combine with each other, with scheduled and with name`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-narrow")
        val tag = marker()
        val teamA = TestTeams.seed(planName("ml-team-a"))
        val teamB = TestTeams.seed(planName("ml-team-b"))
        val owner = w.projectOwner.personId!!
        val projectB = TestPlan.project(w.programId, owner)
        val aInOne = TestPlan.milestone(w.projectId, teamA, name = "Alpha $tag")
        val bInOne = TestPlan.milestone(w.projectId, teamB, name = "Beta $tag")
        val aInTwo = TestPlan.milestone(projectB, teamA, name = "Gamma $tag")
        TestPlan.schedule(aInTwo, "2027-04-05", "2027-04-09")
        val client = w.stranger.client

        fun ids(page: MilestonePageResponse) = page.items.map { it.id }.toSet()
        suspend fun ask(vararg params: Pair<String, String>) = client.milestones(*params, "sort" to "id").body<MilestonePageResponse>()

        assertEquals(setOf(aInOne, aInTwo), ids(ask("teamId" to "$teamA")))
        assertEquals(setOf(bInOne), ids(ask("teamId" to "$teamB")))
        assertEquals(setOf(aInOne, bInOne), ids(ask("projectId" to "${w.projectId}")))
        assertEquals(setOf(aInTwo), ids(ask("projectId" to "$projectB")))
        assertEquals(setOf(aInOne), ids(ask("teamId" to "$teamA", "projectId" to "${w.projectId}")))
        assertEquals(setOf(aInOne), ids(ask("teamId" to "$teamA", "scheduled" to "false")))
        assertEquals(setOf(aInTwo), ids(ask("teamId" to "$teamA", "scheduled" to "true")))
        assertEquals(emptySet(), ids(ask("teamId" to "$teamB", "projectId" to "$projectB")))
        assertEquals(setOf(aInOne), ids(ask("teamId" to "$teamA", "projectId" to "${w.projectId}", "scheduled" to "false", "name" to tag)))
        assertEquals(emptySet(), ids(ask("teamId" to "$teamA", "name" to "beta $tag")))
        // `total` is counted after the new filters too, before the page.
        val firstPage = client.milestones("teamId" to "$teamA", "pageSize" to "1").body<MilestonePageResponse>()
        assertEquals(1, firstPage.items.size)
        assertEquals(2L, firstPage.total)
    }

    @Test
    fun `an id that names nothing is an empty page, not a 404`() = testApplication {
        usePostgresTestcontainer()
        val client = planCaller("ml-nothing").client
        for (param in listOf("teamId", "projectId")) {
            val response = client.milestones(param to "2147483647")
            assertEquals(ok, response.status, param)
            val page = response.body<MilestonePageResponse>()
            assertEquals(0L, page.total, param)
            assertTrue(page.items.isEmpty(), param)
        }
    }

    @Test
    fun `sort by the project's and the team's name, with the id as the tiebreaker`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-names-sort")
        val tag = marker()
        val owner = w.projectOwner.personId!!
        val projectAlpha = TestPlan.project(w.programId, owner, name = "Alpha $tag")
        val projectBeta = TestPlan.project(w.programId, owner, name = "Beta $tag")
        val teamZulu = TestTeams.seed("Zulu $tag")
        val teamMike = TestTeams.seed("Mike $tag")
        val first = TestPlan.milestone(projectAlpha, teamZulu, name = "M1 $tag")
        val second = TestPlan.milestone(projectBeta, teamMike, name = "M2 $tag")
        val third = TestPlan.milestone(projectAlpha, teamMike, name = "M3 $tag")
        val client = w.stranger.client

        suspend fun order(sort: String) = client.milestones("name" to tag, "sort" to sort).body<MilestonePageResponse>().items.map { it.id }

        assertEquals(listOf(first, third, second), order("projectName"), "equal project names fall back to id ascending")
        assertEquals(listOf(second, first, third), order("-projectName"), "the tiebreaker stays ascending when the sort is descending")
        assertEquals(listOf(second, third, first), order("teamName"), "equal team names fall back to id ascending")
        assertEquals(listOf(first, second, third), order("-teamName"))
        assertEquals(listOf(first, third, second), order("projectName,-teamName"), "a multi-field sort applies in order")
    }

    @Test
    fun `a deleted project's milestones are absent under every filter`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-del-filter")
        val teamId = TestTeams.seed(planName("ml-team"))
        val doomed = TestPlan.project(w.programId, w.projectOwner.personId!!)
        TestPlan.milestone(doomed, teamId, name = "Unscheduled ${marker()}")
        val dated = TestPlan.milestone(doomed, teamId, name = "Dated ${marker()}")
        TestPlan.schedule(dated, "2027-05-03", "2027-05-07")
        val client = w.stranger.client
        assertEquals(2L, client.milestones("teamId" to "$teamId").body<MilestonePageResponse>().total)

        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$doomed").status)
        for (filters in listOf(
            arrayOf("teamId" to "$teamId"),
            arrayOf("projectId" to "$doomed"),
            arrayOf("teamId" to "$teamId", "scheduled" to "false"),
            arrayOf("teamId" to "$teamId", "scheduled" to "true"),
        )) {
            assertEquals(0L, client.milestones(*filters).body<MilestonePageResponse>().total, filters.joinToString())
        }
    }

    @Test
    fun `the list and Home count one set - the plan total and a team's row`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-home", teams = true)
        val t = w.requireTeams()
        TestPlan.milestone(w.projectId, t.teamId, name = "Open one ${marker()}")
        TestPlan.milestone(w.projectId, t.teamId, name = "Open two ${marker()}")
        TestPlan.milestone(w.projectId, t.otherTeamId, name = "Open other ${marker()}")
        val dated = TestPlan.milestone(w.projectId, t.teamId, name = "Dated ${marker()}")
        TestPlan.schedule(dated, "2027-06-07", "2027-06-11")
        val client = w.stranger.client

        val home = t.manager.client.get("/api/v1/views/home").body<HomeView>()
        val unscheduled = client.milestones("scheduled" to "false", "pageSize" to "1").body<MilestonePageResponse>()
        assertEquals(home.plan.unscheduledMilestones.toLong(), unscheduled.total, "the plan-wide figure and the list count one set")
        val row = checkNotNull(home.me).teams.single { it.id == t.teamId }
        val teamList = client.milestones("scheduled" to "false", "teamId" to "${t.teamId}").body<MilestonePageResponse>()
        assertEquals(row.unscheduledMilestones.toLong(), teamList.total, "a team's row and its filtered list count one set")
        assertEquals(2L, teamList.total)
        assertEquals(3L, client.milestones("teamId" to "${t.teamId}").body<MilestonePageResponse>().total)
    }
}
