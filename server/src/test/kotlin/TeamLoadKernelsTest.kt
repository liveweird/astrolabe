package ch.nokillswit

import ch.nokillswit.planning.TeamLoadKernels
import ch.nokillswit.planning.TeamLoadRow
import ch.nokillswit.planning.TeamLoadTeam
import ch.nokillswit.planning.TeamMilestoneCount
import ch.nokillswit.planning.TeamWarningCounts
import ch.nokillswit.planning.WeekLoad
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
        val view = TeamLoadKernels.view(7, teams, counts, weeks, maxRows = 200)
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
        val row = TeamLoadKernels.view(1, teams, counts, weeks, 200).teams.single { it.id == 4u }
        assertEquals(listOf(0, 0, 0, 0, 0), row.figures())
    }

    @Test
    fun `rows are ordered by lowercase name then id`() {
        val ids = TeamLoadKernels.view(1, teams, counts, weeks, 200).teams.map { it.id }
        // alpha, Bravo (4) before bravo (5) on the id tiebreak, Mike, Zulu.
        assertEquals(listOf(2u, 4u, 5u, 3u, 1u), ids)
        assertEquals(ids, TeamLoadKernels.view(1, teams.reversed(), counts, weeks, 200).teams.map { it.id }, "input order is irrelevant")
    }

    @Test
    fun `the cap cuts the rows and says so, but the totals count every team`() {
        val cut = TeamLoadKernels.view(1, teams, counts, weeks, maxRows = 2)
        assertEquals(listOf(2u, 4u), cut.teams.map { it.id })
        assertTrue(cut.truncated)
        assertEquals(5, cut.totals.teams)
        // The two team counts also count teams the cut dropped (team 1 is the last row).
        assertEquals(listOf(2, 1), listOf(cut.totals.overloadedTeams, cut.totals.wipExceededTeams))
        val exact = TeamLoadKernels.view(1, teams, counts, weeks, maxRows = 5)
        assertFalse(exact.truncated, "exactly at the cap is not cut")
        assertEquals(5, exact.teams.size)
        val none = TeamLoadKernels.view(1, emptyList(), emptyMap(), emptyMap(), 200)
        val totals = none.totals
        assertEquals(listOf(0, 0, 0, 0), listOf(totals.teams, totals.overloadedTeams, totals.wipExceededTeams, none.teams.size))
    }
}
