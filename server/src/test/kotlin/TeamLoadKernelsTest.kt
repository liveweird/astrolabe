package ch.nokillswit

import ch.nokillswit.planning.TeamLoadKernels
import ch.nokillswit.planning.TeamLoadRow
import ch.nokillswit.planning.TeamLoadTeam
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
        TeamLoadTeam(1u, "Zulu", "Zed"),
        TeamLoadTeam(2u, "alpha", null),
        TeamLoadTeam(3u, "Mike", "Em"),
        TeamLoadTeam(4u, "Bravo", null),
        TeamLoadTeam(5u, "bravo", null),
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
        val view = TeamLoadKernels.view(7, teams, counts, weeks, maxRows = 200, maxWarningWeeks = all)
        val rows = view.teams.associateBy { it.id }
        assertEquals(listOf(2, 1, 0, 9, 2), rows.getValue(1u).figures())
        assertEquals(listOf(1, 0, 0, 3, 3), rows.getValue(2u).figures())
        assertEquals(listOf(0, 0, 0, 0, 0), rows.getValue(3u).figures(), "weeks, none flagged, and no count entry")
        // Two weeks without capacity, none flagged: the row says so instead of looking fine.
        assertEquals(listOf(0, 0, 2, 4, 0), rows.getValue(5u).figures())
        assertEquals("Zed", rows.getValue(1u).managerName)
        assertNull(rows.getValue(2u).managerName)
        assertEquals(7L, view.revision)
    }

    @Test
    fun `a team absent from the weeks and the counts reads zeros`() {
        val row = TeamLoadKernels.view(1, teams, counts, weeks, 200, all).teams.single { it.id == 4u }
        assertEquals(listOf(0, 0, 0, 0, 0), row.figures())
    }

    @Test
    fun `rows are ordered by lowercase name then id`() {
        val ids = TeamLoadKernels.view(1, teams, counts, weeks, 200, all).teams.map { it.id }
        // alpha, Bravo (4) before bravo (5) on the id tiebreak, Mike, Zulu.
        assertEquals(listOf(2u, 4u, 5u, 3u, 1u), ids)
        val reversed = TeamLoadKernels.view(1, teams.reversed(), counts, weeks, 200, all).teams.map { it.id }
        assertEquals(ids, reversed, "input order is irrelevant")
    }

    @Test
    fun `the cap cuts the rows and says so, but the totals count every team`() {
        val cut = TeamLoadKernels.view(1, teams, counts, weeks, maxRows = 2, maxWarningWeeks = all)
        assertEquals(listOf(2u, 4u), cut.teams.map { it.id })
        assertTrue(cut.truncated)
        assertEquals(5, cut.totals.teams)
        // The two team counts also count teams the cut dropped (team 1 is the last row).
        assertEquals(listOf(2, 1), listOf(cut.totals.overloadedTeams, cut.totals.wipExceededTeams))
        val exact = TeamLoadKernels.view(1, teams, counts, weeks, maxRows = 5, maxWarningWeeks = all)
        assertFalse(exact.truncated, "exactly at the cap is not cut")
        assertEquals(5, exact.teams.size)
        val none = TeamLoadKernels.view(1, emptyList(), emptyMap(), emptyMap(), 200, all)
        val totals = none.totals
        assertEquals(listOf(0, 0, 0, 0), listOf(totals.teams, totals.overloadedTeams, totals.wipExceededTeams, none.teams.size))
    }

    // ---- The listed warning weeks (1.21.0) ----

    private val all = 2_000

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

    private val warningTeams = listOf(TeamLoadTeam(1u, "a", null), TeamLoadTeam(2u, "b", null), TeamLoadTeam(3u, "c", null))
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
        TeamLoadKernels.view(1, warningTeams, emptyMap(), warningWeeks, maxRows, budget)

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
        val view = TeamLoadKernels.view(1, warningTeams, emptyMap(), emptyMap(), 200, all)
        assertTrue(view.teams.all { it.warningWeeks.isEmpty() })
        assertFalse(view.warningWeeksTruncated)
    }

    @Test
    fun `the budget is handed out in row order and the cut is said`() {
        // Two teams of two warning weeks each, a budget of three: two, then one.
        val three = warningView(budget = 3)
        assertEquals(listOf(2, 1, 0), three.teams.map { it.warningWeeks.size })
        assertEquals(listOf("2027-03-01"), three.teams[1].listed())
        assertTrue(three.warningWeeksTruncated)
        // Exactly four cuts nothing.
        val four = warningView(budget = 4)
        assertEquals(listOf(2, 2, 0), four.teams.map { it.warningWeeks.size })
        assertFalse(four.warningWeeksTruncated)
        // A budget of zero lists none and says so.
        val none = warningView(budget = 0)
        assertTrue(none.teams.all { it.warningWeeks.isEmpty() })
        assertTrue(none.warningWeeksTruncated)
    }

    @Test
    fun `a budget of zero on a plan with no warning week cuts nothing`() {
        val quiet = TeamLoadKernels.view(1, warningTeams, emptyMap(), mapOf(3u to warningWeeks.getValue(3u)), 200, maxWarningWeeks = 0)
        assertFalse(quiet.warningWeeksTruncated)
    }

    @Test
    fun `a team past the row cap uses no budget`() {
        val view = TeamLoadKernels.view(1, warningTeams.reversed(), emptyMap(), warningWeeks, maxRows = 1, maxWarningWeeks = 1)
        assertEquals(listOf(1u), view.teams.map { it.id })
        assertEquals(1, view.teams.single().warningWeeks.size)
        assertTrue(view.warningWeeksTruncated, "team a lists one of its two")
        val roomy = TeamLoadKernels.view(1, warningTeams, emptyMap(), warningWeeks, maxRows = 1, maxWarningWeeks = 2)
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
