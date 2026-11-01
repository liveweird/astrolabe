package ch.nokillswit.infra.time

import java.time.DayOfWeek
import java.time.LocalDate

/**
 * The working-day rule: Monday to Friday, no holidays, no zones (the planning calendar is day-precision `DATE`s). Its consumers are the
 * milestone schedule write ("a milestone must cover at least one working day", at most seven iterations) and, since v0.4, the
 * dependency check's closed-form index below. **This is a placeholder, not a calendar:** v0.7 (calendar + critical path) replaces it
 * with Flow's `WorkingCalendar` / `WorkingDayIndex` port (public holidays, zone-aware day bounds, O(log) working-day counts —
 * `product.md` "Port later"), keeping the signatures of the index functions below and subtracting the holidays its binary search
 * finds; the v0.5 load kernel will count working days through that port too.
 */
fun isWorkingDay(date: LocalDate): Boolean = date.dayOfWeek != DayOfWeek.SATURDAY && date.dayOfWeek != DayOfWeek.SUNDAY

/** Whether the inclusive span [[start], [end]] holds at least one working day (false for an inverted span). */
fun containsWorkingDay(start: LocalDate, end: LocalDate): Boolean {
    var day = start
    var looked = 0
    // Any seven consecutive days hold five working days, so a longer span needs no further look.
    while (looked < DAYS_PER_WEEK && !day.isAfter(end)) {
        if (isWorkingDay(day)) return true
        day = day.plusDays(1)
        looked++
    }
    return false
}

private const val DAYS_PER_WEEK = 7

private const val WEEK_LENGTH_DAYS = 7L
private const val WORKING_DAYS_PER_WEEK = 5L
private const val LAST_WEEKDAY_OF_WORK_WEEK = 4L

// 1970-01-01 (epoch day 0) was a Thursday; with Monday = 0 the weekday of an epoch day is floorMod(epochDay + 3, 7).
private const val EPOCH_WEEKDAY_SHIFT = 3L

/**
 * The Monday-Friday working-day index of [date]: monotone, consecutive across a weekend (`index(Monday) - index(Friday) = 1`) and flat
 * over it (a Saturday and a Sunday share the index of the Friday before them), so a count of working days between two dates is the
 * difference of their indices. Pure whole-week arithmetic, no loop. The week of an epoch day is `floorDiv(epochDay + 3, 7)` (a
 * Monday-based week) and its weekday `floorMod(epochDay + 3, 7)`, clamped to Friday.
 */
fun workingDayIndex(date: LocalDate): Long {
    val shifted = date.toEpochDay() + EPOCH_WEEKDAY_SHIFT
    return WORKING_DAYS_PER_WEEK * Math.floorDiv(shifted, WEEK_LENGTH_DAYS) +
        minOf(Math.floorMod(shifted, WEEK_LENGTH_DAYS), LAST_WEEKDAY_OF_WORK_WEEK) + 1
}

/** The inverse of [workingDayIndex]: the working day (Monday-Friday) with the given [index]. */
fun workingDayOfIndex(index: Long): LocalDate {
    val zeroBased = index - 1
    val week = Math.floorDiv(zeroBased, WORKING_DAYS_PER_WEEK)
    val weekday = Math.floorMod(zeroBased, WORKING_DAYS_PER_WEEK)
    return LocalDate.ofEpochDay(WEEK_LENGTH_DAYS * week - EPOCH_WEEKDAY_SHIFT + weekday)
}

/** [date] itself when it is a working day, else the Monday after it — a span's EFFECTIVE start. */
fun nextWorkingDayOnOrAfter(date: LocalDate): LocalDate =
    if (isWorkingDay(date)) date else workingDayOfIndex(workingDayIndex(date) + 1)

/** [date] itself when it is a working day, else the Friday before it — a span's EFFECTIVE end. */
fun previousWorkingDayOnOrBefore(date: LocalDate): LocalDate = workingDayOfIndex(workingDayIndex(date))

/**
 * The working day [days] working days after [date] (before it when negative). A weekend [date] counts as the Friday before it, so
 * `plusWorkingDays(Saturday, 0)` is that Friday; snap with [nextWorkingDayOnOrAfter] first when the other reading is wanted.
 */
fun plusWorkingDays(date: LocalDate, days: Long): LocalDate = workingDayOfIndex(workingDayIndex(date) + days)
