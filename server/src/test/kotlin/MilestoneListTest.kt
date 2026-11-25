package ch.nokillswit

import ch.nokillswit.planning.HomeView
import ch.nokillswit.planning.MilestonePageResponse
import ch.nokillswit.planning.RankingUpdateRequest
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /api/v1/milestones` (v0.4.0 C2, the dependency pickers' milestone search; 1.19.0 C2, the Milestones page's list): any
 * authenticated user, paged per `list-endpoints.md`, the filters `name` (case- and accent-insensitive), `scheduled`, `teamId`,
 * `projectId`, `programId` and `workStreamId` (ANDed), the sorts `projectName`, `teamName`, `rankPosition` and `startDate` (the last two
 * with their nulls last both ways), the project's and team's name and rank position on every row, ACTIVE rows under an active project
 * chain only. The plan tables are SHARED suite state - every row carries a unique marker or a filter naming the test's own team,
 * project, program or work stream, and every assertion filters on it (a plan-wide figure is compared with another read of the same
 * test). The global ranking is shared too: the rank tests rewrite it wholesale (the `ProgramsViewTest` idiom) and read only their own
 * program.
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
        assertEquals(badRequest, client.milestones("sort" to "-rank").status, "the key is rankPosition")
        assertEquals(badRequest, client.milestones("sort" to "-estimateMd").status, "the estimate is not sortable")
        assertEquals(badRequest, client.milestones("name" to "a", "name" to "b").status, "a repeated scalar key is a 400")
        assertEquals(badRequest, client.milestones("scheduled" to "yes").status, "scheduled is a strict boolean")
        assertEquals(badRequest, client.milestones("scheduled" to "TRUE").status, "scheduled is a strict boolean")
        assertEquals(badRequest, client.milestones("teamId" to "abc").status)
        assertEquals(badRequest, client.milestones("projectId" to "-1").status)
        assertEquals(badRequest, client.milestones("programId" to "abc").status)
        assertEquals(badRequest, client.milestones("workStreamId" to "-1").status)
        assertEquals(badRequest, client.milestones("scheduled" to "true", "scheduled" to "true").status, "a repeated key is a 400")
        assertEquals(badRequest, client.milestones("teamId" to "1", "teamId" to "1").status, "a repeated key is a 400")
        assertEquals(badRequest, client.milestones("projectId" to "1", "projectId" to "1").status, "a repeated key is a 400")
        assertEquals(badRequest, client.milestones("programId" to "1", "programId" to "1").status, "a repeated key is a 400")
        assertEquals(badRequest, client.milestones("workStreamId" to "1", "workStreamId" to "1").status, "a repeated key is a 400")
        val blank = client.milestones("scheduled" to "", "teamId" to "", "projectId" to "", "programId" to "", "workStreamId" to "")
        assertEquals(ok, blank.status, "blank filters are absent")
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
        for (param in listOf("teamId", "projectId", "programId", "workStreamId")) {
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
    fun `programId and workStreamId narrow through the chain and combine with each other and with the other filters`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-chain")
        val owner = w.projectOwner.personId!!
        val teamA = TestTeams.seed(planName("ml-team-a"))
        val teamB = TestTeams.seed(planName("ml-team-b"))
        // Stream S1 holds programs P1 (the world's own, project J1) and P2 (J2); stream S2 holds P3 (J3).
        val programTwo = TestPlan.program(w.streamId, w.programOwner.personId!!)
        val projectTwo = TestPlan.project(programTwo, owner)
        val streamTwo = TestPlan.workStream(w.streamOwner.personId!!)
        val programThree = TestPlan.program(streamTwo, w.programOwner.personId)
        val projectThree = TestPlan.project(programThree, owner)
        val inOne = TestPlan.milestone(w.projectId, teamA, name = "One ${marker()}")
        val inOneB = TestPlan.milestone(w.projectId, teamB, name = "One-b ${marker()}")
        val inTwo = TestPlan.milestone(projectTwo, teamA, name = "Two ${marker()}")
        val inThree = TestPlan.milestone(projectThree, teamA, name = "Three ${marker()}")
        TestPlan.schedule(inTwo, "2027-04-05", "2027-04-09")
        val client = w.stranger.client

        fun ids(page: MilestonePageResponse) = page.items.map { it.id }.toSet()
        suspend fun ask(vararg params: Pair<String, String>) = client.milestones(*params, "sort" to "id").body<MilestonePageResponse>()

        assertEquals(setOf(inOne, inOneB), ids(ask("programId" to "${w.programId}")))
        assertEquals(setOf(inTwo), ids(ask("programId" to "$programTwo")))
        assertEquals(setOf(inThree), ids(ask("programId" to "$programThree")))
        assertEquals(setOf(inOne, inOneB, inTwo), ids(ask("workStreamId" to "${w.streamId}")), "a work stream spans its programs")
        assertEquals(setOf(inThree), ids(ask("workStreamId" to "$streamTwo")))
        assertEquals(setOf(inTwo), ids(ask("workStreamId" to "${w.streamId}", "programId" to "$programTwo")))
        val outsideStream = ask("workStreamId" to "$streamTwo", "programId" to "$programTwo")
        assertEquals(emptySet(), ids(outsideStream), "a program outside the stream matches nothing")
        assertEquals(setOf(inOne, inOneB), ids(ask("programId" to "${w.programId}", "projectId" to "${w.projectId}")))
        val outsideProgram = ask("programId" to "${w.programId}", "projectId" to "$projectTwo")
        assertEquals(emptySet(), ids(outsideProgram), "a project outside the program matches nothing")
        assertEquals(setOf(inOne), ids(ask("workStreamId" to "${w.streamId}", "programId" to "${w.programId}", "teamId" to "$teamA")))
        assertEquals(setOf(inOne), ids(ask("programId" to "${w.programId}", "teamId" to "$teamA", "scheduled" to "false")))
        assertEquals(setOf(inTwo), ids(ask("workStreamId" to "${w.streamId}", "scheduled" to "true")))
        // `total` is counted after the new filters, before the page.
        val firstPage = client.milestones("workStreamId" to "${w.streamId}", "pageSize" to "1").body<MilestonePageResponse>()
        assertEquals(1, firstPage.items.size)
        assertEquals(3L, firstPage.total)
        // A deleted project's milestones leave the program and work stream lists with it.
        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$projectTwo").status)
        assertEquals(emptySet(), ids(ask("programId" to "$programTwo")))
        assertEquals(setOf(inOne, inOneB), ids(ask("workStreamId" to "${w.streamId}")))
    }

    /** The world's program with five projects: two ranked (B first, A second) and two unranked (Ada, Uma), and the milestones below. */
    private class RankedWorld(val w: PlanWorld, val projects: Map<String, UInt>, val milestones: Map<String, UInt>) {
        fun ids(page: MilestonePageResponse) = page.items.map { it.id }
        fun names(page: MilestonePageResponse) = page.items.map { it.name.substringBefore(' ') }
    }

    private suspend fun ApplicationTestBuilder.rankedWorld(prefix: String): RankedWorld {
        val w = planWorld(prefix)
        val tag = marker()
        val owner = w.projectOwner.personId!!
        val team = TestTeams.seed(planName("$prefix-team"))
        val projects = listOf("B", "A", "Uma", "Ada").associateWith { TestPlan.project(w.programId, owner, name = "$it $tag") }
        suspend fun milestone(project: String, name: String, start: String? = null): Pair<String, UInt> {
            val id = TestPlan.milestone(projects.getValue(project), team, name = "$name $tag")
            if (start != null) TestPlan.schedule(id, start, start)
            return name to id
        }
        // B's milestones: Zeta starts 03-01, Beta 02-01, Alpha is unscheduled (the page's order: start with nulls last, then name).
        val milestones = mapOf(
            milestone("B", "Zeta", "2027-03-01"),
            milestone("B", "Alpha"),
            milestone("B", "Beta", "2027-02-01"),
            milestone("A", "Only"),
            milestone("Uma", "Umbra"),
            milestone("Ada", "Adagio"),
        )
        return RankedWorld(w, projects, milestones)
    }

    private suspend fun HttpClient.rank(ids: List<UInt>) {
        assertEquals(ok, putJson("/api/v1/roadmap/ranking", RankingUpdateRequest(TestPlan.revision(), ids)).status)
    }

    @Test
    fun `rankPosition sorts both ways with the unranked projects last, by project name, and rows carry the position`() = testApplication {
        usePostgresTestcontainer()
        val r = rankedWorld("ml-rank")
        val client = r.w.stranger.client
        val program = "programId" to "${r.w.programId}"
        r.w.admin.client.rank(listOf(r.projects.getValue("B"), r.projects.getValue("A")))
        val m = r.milestones

        suspend fun page(sort: String) = client.milestones(program, "sort" to sort).body<MilestonePageResponse>()

        // The page's own strings: only the FIRST key flips, so the unranked rows stay last, by project name, in both directions.
        val asc = page("rankPosition,projectName,startDate,name")
        assertEquals(listOf("Beta", "Zeta", "Alpha", "Only", "Adagio", "Umbra"), r.names(asc), "rank, then start (unscheduled last)")
        assertEquals(listOf(1, 1, 1, 2, null, null), asc.items.map { it.rankPosition })
        val desc = page("-rankPosition,projectName,startDate,name")
        assertEquals(listOf("Only", "Beta", "Zeta", "Alpha", "Adagio", "Umbra"), r.names(desc), "the unranked stay last, not first")
        assertEquals(listOf(2, 1, 1, 1, null, null), desc.items.map { it.rankPosition })
        assertEquals(setOf(m.getValue("Adagio"), m.getValue("Umbra")), r.ids(desc).takeLast(2).toSet())

        // The key alone (id as the tiebreaker): nulls last both ways, ranked rows in position order.
        assertEquals(listOf(1, 1, 1, 2, null, null), page("rankPosition").items.map { it.rankPosition })
        assertEquals(listOf(2, 1, 1, 1, null, null), page("-rankPosition").items.map { it.rankPosition })
        // Paging keeps the order: the second page of two continues it.
        val second = client.milestones(program, "sort" to "-rankPosition,projectName,startDate,name", "pageSize" to "2", "page" to "2")
            .body<MilestonePageResponse>()
        assertEquals(listOf("Zeta", "Alpha"), r.names(second))
        assertEquals(6L, second.total)

        // A rewritten ranking is read at once: A alone is ranked, B joins the unranked.
        r.w.admin.client.rank(listOf(r.projects.getValue("A")))
        val after = page("rankPosition,projectName,startDate,name")
        assertEquals(listOf("Only", "Adagio", "Beta", "Zeta", "Alpha", "Umbra"), r.names(after), "B joins the unranked, by project name")
        assertEquals(listOf(1, null, null, null, null, null), after.items.map { it.rankPosition })
    }

    @Test
    fun `startDate sorts both ways with the unscheduled milestones last, then by id`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("ml-start")
        val teamId = TestTeams.seed(planName("ml-team"))
        val tag = marker()
        val late = TestPlan.milestone(w.projectId, teamId, name = "Late $tag")
        val soon = TestPlan.milestone(w.projectId, teamId, name = "Soon $tag")
        val noneOne = TestPlan.milestone(w.projectId, teamId, name = "None one $tag")
        val noneTwo = TestPlan.milestone(w.projectId, teamId, name = "None two $tag")
        TestPlan.schedule(late, "2027-03-01", "2027-03-05")
        TestPlan.schedule(soon, "2027-02-01", "2027-02-05")
        val client = w.stranger.client

        suspend fun order(sort: String) = client.milestones("projectId" to "${w.projectId}", "sort" to sort)
            .body<MilestonePageResponse>().items.map { it.id }

        assertEquals(listOf(soon, late, noneOne, noneTwo), order("startDate"))
        assertEquals(listOf(late, soon, noneOne, noneTwo), order("-startDate"), "descending keeps the unscheduled last, in id order")
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
