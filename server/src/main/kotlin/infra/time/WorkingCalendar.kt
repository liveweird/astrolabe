package ch.nokillswit.infra.time

import java.time.DayOfWeek
import java.time.LocalDate
import java.util.Arrays

private const val WEEK_LENGTH_DAYS = 7L
private const val WORKING_DAYS_IN_WEEK = 5L
private const val LAST_WEEKDAY_OF_WORK_WEEK = 4L

// 1970-01-01 (epoch day 0) was a Thursday; with Monday = 0 the weekday of an epoch day is floorMod(epochDay + 3, 7).
private const val EPOCH_WEEKDAY_SHIFT = 3L

/**
 * The working-day calendar: Monday to Friday minus a dictionary of public holidays, no zones (planning dates are day-precision
 * `DATE`s). Pure and immutable - the holidays are a constructor PARAMETER, loaded once per request by the caller, never read from here.
 * The port of Flow's `WorkingDayIndex` (a sorted `LongArray` of off-days and a binary search, `metrics/WorkingDayIndex.kt`) over the
 * closed-form Monday-Friday arithmetic; Flow's zone/DST machinery (`dayBoundsMs`, skipped dates) has no counterpart here.
 *
 * The working-day index `W` is monotone, consecutive across working days and FLAT over every non-working date (a weekend and a
 * holiday collapse onto the working day before them), so a count of working days between two dates is the difference of their
 * indices. Cost: O(log h) per call for h holidays (a few hundred at most); construction O(h log h).
 *
 * [holidays] maps a date to its name; a holiday on a weekend is kept for [holidayName] and ignored by the index.
 */
class WorkingCalendar(holidays: Map<LocalDate, String>) {
    private val names: Map<LocalDate, String> = holidays.toMap()

    /** The epoch days of the holidays that fall on a Monday-Friday, ascending. */
    private val offDays: LongArray = names.keys.filter(::isWeekday).map { it.toEpochDay() }.sorted().toLongArray()

    /**
     * `adjustedOffIndex[i]`: the working-day index the off-day `offDays[i]` collapses onto (its Monday-Friday index minus the off-days
     * up to it).
     */
    private val adjustedOffIndex: LongArray = LongArray(offDays.size) { monFriIndexOfEpochDay(offDays[it]) - (it + 1) }

    /**
     * The Monday-Friday holidays, ascending: exactly the part of the dictionary the index reads (a weekend holiday changes no count), so
     * a fingerprint of the calendar over these dates flips only when a working-day count could.
     */
    fun offDayDates(): List<LocalDate> = offDays.map(LocalDate::ofEpochDay)

    /** Whether [date] is a Monday-Friday that is not a holiday. */
    fun isWorkingDay(date: LocalDate): Boolean = isWeekday(date) && Arrays.binarySearch(offDays, date.toEpochDay()) < 0

    /** The name of the holiday on [date], or null (a weekend holiday answers its name too). */
    fun holidayName(date: LocalDate): String? = names[date]

    /**
     * Whether the inclusive span [[start], [end]] holds at least one working day (false for an inverted span or one wholly off):
     * `W(previousWorkingDayOnOrBefore(end)) >= W(nextWorkingDayOnOrAfter(start))`.
     */
    fun containsWorkingDay(start: LocalDate, end: LocalDate): Boolean = workingDaysBetween(start, end) > 0

    /**
     * The working-day index of [date]: the Monday-Friday index minus the holidays on or before it. Monotone, consecutive across working
     * days and flat over weekends and holidays.
     */
    fun workingDayIndex(date: LocalDate): Long =
        monFriIndexOfEpochDay(date.toEpochDay()) - offDaysUpTo(date.toEpochDay())

    /** The inverse of [workingDayIndex]: the working day with the given [index] (always a working day, never a weekend or holiday). */
    fun workingDayOfIndex(index: Long): LocalDate {
        // The off-days before the answer are exactly those that collapse onto an index below [index].
        val before = countAtMost(adjustedOffIndex, index - 1)
        return monFriOfIndex(index + before)
    }

    /** [date] itself when it is a working day, else the first working day after it - a span's EFFECTIVE start. */
    fun nextWorkingDayOnOrAfter(date: LocalDate): LocalDate =
        if (isWorkingDay(date)) date else workingDayOfIndex(workingDayIndex(date) + 1)

    /** [date] itself when it is a working day, else the last working day before it - a span's EFFECTIVE end. */
    fun previousWorkingDayOnOrBefore(date: LocalDate): LocalDate = workingDayOfIndex(workingDayIndex(date))

    /**
     * The working day [days] working days after [date] (before it when negative). A non-working [date] counts as the working day before
     * it, so `plusWorkingDays(Saturday, 0)` is that Friday; snap with [nextWorkingDayOnOrAfter] first when the other reading is wanted.
     */
    fun plusWorkingDays(date: LocalDate, days: Long): LocalDate = workingDayOfIndex(workingDayIndex(date) + days)

    /**
     * The working days in the inclusive span [[start], [end]]: `W(end) - W(start)` plus the start itself when it is a working day;
     * 0 for an inverted span or one holding only weekend days and holidays.
     */
    fun workingDaysBetween(start: LocalDate, end: LocalDate): Long {
        if (end.isBefore(start)) return 0
        return workingDayIndex(end) - workingDayIndex(start) + if (isWorkingDay(start)) 1 else 0
    }

    /** How many off-days fall on or before [epochDay]. */
    private fun offDaysUpTo(epochDay: Long): Int = countAtMost(offDays, epochDay)

    companion object {
        /** The calendar without holidays: Monday to Friday, bit for bit the v0.4-v0.6 placeholder rule. */
        val MON_FRI = WorkingCalendar(emptyMap())

        private fun isWeekday(date: LocalDate): Boolean = date.dayOfWeek != DayOfWeek.SATURDAY && date.dayOfWeek != DayOfWeek.SUNDAY

        /** The number of entries of the ascending [sorted] that are `<= limit` (an upper-bound binary search). */
        private fun countAtMost(sorted: LongArray, limit: Long): Int {
            var low = 0
            var high = sorted.size
            while (low < high) {
                val mid = (low + high) ushr 1
                if (sorted[mid] <= limit) low = mid + 1 else high = mid
            }
            return low
        }

        /**
         * The Monday-Friday index of an epoch day: pure whole-week arithmetic, no loop, flat over a weekend (a Saturday and a Sunday share
         * the Friday before them). The week of an epoch day is `floorDiv(epochDay + 3, 7)` (a Monday-based week), its weekday
         * `floorMod(epochDay + 3, 7)`, clamped to Friday.
         */
        private fun monFriIndexOfEpochDay(epochDay: Long): Long {
            val shifted = epochDay + EPOCH_WEEKDAY_SHIFT
            return WORKING_DAYS_IN_WEEK * Math.floorDiv(shifted, WEEK_LENGTH_DAYS) +
                minOf(Math.floorMod(shifted, WEEK_LENGTH_DAYS), LAST_WEEKDAY_OF_WORK_WEEK) + 1
        }

        /** The inverse of [monFriIndexOfEpochDay]: the Monday-Friday date with the given index. */
        private fun monFriOfIndex(index: Long): LocalDate {
            val zeroBased = index - 1
            val week = Math.floorDiv(zeroBased, WORKING_DAYS_IN_WEEK)
            val weekday = Math.floorMod(zeroBased, WORKING_DAYS_IN_WEEK)
            return LocalDate.ofEpochDay(WEEK_LENGTH_DAYS * week - EPOCH_WEEKDAY_SHIFT + weekday)
        }
    }
}
