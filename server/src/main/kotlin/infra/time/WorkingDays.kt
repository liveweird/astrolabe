package ch.nokillswit.infra.time

import java.time.DayOfWeek
import java.time.LocalDate

/**
 * The v0.3 working-day rule: Monday to Friday, no holidays, no zones (the planning calendar is day-precision `DATE`s). Its one
 * consumer is the milestone schedule write ("a milestone must cover at least one working day"), which needs at most seven
 * iterations. **This is a placeholder, not a calendar:** v0.7 (calendar + critical path) replaces it with Flow's `WorkingCalendar` /
 * `WorkingDayIndex` port (public holidays, zone-aware day bounds, O(log) working-day counts — `product.md` "Port later"), and the
 * v0.5 load kernel will count working days through that port too.
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
