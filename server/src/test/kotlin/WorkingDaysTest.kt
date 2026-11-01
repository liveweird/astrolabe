package ch.nokillswit

import ch.nokillswit.infra.time.containsWorkingDay
import ch.nokillswit.infra.time.isWorkingDay
import ch.nokillswit.infra.time.nextWorkingDayOnOrAfter
import ch.nokillswit.infra.time.plusWorkingDays
import ch.nokillswit.infra.time.previousWorkingDayOnOrBefore
import ch.nokillswit.infra.time.workingDayIndex
import ch.nokillswit.infra.time.workingDayOfIndex
import java.time.DayOfWeek
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The Monday-Friday working-day rule (`infra/time/WorkingDays.kt`; 2026-11-02 is a Monday, 2026-11-07/08 the weekend) and, since v0.4, its
 * closed-form index (pure, no server): the identities the dependency check builds on.
 */
class WorkingDaysTest {
    private fun day(iso: String) = LocalDate.parse(iso)

    @Test
    fun `Monday to Friday are working days and the weekend is not`() {
        val week = (2..8).map { day("2026-11-0$it") }
        assertEquals(listOf(true, true, true, true, true, false, false), week.map(::isWorkingDay))
    }

    @Test
    fun `a span holds a working day unless it lies wholly inside a weekend`() {
        assertFalse(containsWorkingDay(day("2026-11-07"), day("2026-11-07")), "a Saturday")
        assertFalse(containsWorkingDay(day("2026-11-07"), day("2026-11-08")), "a weekend")
        assertTrue(containsWorkingDay(day("2026-11-07"), day("2026-11-09")), "a weekend and the Monday after")
        assertTrue(containsWorkingDay(day("2026-11-06"), day("2026-11-06")), "a Friday alone")
        assertTrue(containsWorkingDay(day("2026-11-08"), day("2027-03-01")), "a long span needs no further look")
        assertFalse(containsWorkingDay(day("2026-11-09"), day("2026-11-02")), "an inverted span holds nothing")
    }

    @Test
    fun `the index round-trips every working day of 2026 and 2027 and is consecutive across weekends`() {
        var date = day("2026-01-01")
        var previous: Long? = null
        while (date < day("2028-01-01")) {
            val index = workingDayIndex(date)
            if (isWorkingDay(date)) {
                assertEquals(date, workingDayOfIndex(index), "round trip $date")
                if (previous != null) assertEquals(1L, index - previous, "consecutive working days at $date")
                previous = index
            }
            date = date.plusDays(1)
        }
    }

    @Test
    fun `a weekend collapses onto the Friday before it and the week is five indices wide`() {
        val friday = day("2026-11-06")
        assertEquals(workingDayIndex(friday), workingDayIndex(day("2026-11-07")), "Saturday")
        assertEquals(workingDayIndex(friday), workingDayIndex(day("2026-11-08")), "Sunday")
        assertEquals(1L, workingDayIndex(day("2026-11-09")) - workingDayIndex(friday), "Friday to Monday is one working day")
        assertEquals(5L, workingDayIndex(day("2026-11-09")) - workingDayIndex(day("2026-11-02")), "Monday to the next Monday is five")
        assertEquals(10L, workingDayIndex(day("2026-11-16")) - workingDayIndex(day("2026-11-02")))
    }

    @Test
    fun `the index is monotone and agrees with the weekday arithmetic before and after the epoch`() {
        assertEquals(DayOfWeek.MONDAY, workingDayOfIndex(1).dayOfWeek)
        assertEquals(DayOfWeek.FRIDAY, workingDayOfIndex(5).dayOfWeek)
        assertEquals(DayOfWeek.MONDAY, workingDayOfIndex(6).dayOfWeek)
        assertEquals(DayOfWeek.FRIDAY, workingDayOfIndex(0).dayOfWeek, "index 0 is the Friday before index 1")
        assertEquals(DayOfWeek.MONDAY, workingDayOfIndex(-4).dayOfWeek, "negative indices continue the pattern")
        for (iso in listOf("1969-12-28", "1969-12-31", "1970-01-01", "1970-01-04", "1900-01-01", "2999-12-31")) {
            val date = day(iso)
            val snapped = previousWorkingDayOnOrBefore(date)
            assertTrue(isWorkingDay(snapped), iso)
            assertEquals(workingDayIndex(date), workingDayIndex(snapped), iso)
            assertEquals(snapped, workingDayOfIndex(workingDayIndex(date)), iso)
        }
    }

    @Test
    fun `plusWorkingDays moves over weekends in both directions`() {
        assertEquals(day("2026-11-09"), plusWorkingDays(day("2026-11-06"), 1), "Friday + 1 is Monday")
        assertEquals(day("2026-11-09"), plusWorkingDays(day("2026-11-02"), 5), "Monday + 5 is the next Monday")
        assertEquals(day("2026-11-06"), plusWorkingDays(day("2026-11-09"), -1), "Monday - 1 is Friday")
        assertEquals(day("2026-11-02"), plusWorkingDays(day("2026-11-09"), -5), "Monday - 5 is the Monday before")
        assertEquals(day("2026-11-04"), plusWorkingDays(day("2026-11-04"), 0))
        assertEquals(day("2026-11-06"), plusWorkingDays(day("2026-11-07"), 0), "a weekend counts as the Friday before it")
        assertEquals(day("2026-11-09"), plusWorkingDays(day("2026-11-07"), 1), "Saturday + 1 is Monday")
        assertEquals(day("2027-11-02"), plusWorkingDays(day("2026-11-02"), 261), "261 working days is a year here")
    }

    @Test
    fun `the effective edges of a span snap inward over a weekend`() {
        assertEquals(day("2026-11-09"), nextWorkingDayOnOrAfter(day("2026-11-07")), "Saturday start -> Monday")
        assertEquals(day("2026-11-09"), nextWorkingDayOnOrAfter(day("2026-11-08")), "Sunday start -> Monday")
        assertEquals(day("2026-11-04"), nextWorkingDayOnOrAfter(day("2026-11-04")), "a working day stays")
        assertEquals(day("2026-11-06"), previousWorkingDayOnOrBefore(day("2026-11-07")), "Saturday end -> Friday")
        assertEquals(day("2026-11-06"), previousWorkingDayOnOrBefore(day("2026-11-08")), "Sunday end -> Friday")
        assertEquals(day("2026-11-04"), previousWorkingDayOnOrBefore(day("2026-11-04")), "a working day stays")
    }
}
