package ch.nokillswit

import ch.nokillswit.planning.TeamLoadKernels
import ch.nokillswit.planning.TeamLoadRow
import ch.nokillswit.planning.TeamLoadTeam
import ch.nokillswit.planning.TeamLoadView
import ch.nokillswit.planning.TeamMilestoneCount
import ch.nokillswit.planning.TeamWarningCounts
import ch.nokillswit.planning.WeekLoad
import ch.nokillswit.planning.WeekLoadView
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The team-load figures as pure functions (no server, no database): hand-built weeks of a small world. Teams 1 ("Zulu": overloaded in
 * two weeks, over WIP in one of them), 2 ("alpha": overloaded once), 3 ("Mike": neither), 4 ("Bravo": no weeks at all) and 5 ("bravo":
 * a week with no capacity and nothing flagged).
 */
class TeamLoadKernelsTest {
    private fun week(overloaded: Boolean = false, wipExceeded: Boolean = false, capacity: BigDecimal? = BigDecimal.TEN) =
        WeekLoad(LocalDate.parse("2027-03-08"), BigDecimal.ZERO, capacity, overloaded, null, 0, wipExceeded)

    private val weeks = mapOf(
        1u to listOf(week(overloaded = true, wipExceeded = true), week(overloaded = true), week()),
        2u to listOf(week(overloaded = true)),
        3u to listOf(week(), week()),
        5u to listOf(week(capacity = null), week(capacity = null), week()),
    )

    private val teams = listOf(
        TeamLoadTeam(1u, "Zulu", 11u, "Zed"),
        TeamLoadTeam(2u, "alpha", null, null),
        TeamLoadTeam(3u, "Mike", 13u, "Em"),
        TeamLoadTeam(4u, "Bravo", null, null),
        TeamLoadTeam(5u, "bravo", null, null),
    )

    private val counts = mapOf(1u to TeamMilestoneCount(9, 2), 2u to TeamMilestoneCount(3, 3), 5u to TeamMilestoneCount(4, 0))

    @Test
    fun `the totals count the teams with at least one flagged week, whatever the number of weeks`() {
        assertEquals(TeamWarningCounts(overloadedTeams = 2, wipExceededTeams = 1), TeamLoadKernels.totals(weeks))
        assertEquals(TeamWarningCounts(0, 0), TeamLoadKernels.totals(emptyMap()))
        // A team with weeks but nothing flagged, or with no weeks, counts for nothing.
        assertEquals(TeamWarningCounts(0, 0), TeamLoadKernels.totals(mapOf(3u to weeks.getValue(3u), 4u to emptyList())))
    }

    /** A row's figures in the order: overloaded weeks, WIP weeks, weeks without capacity, milestones, not scheduled. */
    private fun TeamLoadRow.figures() =
        listOf(overloadedWeeks, wipExceededWeeks, weeksWithoutCapacity, milestones, unscheduledMilestones)

    @Test
    fun `a row counts its three week figures and its milestones, and a null capacity week is never overloaded`() {
        val view = TeamLoadKernels.view(7, teams, counts, weeks, maxRows = 200, maxWarningWeeks = all, currentWeek)
        val rows = view.teams.associateBy { it.id }
        assertEquals(listOf(2, 1, 0, 9, 2), rows.getValue(1u).figures())
        assertEquals(listOf(1, 0, 0, 3, 3), rows.getValue(2u).figures())
        assertEquals(listOf(0, 0, 0, 0, 0), rows.getValue(3u).figures(), "weeks, none flagged, and no count entry")
        // Two weeks without capacity, none flagged: the row says so instead of looking fine.
        assertEquals(listOf(0, 0, 2, 4, 0), rows.getValue(5u).figures())
        assertEquals("Zed", rows.getValue(1u).managerName)
        assertEquals(11u, rows.getValue(1u).managerPersonId)
        assertNull(rows.getValue(2u).managerPersonId)
        assertNull(rows.getValue(2u).managerName)
        assertEquals(7L, view.revision)
    }

