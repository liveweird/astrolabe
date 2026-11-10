package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.ExternalFlagRequest
import ch.nokillswit.planning.ExternalFlags
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.FlaggedRange
import ch.nokillswit.planning.TeamExternal
import ch.nokillswit.planning.WeekLoadView
import ch.nokillswit.planning.withFlaggedRanges
import kotlinx.serialization.json.Json
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The seam's team half (1.9), pure: the request's node/team arithmetic and the weeks strip's marking rule ([withFlaggedRanges]). 2049-03-08
 * is a Monday, so the week starts below are 03-08, 03-15, 03-22, 03-29.
 */
class ExternalFlagsTest {
    private val weeks = listOf("2049-03-08", "2049-03-15", "2049-03-22", "2049-03-29").map {
        WeekLoadView(it, 1.0, 5.0, overloaded = false, overloadMd = null, maxWip = 1, wipExceeded = false)
    }

    private fun range(start: String, end: String, severity: FlagSeverity) =
        FlaggedRange(LocalDate.parse(start), LocalDate.parse(end), severity)

    private fun marks(ranges: List<FlaggedRange>) = weeks.withFlaggedRanges(ranges).map { it.flowCapacity }

    @Test
    fun `a Monday to Friday range marks exactly its week`() {
        assertEquals(listOf(null, FlagSeverity.INFO, null, null), marks(listOf(range("2049-03-15", "2049-03-19", FlagSeverity.INFO))))
    }

    @Test
    fun `a sprint crossing a weekend marks both weeks it touches`() {
        val crossing = listOf(range("2049-03-18", "2049-03-22", FlagSeverity.INFO))
        assertEquals(listOf(null, FlagSeverity.INFO, FlagSeverity.INFO, null), marks(crossing))
    }

    @Test
    fun `a Saturday start marks the week it falls in, and a Sunday end the week it closes`() {
        assertEquals(listOf(FlagSeverity.WARNING, null, null, null), marks(listOf(range("2049-03-13", "2049-03-13", FlagSeverity.WARNING))))
        assertEquals(listOf(FlagSeverity.INFO, null, null, null), marks(listOf(range("2049-03-12", "2049-03-14", FlagSeverity.INFO))))
    }

    @Test
    fun `WARNING beats INFO on a shared week, whatever the order of the ranges`() {
        val warning = range("2049-03-15", "2049-03-19", FlagSeverity.WARNING)
        val info = range("2049-03-17", "2049-03-24", FlagSeverity.INFO)
        val expected = listOf(null, FlagSeverity.WARNING, FlagSeverity.INFO, null)
        assertEquals(expected, marks(listOf(warning, info)))
        assertEquals(expected, marks(listOf(info, warning)))
    }

    @Test
    fun `a range outside every week marks none, and no range leaves the very same list`() {
        assertEquals(listOf(null, null, null, null), marks(listOf(range("2049-05-03", "2049-05-07", FlagSeverity.WARNING))))
        assertEquals(listOf(null, null, null, null), marks(listOf(range("2049-03-01", "2049-03-05", FlagSeverity.WARNING))))
        assertSame(weeks, weeks.withFlaggedRanges(emptyList()))
    }

    @Test
    fun `an unmarked week has no flowCapacity member on the wire and a marked one has`() {
        val json = Json { encodeDefaults = true }
        val marked = weeks.withFlaggedRanges(listOf(range("2049-03-15", "2049-03-19", FlagSeverity.WARNING)))
        assertFalse(json.encodeToString(WeekLoadView.serializer(), marked[0]).contains("flowCapacity"))
        assertTrue(json.encodeToString(WeekLoadView.serializer(), marked[1]).contains(""""flowCapacity":"WARNING""""))
    }

    @Test
    fun `a request naming no node asks about a team only through teamId`() {
        val calendar = WorkingCalendar.MON_FRI
        val none = ExternalFlagRequest(emptyList(), emptyList(), calendar)
        assertTrue(none.namesNoNode)
        val team = ExternalFlagRequest(emptyList(), emptyList(), calendar, teamId = 7u)
        assertTrue(team.namesNoNode)
        assertEquals(7u, team.teamId)
        val plan = ExternalFlagRequest(null, null, calendar)
        assertFalse(plan.namesNoNode)
    }

    @Test
    fun `an answer without a team says nothing about it`() {
        val ranges = listOf(range("2049-03-15", "2049-03-19", FlagSeverity.INFO))
        val answer = ExternalFlags(teams = mapOf(1u to TeamExternal(emptyList(), ranges)))
        assertEquals(1, answer.team(1u).ranges.size)
        assertSame(TeamExternal.NONE, answer.team(2u))
        assertSame(TeamExternal.NONE, ExternalFlags().team(1u))
    }
}
