package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import java.time.DayOfWeek
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The working-day calendar (`infra/time/WorkingCalendar.kt`, pure, no server): the Monday-Friday identities of the v0.4-v0.6 placeholder
 * rule, run on [WorkingCalendar.MON_FRI] unchanged (2026-11-02 is a Monday, 2026-11-07/08 the weekend), then the same identities under
 * a holiday dictionary - the Polish public holidays of 2026 and 2027, written out as literals.
 */
class WorkingCalendarTest {
    private fun day(iso: String) = LocalDate.parse(iso)

    private val calendar = WorkingCalendar.MON_FRI

    /** The Polish public holidays of 2026 and 2027 (Easter Sunday 2026-04-05 and 2027-03-28; Christmas Eve is a holiday since 2025). */
    private val polish = WorkingCalendar(
        listOf(
            "2026-01-01", "2026-01-06", "2026-04-05", "2026-04-06", "2026-05-01", "2026-05-03", "2026-05-24", "2026-06-04",
            "2026-08-15", "2026-11-01", "2026-11-11", "2026-12-24", "2026-12-25", "2026-12-26",
            "2027-01-01", "2027-01-06", "2027-03-28", "2027-03-29", "2027-05-01", "2027-05-03", "2027-05-16", "2027-05-27",
            "2027-08-15", "2027-11-01", "2027-11-11", "2027-12-24", "2027-12-25", "2027-12-26",
        ).associate { day(it) to "holiday $it" },
    )

    // --- Monday-Friday: every identity of the placeholder rule ----------------------------------------------------------------

    @Test
    fun `Monday to Friday are working days and the weekend is not`() {
        val week = (2..8).map { day("2026-11-0$it") }
        assertEquals(listOf(true, true, true, true, true, false, false), week.map(calendar::isWorkingDay))
    }

    @Test
    fun `a span holds a working day unless it lies wholly inside a weekend`() {
        assertFalse(calendar.containsWorkingDay(day("2026-11-07"), day("2026-11-07")), "a Saturday")
        assertFalse(calendar.containsWorkingDay(day("2026-11-07"), day("2026-11-08")), "a weekend")
        assertTrue(calendar.containsWorkingDay(day("2026-11-07"), day("2026-11-09")), "a weekend and the Monday after")
        assertTrue(calendar.containsWorkingDay(day("2026-11-06"), day("2026-11-06")), "a Friday alone")
        assertTrue(calendar.containsWorkingDay(day("2026-11-08"), day("2027-03-01")), "a long span")
        assertFalse(calendar.containsWorkingDay(day("2026-11-09"), day("2026-11-02")), "an inverted span holds nothing")
    }

    @Test
    fun `the index round-trips every working day of 2026 and 2027 and is consecutive across weekends`() {
        assertRoundTripsAndIsConsecutive(calendar)
    }

    @Test
    fun `a weekend collapses onto the Friday before it and the week is five indices wide`() {
        val friday = day("2026-11-06")
        assertEquals(calendar.workingDayIndex(friday), calendar.workingDayIndex(day("2026-11-07")), "Saturday")
        assertEquals(calendar.workingDayIndex(friday), calendar.workingDayIndex(day("2026-11-08")), "Sunday")
        assertEquals(1L, calendar.workingDayIndex(day("2026-11-09")) - calendar.workingDayIndex(friday), "Friday to Monday is one")
        assertEquals(5L, calendar.workingDayIndex(day("2026-11-09")) - calendar.workingDayIndex(day("2026-11-02")), "Monday to Monday")
        assertEquals(10L, calendar.workingDayIndex(day("2026-11-16")) - calendar.workingDayIndex(day("2026-11-02")))
    }