    @Test
    fun `a team absent from the weeks and the counts reads zeros`() {
        val row = TeamLoadKernels.view(1, teams, counts, weeks, 200, all, currentWeek).teams.single { it.id == 4u }
        assertEquals(listOf(0, 0, 0, 0, 0), row.figures())
    }

    @Test
    fun `rows are ordered by lowercase name then id`() {
        val ids = TeamLoadKernels.view(1, teams, counts, weeks, 200, all, currentWeek).teams.map { it.id }
        // alpha, Bravo (4) before bravo (5) on the id tiebreak, Mike, Zulu.
        assertEquals(listOf(2u, 4u, 5u, 3u, 1u), ids)
        val reversed = TeamLoadKernels.view(1, teams.reversed(), counts, weeks, 200, all, currentWeek).teams.map { it.id }
        assertEquals(ids, reversed, "input order is irrelevant")
    }

    @Test
    fun `the not-scheduled total counts the listed teams' milestones only and reads zero without counts`() {
        val withStray = counts + (99u to TeamMilestoneCount(7, 7))
        assertEquals(5, TeamLoadKernels.view(1, teams, withStray, weeks, 200, all, currentWeek).totals.unscheduledMilestones)
        assertEquals(0, TeamLoadKernels.view(1, teams, emptyMap(), weeks, 200, all, currentWeek).totals.unscheduledMilestones)
    }

    @Test
    fun `the cap cuts the rows and says so, but the totals count every team`() {
        val cut = TeamLoadKernels.view(1, teams, counts, weeks, maxRows = 2, maxWarningWeeks = all, currentWeek)
        assertEquals(listOf(2u, 4u), cut.teams.map { it.id })
        assertTrue(cut.truncated)
        assertEquals(5, cut.totals.teams)
        // The two team counts also count teams the cut dropped (team 1 is the last row).
        assertEquals(listOf(2, 1), listOf(cut.totals.overloadedTeams, cut.totals.wipExceededTeams))
        // The not-scheduled total sums every team's count (2 + 3 + 0), also those of the teams the cut dropped.
        assertEquals(5, cut.totals.unscheduledMilestones)
        assertEquals(cut.teams.sumOf { it.unscheduledMilestones }, 3, "the two listed rows alone would read less")
        val exact = TeamLoadKernels.view(1, teams, counts, weeks, maxRows = 5, maxWarningWeeks = all, currentWeek)
        assertFalse(exact.truncated, "exactly at the cap is not cut")
        assertEquals(5, exact.teams.size)
        val none = TeamLoadKernels.view(1, emptyList(), emptyMap(), emptyMap(), 200, all, currentWeek)
        val totals = none.totals
        assertEquals(
            listOf(0, 0, 0, 0, 0),
            listOf(totals.teams, totals.overloadedTeams, totals.wipExceededTeams, totals.unscheduledMilestones, none.teams.size),
        )
    }

    // ---- The listed warning weeks (1.21.0) ----

    private val all = 2_000

    /** A Monday before every week of this class's world: "from this week on" is everything unless a test says otherwise. */
    private val currentWeek = LocalDate.parse("2027-01-04")

    /** A week starting on [monday] (an ISO date): [load] against a capacity of 10 and a peak of [wip]. */
    private fun dated(
        monday: String,
        load: String = "0",
        overloaded: Boolean = false,
        wipExceeded: Boolean = false,
        capacity: BigDecimal? = BigDecimal.TEN,
    ) = WeekLoad(
            LocalDate.parse(monday), BigDecimal(load), capacity, overloaded, if (overloaded) BigDecimal("2.5") else null, 3, wipExceeded,
        )

    private val warningTeams =
        listOf(TeamLoadTeam(1u, "a", null, null), TeamLoadTeam(2u, "b", null, null), TeamLoadTeam(3u, "c", null, null))
    private val warningWeeks = mapOf(
        1u to listOf(
            dated("2027-03-01", "12.5", overloaded = true),
            dated("2027-03-08"),
            dated("2027-03-15", capacity = null),
            dated("2027-03-22", "5", wipExceeded = true),
        ),
        2u to listOf(dated("2027-03-01", "14", overloaded = true, wipExceeded = true), dated("2027-03-08", "13", overloaded = true)),
        3u to listOf(dated("2027-03-01", capacity = null)),
    )

