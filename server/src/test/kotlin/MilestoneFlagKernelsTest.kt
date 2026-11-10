package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.MilestoneFlagKernels
import ch.nokillswit.planning.PlanFlag
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The milestone rows' own flag (D2 of v0.7): pure, no database. 2027-01-04 is a Monday, 2027-01-06 (Epiphany) a Wednesday. */
class MilestoneFlagKernelsTest {
    private fun span(start: String, end: String = start) = DaySpan(LocalDate.parse(start), LocalDate.parse(end))

    private val warning = PlanFlag(FlagKind.NO_WORKING_DAY, FlagSeverity.WARNING, null, null, null)

    @Test
    fun `an unscheduled milestone has nothing to flag`() {
        assertNull(MilestoneFlagKernels.noWorkingDay(null, WorkingCalendar.MON_FRI))
    }

    @Test
    fun `a span holding a weekday is clean, a weekend-only span is flagged`() {
        assertNull(MilestoneFlagKernels.noWorkingDay(span("2027-01-04", "2027-01-08"), WorkingCalendar.MON_FRI))
        assertNull(MilestoneFlagKernels.noWorkingDay(span("2027-01-08", "2027-01-11"), WorkingCalendar.MON_FRI), "Fri to Mon holds two")
        assertEquals(warning, MilestoneFlagKernels.noWorkingDay(span("2027-01-09", "2027-01-10"), WorkingCalendar.MON_FRI))
    }

    @Test
    fun `a one-day span on a holiday is flagged only on a calendar that holds it, a longer span survives it`() {
        val holiday = WorkingCalendar(mapOf(LocalDate.parse("2027-01-06") to "Epiphany"))
        assertEquals(warning, MilestoneFlagKernels.noWorkingDay(span("2027-01-06"), holiday))
        assertNull(MilestoneFlagKernels.noWorkingDay(span("2027-01-06"), WorkingCalendar.MON_FRI))
        assertNull(MilestoneFlagKernels.noWorkingDay(span("2027-01-05", "2027-01-07"), holiday))
        // Wed-Fri holidays, then the weekend: nothing left.
        val bridge = WorkingCalendar(listOf("2027-01-06", "2027-01-07", "2027-01-08").associate { LocalDate.parse(it) to "Holiday" })
        assertEquals(warning, MilestoneFlagKernels.noWorkingDay(span("2027-01-06", "2027-01-10"), bridge))
    }
}