    @Test
    fun `the index is monotone and agrees with the weekday arithmetic before and after the epoch`() {
        assertEquals(DayOfWeek.MONDAY, calendar.workingDayOfIndex(1).dayOfWeek)
        assertEquals(DayOfWeek.FRIDAY, calendar.workingDayOfIndex(5).dayOfWeek)
        assertEquals(DayOfWeek.MONDAY, calendar.workingDayOfIndex(6).dayOfWeek)
        assertEquals(DayOfWeek.FRIDAY, calendar.workingDayOfIndex(0).dayOfWeek, "index 0 is the Friday before index 1")
        assertEquals(DayOfWeek.MONDAY, calendar.workingDayOfIndex(-4).dayOfWeek, "negative indices continue the pattern")
        for (iso in listOf("1969-12-28", "1969-12-31", "1970-01-01", "1970-01-04", "1900-01-01", "2999-12-31")) {
            val date = day(iso)
            val snapped = calendar.previousWorkingDayOnOrBefore(date)
            assertTrue(calendar.isWorkingDay(snapped), iso)
            assertEquals(calendar.workingDayIndex(date), calendar.workingDayIndex(snapped), iso)
            assertEquals(snapped, calendar.workingDayOfIndex(calendar.workingDayIndex(date)), iso)
        }
    }

    @Test
    fun `plusWorkingDays moves over weekends in both directions`() {
        assertEquals(day("2026-11-09"), calendar.plusWorkingDays(day("2026-11-06"), 1), "Friday + 1 is Monday")
        assertEquals(day("2026-11-09"), calendar.plusWorkingDays(day("2026-11-02"), 5), "Monday + 5 is the next Monday")
        assertEquals(day("2026-11-06"), calendar.plusWorkingDays(day("2026-11-09"), -1), "Monday - 1 is Friday")
        assertEquals(day("2026-11-02"), calendar.plusWorkingDays(day("2026-11-09"), -5), "Monday - 5 is the Monday before")
        assertEquals(day("2026-11-04"), calendar.plusWorkingDays(day("2026-11-04"), 0))
        assertEquals(day("2026-11-06"), calendar.plusWorkingDays(day("2026-11-07"), 0), "a weekend counts as the Friday before it")
        assertEquals(day("2026-11-09"), calendar.plusWorkingDays(day("2026-11-07"), 1), "Saturday + 1 is Monday")
        assertEquals(day("2027-11-02"), calendar.plusWorkingDays(day("2026-11-02"), 261), "261 working days is a year here")
    }

    @Test
    fun `the effective edges of a span snap inward over a weekend`() {
        assertEquals(day("2026-11-09"), calendar.nextWorkingDayOnOrAfter(day("2026-11-07")), "Saturday start -> Monday")
        assertEquals(day("2026-11-09"), calendar.nextWorkingDayOnOrAfter(day("2026-11-08")), "Sunday start -> Monday")
        assertEquals(day("2026-11-04"), calendar.nextWorkingDayOnOrAfter(day("2026-11-04")), "a working day stays")
        assertEquals(day("2026-11-06"), calendar.previousWorkingDayOnOrBefore(day("2026-11-07")), "Saturday end -> Friday")
        assertEquals(day("2026-11-06"), calendar.previousWorkingDayOnOrBefore(day("2026-11-08")), "Sunday end -> Friday")
        assertEquals(day("2026-11-04"), calendar.previousWorkingDayOnOrBefore(day("2026-11-04")), "a working day stays")
    }

    @Test
    fun `working days between - a week, a weekend, a weekend straddle, a Saturday start and an inverted span`() {
        assertEquals(5, calendar.workingDaysBetween(day("2027-02-01"), day("2027-02-05")), "Monday to Friday")
        assertEquals(0, calendar.workingDaysBetween(day("2027-02-06"), day("2027-02-07")), "Saturday to Sunday")
        assertEquals(2, calendar.workingDaysBetween(day("2027-02-05"), day("2027-02-08")), "Friday to Monday")
        assertEquals(1, calendar.workingDaysBetween(day("2027-02-06"), day("2027-02-08")), "a Saturday start counts from the Monday")
        assertEquals(1, calendar.workingDaysBetween(day("2027-02-08"), day("2027-02-08")), "one Monday")
        assertEquals(5, calendar.workingDaysBetween(day("2027-02-03"), day("2027-02-09")), "Wednesday to the next Tuesday")
        assertEquals(0, calendar.workingDaysBetween(day("2027-02-09"), day("2027-02-08")), "inverted")
    }

    @Test
    fun `the Monday-Friday calendar has no holidays`() {
        assertNull(calendar.holidayName(day("2026-12-25")))
        assertTrue(calendar.isWorkingDay(day("2026-12-25")))
    }

    // --- with holidays ---------------------------------------------------------------------------------------------------------