    private fun warningView(maxRows: Int = 200, budget: Int = all) =
        TeamLoadKernels.view(1, warningTeams, emptyMap(), warningWeeks, maxRows, budget, currentWeek)

    private fun TeamLoadRow.listed() = warningWeeks.map { it.weekStart }

    @Test
    fun `a row lists its overloaded and its over-WIP weeks, oldest first, and neither a fine week nor a week without capacity`() {
        val view = warningView()
        val rows = view.teams.associateBy { it.id }
        assertEquals(listOf("2027-03-01", "2027-03-22"), rows.getValue(1u).listed())
        assertEquals(listOf("2027-03-01", "2027-03-08"), rows.getValue(2u).listed())
        assertEquals(emptyList(), rows.getValue(3u).listed(), "a week without capacity is a count, not a warning")
        assertEquals(1, rows.getValue(3u).weeksWithoutCapacity)
        assertFalse(view.warningWeeksTruncated)
        // The wire form is the team page's own week: the same conversion, no Flow flag.
        val first: WeekLoadView = rows.getValue(1u).warningWeeks.first()
        assertEquals(warningWeeks.getValue(1u).first().toViewForTest(), first)
        assertNull(first.flowCapacity)
    }

    @Test
    fun `the two counts equal the listed weeks that carry each flag while nothing is cut`() {
        for (row in warningView().teams) {
            assertEquals(row.overloadedWeeks, row.warningWeeks.count { it.overloaded }, "team ${row.id}")
            assertEquals(row.wipExceededWeeks, row.warningWeeks.count { it.wipExceeded }, "team ${row.id}")
        }
    }

    @Test
    fun `a team absent from the weeks lists none`() {
        val view = TeamLoadKernels.view(1, warningTeams, emptyMap(), emptyMap(), 200, all, currentWeek)
        assertTrue(view.teams.all { it.warningWeeks.isEmpty() })
        assertFalse(view.warningWeeksTruncated)
    }

    @Test
    fun `the budget goes to the weeks from the current week on, nearest first, then to the earlier ones, latest first`() {
        // Row a: 03-01 (overloaded), 03-22 (WIP); row b: 03-01, 03-08. The current week is 03-08: 03-08 and 03-22 are "from this week
        // on" (a week ON the current week counts), 03-01 twice is earlier.
        val now = LocalDate.parse("2027-03-08")
        fun at(budget: Int) = TeamLoadKernels.view(1, warningTeams, emptyMap(), warningWeeks, 200, budget, now)
        fun TeamLoadView.listedByRow() = teams.map { row -> row.listed() }
        val one = at(1)
        assertEquals(listOf(emptyList(), listOf("2027-03-08"), emptyList()), one.listedByRow(), "this week itself is first")
        assertTrue(one.warningWeeksTruncated)
        val two = at(2)
        assertEquals(listOf(listOf("2027-03-22"), listOf("2027-03-08"), emptyList()), two.listedByRow(), "then the next one")
        // Budget three reaches the past: the latest earlier week, 03-01, and the tie goes to the earlier row (a).
        val three = at(3)
        assertEquals(listOf(listOf("2027-03-01", "2027-03-22"), listOf("2027-03-08"), emptyList()), three.listedByRow())
        assertTrue(three.warningWeeksTruncated)
        // Exactly all four cuts nothing.
        val four = at(4)
        assertEquals(listOf(listOf("2027-03-01", "2027-03-22"), listOf("2027-03-01", "2027-03-08"), emptyList()), four.listedByRow())
        assertFalse(four.warningWeeksTruncated)
        assertEquals("2027-03-08", four.currentWeekStart)
        // A budget of zero lists none and says so.
        val none = at(0)
        assertTrue(none.teams.all { it.warningWeeks.isEmpty() })
        assertTrue(none.warningWeeksTruncated)
    }

