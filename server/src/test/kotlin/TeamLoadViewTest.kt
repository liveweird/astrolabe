package ch.nokillswit

import ch.nokillswit.planning.HomeView
import ch.nokillswit.planning.MAX_TEAM_LOAD_ROWS
import ch.nokillswit.planning.TeamLoadRow
import ch.nokillswit.planning.TeamLoadView
import ch.nokillswit.planning.TeamLoadViewService
import ch.nokillswit.planning.TeamView
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/team-load` (1.19.0): every team's milestones and flagged weeks. Each row is compared with the team page it repeats
 * (`GET /views/team/{id}`) and `totals` with Home's two team counts, read in the same test. The plan tables are shared state, so a
 * plan-wide figure is never asserted as an absolute number: a total is a delta around this test's own seeding, and a row is looked up
 * by its team's id on the uncapped document ([uncapped]). No Jira or Flow stub (the view reads no external source).
 */
class TeamLoadViewTest {
    private val path = "/api/v1/views/team-load"

    private suspend fun HttpClient.load(): TeamLoadView = get(path).body()

    private suspend fun HttpClient.home(): HomeView = get("/api/v1/views/home").body()

    private suspend fun HttpClient.team(id: UInt): TeamView = get("/api/v1/views/team/$id").body()

    private fun TeamLoadView.row(id: UInt): TeamLoadRow = teams.single { it.id == id }

    /**
     * The document with NO row cap. The endpoint cuts at 200 rows by name, and the shared database of a CI fork holds far more
     * teams than that (every `planWorld` and `TestTeams.seed` leaves its teams), so a test's own team may sort past the cut: row
     * lookups and "not truncated" claims are made here, and the HTTP reads keep what only HTTP proves (status, shape, one body for
     * every caller, the cut itself).
     */
    private suspend fun uncapped(): TeamLoadView = TeamLoadViewService(sharedDatabaseForTests(), maxRows = Int.MAX_VALUE).view()

    /** The seeded teams: a (overloaded, over WIP), b (overloaded), c (neither), d (work, no capacity), e (empty). */
    private class Seeded(val w: PlanWorld, val manager: UInt, val teams: List<UInt>)

    private suspend fun ApplicationTestBuilder.world(prefix: String): PlanWorld {
        usePostgresTestcontainer()
        return planWorld(prefix)
    }

    private suspend fun ApplicationTestBuilder.seeded(prefix: String, w: PlanWorld): Seeded {
        val manager = TestPeople.seed(planName("$prefix-mg"))
        val project = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val teams = listOf("a", "b", "c", "d", "e").map { TestTeams.seed(planName("$prefix-$it"), manager) }
        suspend fun load(team: UInt, count: Int) = repeat(count) {
            TestPlan.schedule(TestPlan.milestone(project, team, estimate = 3.0), "2044-09-05", "2044-09-09")
        }
        TestPlan.capacityPeriod(teams[0], "2044-01-03", 1.0, wipLimit = 1).also { load(teams[0], 2) }
        TestPlan.capacityPeriod(teams[1], "2044-01-03", 1.0).also { load(teams[1], 1) }
        TestPlan.capacityPeriod(teams[2], "2044-01-03", 100.0, wipLimit = 5).also { load(teams[2], 1) }
        TestPlan.milestone(project, teams[2]) // c also has a milestone without dates
        load(teams[3], 1) // d: scheduled work and no capacity period at all
        return Seeded(w, manager, teams)
    }

    @Test
    fun `an anonymous request is a 401, an unknown parameter is ignored and the JSON holds exactly the documented members`() =
        testApplication {
            val s = seeded("tl1", world("tl1"))
            assertEquals(HttpStatusCode.Unauthorized, jsonClient().get(path).status)
            val response = s.w.stranger.client.get("$path?personId=${s.w.stranger.personId}&foo=bar")
            assertEquals(HttpStatusCode.OK, response.status)
            val root = Json.parseToJsonElement(response.bodyAsText()).jsonObject
            assertEquals(setOf("revision", "totals", "teams", "truncated"), root.keys, "no can")
            assertEquals(setOf("teams", "overloadedTeams", "wipExceededTeams"), root.getValue("totals").jsonObject.keys)
            val row = root.getValue("teams").jsonArray.first().jsonObject
            assertEquals(
                setOf(
                    "id", "name", "managerName", "milestones", "unscheduledMilestones", "overloadedWeeks", "wipExceededWeeks",
                    "weeksWithoutCapacity",
                ),
                row.keys,
            )
            // A leading "!" sorts before every other team name, so this row is inside the 200-row cut whatever else the database holds.
            val managerless = TestTeams.seed("!${planName("tl1-nomanager")}")
            val rows = Json.parseToJsonElement(s.w.stranger.client.get(path).bodyAsText()).jsonObject.getValue("teams").jsonArray
            val absent = rows.map { it.jsonObject }.single { it.getValue("id").toString() == managerless.toString() }
            assertEquals(JsonNull, absent.getValue("managerName"), "the member is present and null")
            assertEquals(TestPlan.revision(), s.w.stranger.client.load().revision)
        }

    @Test
    fun `each row equals its team page and the totals equal Home's two figures, moving by exactly what is seeded`() = testApplication {
        val w = world("tl2")
        val baseLoad = uncapped()
        val baseHome = w.stranger.client.home().plan
        assertEquals(baseHome.overloadedTeams, baseLoad.totals.overloadedTeams, "equal before anything is seeded")
        assertEquals(baseHome.wipExceededTeams, baseLoad.totals.wipExceededTeams)

        val s = seeded("tl2", w)
        val client = s.w.stranger.client
        val load = uncapped()
        val home = client.home().plan
        assertEquals(home.overloadedTeams, load.totals.overloadedTeams, "Home's badge and this page's line are one expression")
        assertEquals(home.wipExceededTeams, load.totals.wipExceededTeams)
        assertEquals(2, load.totals.overloadedTeams - baseLoad.totals.overloadedTeams)
        assertEquals(1, load.totals.wipExceededTeams - baseLoad.totals.wipExceededTeams)
        assertEquals(s.teams.size, load.totals.teams - baseLoad.totals.teams)
        assertFalse(load.truncated)

        val manager = TestPeople.rawRows().single { it.id == s.manager }.name
        for (id in s.teams) {
            val page = client.team(id)
            val row = load.row(id)
            assertEquals(page.team.name, row.name)
            assertEquals(manager, row.managerName)
            assertEquals(page.team.managerName, row.managerName)
            assertEquals(page.weeks.count { it.overloaded }, row.overloadedWeeks)
            assertEquals(page.weeks.count { it.wipExceeded }, row.wipExceededWeeks)
            assertEquals(page.weeks.count { it.capacity == null }, row.weeksWithoutCapacity)
            assertEquals(page.scheduled.size + page.unscheduled.size, row.milestones)
            assertEquals(page.unscheduled.size, row.unscheduledMilestones)
        }
        fun figures(index: Int) = load.row(s.teams[index]).let {
            listOf(it.overloadedWeeks, it.wipExceededWeeks, it.weeksWithoutCapacity, it.milestones, it.unscheduledMilestones)
        }
        assertEquals(listOf(1, 1, 0, 2, 0), figures(0))
        assertEquals(listOf(1, 0, 0, 1, 0), figures(1))
        assertEquals(listOf(0, 0, 0, 2, 1), figures(2))
        assertEquals(listOf(0, 0, 1, 1, 0), figures(3), "work and no capacity: one week without capacity, never overloaded")
        assertEquals(listOf(0, 0, 0, 0, 0), figures(4), "a team with nothing scheduled reads zeros")
        val names = load.teams.map { it.name.lowercase() to it.id }
        assertEquals(names.sortedWith(compareBy({ it.first }, { it.second })), names, "by name case-insensitively, then id")
    }

    @Test
    fun `the document is identical for every caller`() = testApplication {
        val s = seeded("tl3", world("tl3"))
        val w = s.w
        val bodies = listOf(w.admin, w.streamOwner, w.programOwner, w.projectOwner, w.stranger, w.personless, w.editor)
            .map { it.client.get(path).bodyAsText() }
        assertEquals(1, bodies.toSet().size, "no role, person or grant reaches a figure")
    }

    @Test
    fun `a deleted team is in no row and no total, and a deleted manager reads no manager`() = testApplication {
        val s = seeded("tl4", world("tl4"))
        val admin = s.w.admin.client
        val full = uncapped()
        assertTrue(full.row(s.teams[0]).managerName != null, "non-vacuous: the team had a manager")
        TestPeople.softDelete(s.manager)
        try {
            val orphaned = uncapped()
            assertNull(orphaned.row(s.teams[0]).managerName, "the team stays, without a manager")
            assertEquals(full.totals, orphaned.totals)
        } finally {
            // The person delete refuses while the person manages an active team: leave no team managed by a deleted person behind.
            jbSql("UPDATE people SET marked_as_deleted = FALSE WHERE id = ?", s.manager.toInt())
        }

        // A team with work cannot be deleted; its milestones go first, and then it leaves every row and total.
        val first = s.teams[0]
        val milestones = admin.team(first).let { page -> (page.scheduled + page.unscheduled).map { it.id } }
        assertEquals(2, milestones.size)
        for (id in milestones) assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/$id").status)
        val emptied = uncapped()
        assertEquals(1, full.totals.overloadedTeams - emptied.totals.overloadedTeams, "its weeks left with its milestones")
        assertEquals(1, full.totals.wipExceededTeams - emptied.totals.wipExceededTeams)
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/teams/$first").status)
        val gone = uncapped()
        assertTrue(gone.teams.none { it.id == first })
        assertEquals(1, full.totals.teams - gone.totals.teams)
        assertEquals(emptied.totals.copy(teams = emptied.totals.teams - 1), gone.totals)
    }

    @Test
    fun `a list is cut at the service's cap and says so, while the totals count every team`() = testApplication {
        val s = seeded("tl5", world("tl5"))
        val database = sharedDatabaseForTests()
        val whole = uncapped()
        val cut = TeamLoadViewService(database, maxRows = 1).view()
        assertTrue(cut.truncated)
        assertEquals(1, cut.teams.size)
        assertEquals(whole.teams.first(), cut.teams.single(), "the first of the order")
        assertEquals(whole.totals, cut.totals, "the totals count every team")
        assertFalse(whole.truncated)
        assertTrue(s.teams.all { id -> whole.teams.any { it.id == id } })
    }

    @Test
    fun `the endpoint answers the first 200 rows of the uncapped document and says whether it cut, with more than 200 teams`() =
        testApplication {
            val w = world("tl6")
            val prefix = planName("tl6-many")
            try {
                // Past the cap whatever the database held before: the endpoint must cut, and its prefix must be the uncapped order's.
                repeat(MAX_TEAM_LOAD_ROWS + 1) { TestTeams.seed("$prefix-${it.toString().padStart(3, '0')}") }
                val whole = uncapped()
                val http = w.stranger.client.load()
                assertTrue(whole.totals.teams > MAX_TEAM_LOAD_ROWS)
                assertTrue(http.truncated)
                assertEquals(MAX_TEAM_LOAD_ROWS, http.teams.size)
                assertEquals(whole.teams.take(MAX_TEAM_LOAD_ROWS), http.teams, "the first 200 rows of the one order")
                assertEquals(whole.totals, http.totals, "the totals count every team")
                assertEquals(whole.revision, http.revision)
                assertFalse(whole.truncated)
                assertEquals(whole.totals.teams, whole.teams.size)
            } finally {
                jbSql("DELETE FROM teams WHERE name LIKE ?", "$prefix-%")
            }
            // And the other way round: with at most 200 teams the flag is off. The shared database may hold more than that already,
            // so the claim is made as the rule it is: truncated == (totals.teams > 200).
            val now = w.stranger.client.load()
            assertEquals(now.totals.teams > MAX_TEAM_LOAD_ROWS, now.truncated)
            assertEquals(minOf(now.totals.teams, MAX_TEAM_LOAD_ROWS), now.teams.size)
        }
}
