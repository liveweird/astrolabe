package ch.nokillswit

import ch.nokillswit.infra.time.containsWorkingDay
import ch.nokillswit.infra.time.isWorkingDay
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The v0.3 Monday-Friday placeholder (`infra/time/WorkingDays.kt`): 2026-11-02 is a Monday, 2026-11-07/08 the weekend. */
class WorkingDaysTest {
    private fun day(text: String) = LocalDate.parse(text)

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
}
