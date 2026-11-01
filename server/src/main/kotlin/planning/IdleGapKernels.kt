package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import kotlinx.serialization.Serializable
import java.time.LocalDate

/** The shortest idle run reported, in working days (the user's threshold, 2026-11-01: gaps of 3 or more). */
const val MIN_IDLE_GAP_DAYS = 3

/** An idle gap: the first and last WORKING day of a maximal uncovered run of [workingDays] (at least [MIN_IDLE_GAP_DAYS]) working days. */
data class IdleGap(val start: LocalDate, val end: LocalDate, val workingDays: Int)

/** [IdleGap] on the wire: ISO `YYYY-MM-DD` strings, both inclusive working days. */
@Serializable
data class IdleGapView(val start: String, val end: String, val workingDays: Int)

internal fun IdleGap.toView() = IdleGapView(start.toString(), end.toString(), workingDays)

/**
 * The idle gaps of [spans] inside their own derived span, on the wire: the team view's (the team's scheduled milestones) and the project
 * view's (the project's scheduled milestones) shared entry. The window is derived only from the spans that hold a working day: a
 * milestone dated on a single day that later became a holiday keeps its dates but is no work, so it opens no leading gap. Empty when
 * no span holds a working day.
 */
fun idleGapViewsOf(spans: Collection<DaySpan>, calendar: WorkingCalendar): List<IdleGapView> {
    val working = spans.filter { calendar.containsWorkingDay(it.start, it.end) }
    val within = SpanKernels.derivedSpan(working) ?: return emptyList()
    return idleGaps(working, within, calendar).map { it.toView() }
}

/**
 * The idle gaps of [spans] inside [within], as a pure kernel (no I/O, no clock; `planning-model.md` "Idle gaps"). Each span is reduced
 * to its EFFECTIVE working-day interval (the WIP rule of `LoadKernels.kt`: first working day on or after its start to the last on or
 * before its end; a span without a working day covers nothing), the intervals are merged, and every maximal run of UNCOVERED
 * working-day indices inside [within]'s own effective interval of at least [minWorkingDays] is a gap. Counted on the calendar's index, so
 * a weekend or a holiday neither counts nor breaks a run, and nothing before the first working day or after the last of [within] is
 * reported. A gap answers its first and last working day. O(n log n).
 */
fun idleGaps(
    spans: Collection<DaySpan>,
    within: DaySpan,
    calendar: WorkingCalendar,
    minWorkingDays: Int = MIN_IDLE_GAP_DAYS,
): List<IdleGap> {
    val low = calendar.workingDayIndex(calendar.nextWorkingDayOnOrAfter(within.start))
    // Half-open: one past the last working day on or before the end.
    val high = calendar.workingDayIndex(calendar.previousWorkingDayOnOrBefore(within.end)) + 1
    if (low >= high) return emptyList()
    val covered = spans
        .map { span ->
            val first = calendar.workingDayIndex(calendar.nextWorkingDayOnOrAfter(span.start))
            first to calendar.workingDayIndex(calendar.previousWorkingDayOnOrBefore(span.end))
        }
        .filter { (first, last) -> first <= last }
        .sortedBy { it.first }
    val gaps = mutableListOf<IdleGap>()
    var cursor = low
    fun close(untilExclusive: Long) {
        val length = untilExclusive - cursor
        if (length >= minWorkingDays) {
            gaps += IdleGap(calendar.workingDayOfIndex(cursor), calendar.workingDayOfIndex(untilExclusive - 1), length.toInt())
        }
    }
    for ((first, last) in covered) {
        if (first >= high) break
        close(minOf(first, high))
        cursor = maxOf(cursor, last + 1)
    }
    close(high)
    return gaps
}