    @Test
    fun `a holiday is not a working day and keeps its name`() {
        assertFalse(polish.isWorkingDay(day("2027-01-06")), "Epiphany, a Wednesday")
        assertTrue(polish.isWorkingDay(day("2027-01-05")))
        assertTrue(polish.isWorkingDay(day("2027-01-07")))
        assertEquals("holiday 2027-01-06", polish.holidayName(day("2027-01-06")))
        assertNull(polish.holidayName(day("2027-01-07")))
        assertEquals("holiday 2027-05-01", polish.holidayName(day("2027-05-01")), "a weekend holiday keeps its name")
        assertFalse(polish.isWorkingDay(day("2027-05-01")))
    }

    @Test
    fun `a holiday collapses onto the working day before it, like a weekend, and the index stays consecutive across it`() {
        val tuesday = day("2027-01-05")
        assertEquals(polish.workingDayIndex(tuesday), polish.workingDayIndex(day("2027-01-06")), "Epiphany reads Tuesday")
        assertEquals(1L, polish.workingDayIndex(day("2027-01-07")) - polish.workingDayIndex(tuesday), "Tuesday to Thursday is one")
        assertEquals(day("2027-01-05"), polish.previousWorkingDayOnOrBefore(day("2027-01-06")))
        assertEquals(day("2027-01-07"), polish.nextWorkingDayOnOrAfter(day("2027-01-06")), "the next working day skips it")
        assertEquals(day("2027-01-07"), polish.plusWorkingDays(day("2027-01-05"), 1))
        assertEquals(day("2027-01-05"), polish.plusWorkingDays(day("2027-01-06"), 0), "a holiday counts as the day before it")
    }

    @Test
    fun `Christmas 2026 is two consecutive off days and the index round-trips every working day of 2026 and 2027`() {
        // Thu 12-24 and Fri 12-25 are holidays, then the weekend (Sat 12-26 too): Wed 12-23 is followed by Mon 12-28.
        assertEquals(day("2026-12-28"), polish.nextWorkingDayOnOrAfter(day("2026-12-24")))
        assertEquals(day("2026-12-23"), polish.previousWorkingDayOnOrBefore(day("2026-12-26")))
        assertEquals(1L, polish.workingDayIndex(day("2026-12-28")) - polish.workingDayIndex(day("2026-12-23")))
        assertRoundTripsAndIsConsecutive(polish)
    }

    @Test
    fun `an all-off span holds no working day and a holiday shortens a span's count`() {
        assertFalse(polish.containsWorkingDay(day("2027-12-24"), day("2027-12-26")), "Christmas Eve on a Friday, then the weekend")
        assertFalse(polish.containsWorkingDay(day("2027-01-06"), day("2027-01-06")), "a holiday alone")
        assertTrue(polish.containsWorkingDay(day("2027-01-06"), day("2027-01-07")), "a holiday and the day after")
        assertEquals(4, polish.workingDaysBetween(day("2027-01-04"), day("2027-01-08")), "a week with Epiphany")
        assertEquals(5, calendar.workingDaysBetween(day("2027-01-04"), day("2027-01-08")), "the same week without it")
        assertEquals(0, polish.workingDaysBetween(day("2027-12-24"), day("2027-12-26")))
        assertEquals(2, polish.workingDaysBetween(day("2027-01-05"), day("2027-01-07")), "Tuesday to Thursday, Wednesday off")
    }

    @Test
    fun `workingDaysBetween is additive across holidays`() {
        val a = day("2026-12-20")
        val b = day("2027-01-02")
        val c = day("2027-01-20")
        assertEquals(polish.workingDaysBetween(a, c), polish.workingDaysBetween(a, b) + polish.workingDaysBetween(b.plusDays(1), c))
    }

    private fun assertRoundTripsAndIsConsecutive(subject: WorkingCalendar) {
        var date = day("2026-01-01")
        var previous: Long? = null
        while (date < day("2028-01-01")) {
            val index = subject.workingDayIndex(date)
            if (subject.isWorkingDay(date)) {
                assertEquals(date, subject.workingDayOfIndex(index), "round trip $date")
                if (previous != null) assertEquals(1L, index - previous, "consecutive working days at $date")
                previous = index
            } else if (previous != null) {
                assertEquals(previous, index, "flat over the non-working $date")
            }
            date = date.plusDays(1)
        }
    }
}
