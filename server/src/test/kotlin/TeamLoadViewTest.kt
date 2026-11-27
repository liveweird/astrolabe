package ch.nokillswit

import ch.nokillswit.planning.HomeView
import ch.nokillswit.planning.MAX_TEAM_LOAD_ROWS
import ch.nokillswit.planning.MAX_TEAM_LOAD_WARNING_WEEKS
import ch.nokillswit.planning.TeamLoadRow
import ch.nokillswit.planning.TeamLoadView
import ch.nokillswit.planning.TeamLoadViewService
import ch.nokillswit.planning.TeamView
import ch.nokillswit.planning.mondayOf
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
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
     * every caller, the cut itself). The weeks' budget is lifted too (the shared database may hold more than 2,000 warning weeks).
     */
    private suspend fun uncapped(): TeamLoadView =
        TeamLoadViewService(sharedDatabaseForTests(), maxRows = Int.MAX_VALUE, maxWarningWeeks = Int.MAX_VALUE).view()

    /** The document read on a pinned clock (an ISO instant), with the given budget and no row cap. */
    private suspend fun uncappedAt(instant: String, maxWarningWeeks: Int = Int.MAX_VALUE): TeamLoadView = TeamLoadViewService(
        sharedDatabaseForTests(),
        maxRows = Int.MAX_VALUE,
        maxWarningWeeks = maxWarningWeeks,
        clock = { Instant.parse(instant).toEpochMilli() },
    ).view()

    /** Where a week stands in the budget's order: from the current week on (nearest first), then earlier (latest first), then the row. */
    private data class Rank(val group: Int, val day: Long, val row: Int) : Comparable<Rank> {
        override fun compareTo(other: Rank) = compareValuesBy(this, other, Rank::group, Rank::day, Rank::row)
    }

    private fun rank(weekStart: String, currentWeek: String, row: Int): Rank {
        val day = LocalDate.parse(weekStart).toEpochDay()
        return if (weekStart >= currentWeek) Rank(0, day, row) else Rank(1, -day, row)
    }

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
            val before = LocalDate.now(ZoneOffset.UTC)
            val response = s.w.stranger.client.get("$path?personId=${s.w.stranger.personId}&foo=bar")
            assertEquals(HttpStatusCode.OK, response.status)
            val root = Json.parseToJsonElement(response.bodyAsText()).jsonObject
            assertEquals(
                setOf("revision", "currentWeekStart", "totals", "teams", "truncated", "warningWeeksTruncated"), root.keys, "no can",
            )
            val currentWeek = LocalDate.parse(root.getValue("currentWeekStart").jsonPrimitive.content)
            val after = LocalDate.now(ZoneOffset.UTC)
            assertEquals(DayOfWeek.MONDAY, currentWeek.dayOfWeek, "the week's Monday")
            assertTrue(!currentWeek.isBefore(mondayOf(before)), "not before the week of the request's start: $currentWeek")
            assertTrue(!currentWeek.isAfter(mondayOf(after)), "not after the week of the response: $currentWeek")
            assertEquals(
                setOf("teams", "overloadedTeams", "wipExceededTeams", "unscheduledMilestones"), root.getValue("totals").jsonObject.keys,
            )
            val row = root.getValue("teams").jsonArray.first().jsonObject
            assertEquals(
                setOf(
                    "id", "name", "managerPersonId", "managerName", "milestones", "unscheduledMilestones", "overloadedWeeks",
                    "wipExceededWeeks", "weeksWithoutCapacity", "warningWeeks",
                ),
                row.keys,
            )
            // A listed week is exactly the team page's week: no Flow flag, no other member. Read off the uncapped document (the endpoint's
            // 200 rows and 2,000-week budget may hold none of this test's teams on a shared database), as the wire form of the same class.
            val uncappedJson = Json.encodeToJsonElement(TeamLoadView.serializer(), uncapped()).jsonObject
            val week = uncappedJson.getValue("teams").jsonArray.map { it.jsonObject }.firstNotNullOf { team ->
                team.getValue("warningWeeks").jsonArray.firstOrNull()?.jsonObject
            }
            assertEquals(setOf("weekStart", "load", "capacity", "overloaded", "overloadMd", "maxWip", "wipExceeded"), week.keys)
            // A leading "!" sorts before every other team name, so this row is inside the 200-row cut whatever else the database holds.
            val managerless = TestTeams.seed("!${planName("tl1-nomanager")}")
            val rows = Json.parseToJsonElement(s.w.stranger.client.get(path).bodyAsText()).jsonObject.getValue("teams").jsonArray
            val absent = rows.map { it.jsonObject }.single { it.getValue("id").toString() == managerless.toString() }
            assertEquals(JsonNull, absent.getValue("managerName"), "the member is present and null")
            assertEquals(JsonNull, absent.getValue("managerPersonId"), "the id is present and null with it")
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
        // The not-scheduled total is compared by what it MOVES by, not absolutely: other classes of the shared container soft-delete a
        // project or team with raw SQL and leave active milestones the two figures read differently (no API write can do that).
        val loadMoved = load.totals.unscheduledMilestones - baseLoad.totals.unscheduledMilestones
        assertEquals(1, loadMoved, "team c's one milestone without dates")
        assertEquals(home.unscheduledMilestones - baseHome.unscheduledMilestones, loadMoved, "Home's not-scheduled figure moves with it")
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
            assertEquals(s.manager, row.managerPersonId, "the id of the person the name is")
            assertEquals(page.team.managerName, row.managerName)
            assertEquals(page.weeks.count { it.overloaded }, row.overloadedWeeks)
            assertEquals(page.weeks.count { it.wipExceeded }, row.wipExceededWeeks)
            assertEquals(page.weeks.count { it.capacity == null }, row.weeksWithoutCapacity)
            assertEquals(page.scheduled.size + page.unscheduled.size, row.milestones)
            assertEquals(page.unscheduled.size, row.unscheduledMilestones)
            assertEquals(page.weeks.filter { it.overloaded || it.wipExceeded }, row.warningWeeks, "the team page's own weeks, oldest first")
        }
        fun figures(index: Int) = load.row(s.teams[index]).let {
            listOf(it.overloadedWeeks, it.wipExceededWeeks, it.weeksWithoutCapacity, it.milestones, it.unscheduledMilestones)
        }
        assertEquals(listOf(1, 1, 0, 2, 0), figures(0))
        assertEquals(listOf(1, 0, 0, 1, 0), figures(1))
        assertEquals(listOf(0, 0, 0, 2, 1), figures(2))
        assertEquals(listOf(0, 0, 1, 1, 0), figures(3), "work and no capacity: one week without capacity, never overloaded")
        assertEquals(listOf(0, 0, 0, 0, 0), figures(4), "a team with nothing scheduled reads zeros")
        val listed = s.teams.map { load.row(it).warningWeeks.size }
        assertEquals(listOf(1, 1, 0, 0, 0), listed, "a's one week carries both flags; d's week has no capacity")
        val names = load.teams.map { it.name.lowercase() to it.id }
        assertEquals(names.sortedWith(compareBy({ it.first }, { it.second })), names, "by name case-insensitively, then id")
    }

    @Test
    fun `the document is identical for every caller`() = testApplication {
        val s = seeded("tl3", world("tl3"))
        val w = s.w
        val callers = listOf(w.admin, w.streamOwner, w.programOwner, w.projectOwner, w.stranger, w.personless, w.editor)
        // The body embeds the server's current week, which may roll over (Monday 00:00 UTC) between two reads: compare it normalised.
        val bodies = callers.map { Json.decodeFromString<TeamLoadView>(it.client.get(path).bodyAsText()).copy(currentWeekStart = "") }
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
            assertNull(orphaned.row(s.teams[0]).managerPersonId, "and the id goes with the name")
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

    @Test
    fun `the document names the server's current week, the Monday of its UTC date, and the clock moves nothing else`() = testApplication {
        usePostgresTestcontainer()
        val cases = mapOf(
            "2044-09-07T10:00:00Z" to "2044-09-05", // a Wednesday
            "2044-09-05T00:00:00Z" to "2044-09-05", // the Monday's first millisecond
            "2044-09-11T23:59:59.999Z" to "2044-09-05", // the Sunday's last
            "2044-09-12T00:00:00Z" to "2044-09-12", // the next Monday begins
        )
        for ((instant, monday) in cases) assertEquals(monday, uncappedAt(instant).currentWeekStart, instant)
        // The clock decides only what a FULL budget keeps: the unbudgeted lists are the same on any pinned day.
        val early = uncappedAt("2020-01-01T00:00:00Z")
        val late = uncappedAt("2090-01-01T00:00:00Z")
        assertEquals(early.copy(currentWeekStart = late.currentWeekStart), late)
    }

    @Test
    fun `a budget of one week lists the week the rule keeps, with the counts and totals of the uncapped document`() = testApplication {
        val s = seeded("tl7", world("tl7"))
        val whole = uncapped()
        assertFalse(whole.warningWeeksTruncated)
        val listedInWhole = whole.teams.sumOf { it.warningWeeks.size }
        assertTrue(listedInWhole >= 2, "non-vacuous: the seeded teams a and b list one week each")
        // Seeded weeks lie in 2044-09-05; a pinned clock puts them ON the current week, then after it (they become "earlier").
        for (instant in listOf("2044-09-07T10:00:00Z", "2044-11-02T10:00:00Z")) {
            val unbudgeted = uncappedAt(instant)
            val cut = uncappedAt(instant, maxWarningWeeks = 1)
            assertEquals(1, cut.teams.sumOf { it.warningWeeks.size }, instant)
            assertTrue(cut.warningWeeksTruncated)
            assertEquals(unbudgeted.totals, cut.totals)
            assertEquals(
                unbudgeted.teams.map { listOf(it.id, it.overloadedWeeks, it.wipExceededWeeks, it.weeksWithoutCapacity) },
                cut.teams.map { listOf(it.id, it.overloadedWeeks, it.wipExceededWeeks, it.weeksWithoutCapacity) },
            )
            // The one week kept is the best of every candidate in the shared database, by the rule's order.
            val current = cut.currentWeekStart
            val best = unbudgeted.teams.withIndex()
                .flatMap { (index, row) -> row.warningWeeks.map { rank(it.weekStart, current, index) to (row.id to it) } }
                .minBy { it.first }.second
            val kept = cut.teams.single { it.warningWeeks.isNotEmpty() }
            assertEquals(best, kept.id to kept.warningWeeks.single(), instant)
        }
        // With the clock ON the seeded week, the kept week is that week, in the first row that has it (the tie goes to the earlier row).
        val onIt = uncappedAt("2044-09-05T00:00:00Z", maxWarningWeeks = 1)
        val keptRow = onIt.teams.single { it.warningWeeks.isNotEmpty() }
        assertEquals("2044-09-05", keptRow.warningWeeks.single().weekStart)
        assertEquals(whole.teams.first { row -> row.warningWeeks.any { it.weekStart == "2044-09-05" } }.id, keptRow.id)
        assertTrue(s.teams.all { id -> whole.teams.any { it.id == id } })
    }

    @Test
    fun `the endpoint lists at most 2000 weeks, the best ones by date, and says it cut`() = testApplication {
        val w = world("tl8")
        val project = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val prefix = "!!${planName("tl8")}"
        val teams = mutableListOf<UInt>()
        try {
            // Four teams, each with one milestone over 520 weeks (the 2050s: no other class has load there) and a capacity of
            // 0.00 man-days a week: every week is overloaded. 500 man-days over about 2,600 working days is about 0.96 a week,
            // which does not round to 0.00.
            repeat(4) { index ->
                val team = TestTeams.seed("$prefix-$index")
                teams += team
                TestPlan.capacityPeriod(team, "2049-01-04", 0.0)
                TestPlan.schedule(TestPlan.milestone(project, team, estimate = 500.0), "2050-01-03", "2059-12-19")
            }
            val whole = uncapped()
            val http = w.stranger.client.load()
            assertTrue(whole.teams.sumOf { it.warningWeeks.size } > 0)
            assertEquals(MAX_TEAM_LOAD_WARNING_WEEKS, http.teams.sumOf { it.warningWeeks.size }, "exactly the budget")
            assertTrue(http.warningWeeksTruncated)
            assertFalse(whole.warningWeeksTruncated)
            assertEquals(whole.totals, http.totals)
            // Properties of the rule (other classes' weeks compete for the budget by date, so no list is compared): a listed week is
            // one of its row's own, and nothing left out ranks before anything listed.
            val wholeById = whole.teams.associateBy { it.id }
            val listed = mutableListOf<Rank>()
            val leftOut = mutableListOf<Rank>()
            http.teams.forEachIndexed { index, row ->
                val own = wholeById.getValue(row.id)
                assertTrue(own.warningWeeks.containsAll(row.warningWeeks), "row ${row.id} lists only its own weeks")
                assertEquals(row.warningWeeks.sortedBy { it.weekStart }, row.warningWeeks, "oldest first inside a row")
                for (week in own.warningWeeks) {
                    (if (week in row.warningWeeks) listed else leftOut) += rank(week.weekStart, http.currentWeekStart, index)
                }
            }
            assertTrue(leftOut.isNotEmpty() && listed.size == MAX_TEAM_LOAD_WARNING_WEEKS)
            assertTrue(listed.max() < leftOut.min(), "every listed week ranks before every left out: ${listed.max()} vs ${leftOut.min()}")
        } finally {
            withContext(NonCancellable) {
                val ids = teams.joinToString(",")
                if (ids.isNotEmpty()) {
                    jbSql("DELETE FROM milestones WHERE team_id IN ($ids)")
                    jbSql("DELETE FROM team_capacity_periods WHERE team_id IN ($ids)")
                    jbSql("DELETE FROM teams WHERE id IN ($ids)")
                }
            }
        }
    }
}