    @Test
    fun `a later team's week from this week on beats an earlier team's past week, whatever the place in the order`() {
        val past = dated("2027-01-04", "12", overloaded = true)
        val future = dated("2027-06-07", "12", overloaded = true)
        val weeksOf = mapOf(1u to listOf(past), 2u to listOf(future))
        val view = TeamLoadKernels.view(1, warningTeams, emptyMap(), weeksOf, 200, 1, LocalDate.parse("2027-03-01"))
        assertEquals(emptyList(), view.teams[0].listed(), "team a sorts first and has only a past week")
        assertEquals(listOf("2027-06-07"), view.teams[1].listed())
    }

    @Test
    fun `a tie on the date goes to the earlier row, in the future and in the past alike`() {
        val week = dated("2027-03-08", "12", overloaded = true)
        val same = mapOf(1u to listOf(week), 2u to listOf(week))
        for (now in listOf("2027-03-01", "2027-03-15")) {
            val view = TeamLoadKernels.view(1, warningTeams, emptyMap(), same, 200, 1, LocalDate.parse(now))
            assertEquals(listOf(1, 0, 0), view.teams.map { it.warningWeeks.size }, "current week $now")
        }
    }

    @Test
    fun `a budget that fits everything keeps exactly the oldest-first lists, whatever the current week is`() {
        val expected = warningView().teams.map { it.warningWeeks }
        for (now in listOf("2020-01-06", "2027-03-08", "2027-03-23", "2040-01-02")) {
            val view = TeamLoadKernels.view(1, warningTeams, emptyMap(), warningWeeks, 200, 4, LocalDate.parse(now))
            assertEquals(expected, view.teams.map { it.warningWeeks }, "current week $now")
            assertFalse(view.warningWeeksTruncated)
        }
    }

    @Test
    fun `the kept weeks of a row stay oldest first when future and past ones are mixed`() {
        val mixed = mapOf(
            1u to listOf(
                dated("2027-02-01", "12", overloaded = true),
                dated("2027-02-08", "12", overloaded = true),
                dated("2027-04-05", "12", overloaded = true),
                dated("2027-04-12", "12", overloaded = true),
            ),
        )
        // Budget three from 03-01: 04-05, 04-12, then the latest past one, 02-08.
        val row = TeamLoadKernels.view(1, warningTeams, emptyMap(), mixed, 200, 3, LocalDate.parse("2027-03-01")).teams.first()
        assertEquals(listOf("2027-02-08", "2027-04-05", "2027-04-12"), row.listed())
    }

    @Test
    fun `a budget of zero on a plan with no warning week cuts nothing`() {
        val onlyWithoutCapacity = mapOf(3u to warningWeeks.getValue(3u))
        val quiet = TeamLoadKernels.view(1, warningTeams, emptyMap(), onlyWithoutCapacity, 200, maxWarningWeeks = 0, currentWeek)
        assertFalse(quiet.warningWeeksTruncated)
    }

    @Test
    fun `a team past the row cap uses no budget`() {
        val view = TeamLoadKernels.view(1, warningTeams.reversed(), emptyMap(), warningWeeks, 1, 1, currentWeek)
        assertEquals(listOf(1u), view.teams.map { it.id })
        assertEquals(1, view.teams.single().warningWeeks.size)
        assertTrue(view.warningWeeksTruncated, "team a lists one of its two")
        val roomy = TeamLoadKernels.view(1, warningTeams, emptyMap(), warningWeeks, maxRows = 1, maxWarningWeeks = 2, currentWeek)
        assertFalse(roomy.warningWeeksTruncated, "team b's weeks are in no row and use none of the budget")
    }

    @Test
    fun `the counts and the totals are equal with and without the cut`() {
        val whole = warningView()
        val cut = warningView(budget = 1)
        assertEquals(whole.totals, cut.totals)
        assertEquals(
            whole.teams.map { listOf(it.overloadedWeeks, it.wipExceededWeeks, it.weeksWithoutCapacity) },
            cut.teams.map { listOf(it.overloadedWeeks, it.wipExceededWeeks, it.weeksWithoutCapacity) },
        )
    }

    private fun WeekLoad.toViewForTest() = WeekLoadView(
        weekStart.toString(), load.toDouble(), capacity?.toDouble(), overloaded, overloadMd?.toDouble(), maxWip, wipExceeded,
    )
}
